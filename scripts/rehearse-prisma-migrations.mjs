import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const projectRoot = resolve(import.meta.dirname, "..");
const containerName = `tonhub-payments-migration-${process.pid}-${randomUUID().slice(0, 8)}`;
const postgresPassword = "tonhub-migration-rehearsal";
const baselineMigration = "20260813100000_baseline";
const migrationDirectories = readdirSync(resolve(projectRoot, "prisma", "migrations"), {
  withFileTypes: true,
}).filter((entry) => entry.isDirectory() && /^\d+_/.test(entry.name))
  .map((entry) => entry.name)
  .sort();
const expectedMigrationCount = migrationDirectories.length.toString();
const baselineMigrationSql = readFileSync(
  resolve(projectRoot, "prisma", "migrations", baselineMigration, "migration.sql"),
  "utf8",
);
const prismaCli = resolve(projectRoot, "node_modules", "prisma", "build", "index.js");
const tsxCli = resolve(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: options.input === undefined ? "pipe" : ["pipe", "pipe", "pipe"],
    input: options.input,
    env: options.env ?? process.env,
  });

  if (result.status !== 0) {
    const details = [result.error?.message, result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(`${command} ${args.join(" ")} failed${details ? `:\n${details}` : ""}`);
  }

  return result.stdout.trim();
}

function docker(...args) {
  return run("docker", args);
}

function psql(database, sql) {
  return docker(
    "exec",
    "-i",
    containerName,
    "psql",
    "--set",
    "ON_ERROR_STOP=1",
    "--username",
    "postgres",
    "--dbname",
    database,
    "--tuples-only",
    "--no-align",
    "--command",
    sql,
  );
}

function prisma(databaseUrl, ...args) {
  return run(process.execPath, [prismaCli, ...args], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

function waitForPostgres() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = spawnSync(
      "docker",
      ["exec", containerName, "pg_isready", "--username", "postgres"],
      { encoding: "utf8", stdio: "pipe" },
    );

    if (result.status === 0) {
      return;
    }

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
  }

  throw new Error("Temporary PostgreSQL did not become ready within 30 seconds");
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function normalizeSql(value) {
  return value.replace(/\r\n/g, "\n").trim();
}

let started = false;

try {
  docker("version", "--format", "{{.Server.Version}}");
  docker(
    "run",
    "--detach",
    "--name",
    containerName,
    "--env",
    `POSTGRES_PASSWORD=${postgresPassword}`,
    "--publish",
    "127.0.0.1::5432",
    "postgres:16-alpine",
  );
  started = true;
  waitForPostgres();

  const publishedPort = docker("port", containerName, "5432/tcp").split(":").at(-1);
  if (!publishedPort || !/^\d+$/.test(publishedPort)) {
    throw new Error(`Could not determine the temporary PostgreSQL port: ${publishedPort}`);
  }

  psql("postgres", 'CREATE DATABASE "clean_migration";');
  psql("postgres", 'CREATE DATABASE "legacy_migration";');
  psql("postgres", 'CREATE DATABASE "usdt_sweep_rollout";');

  const databaseUrl = (database) =>
    `postgresql://postgres:${postgresPassword}@127.0.0.1:${publishedPort}/${database}?schema=public`;

  const usdtSweepMigration = "20260813105000_usdt_sweep_state";
  const usdtSweepMigrationIndex = migrationDirectories.indexOf(usdtSweepMigration);
  if (usdtSweepMigrationIndex < 0) {
    throw new Error(`missing required USDT sweep rollout migration: ${usdtSweepMigration}`);
  }
  for (const migrationName of migrationDirectories.slice(0, usdtSweepMigrationIndex)) {
    psql(
      "usdt_sweep_rollout",
      readFileSync(resolve(projectRoot, "prisma", "migrations", migrationName, "migration.sql"), "utf8"),
    );
  }
  const rolloutMaster = "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe";
  const rolloutOwner = `0:${"a1".repeat(32)}`;
  const rolloutWallet = `0:${"a2".repeat(32)}`;
  psql(
    "usdt_sweep_rollout",
    `INSERT INTO "TonhubPaymentOrder" (
       "id", "fiatAmountMicros", "fiatCurrency", "updatedAt"
     ) VALUES ('rollout-order', '5000000', 'USD', CURRENT_TIMESTAMP);
     INSERT INTO "TonhubPaymentInvoice" (
       "id", "orderId", "network", "fiatAmountCents", "fiatAmountMicros", "fiatCurrency",
       "address", "addressRaw", "walletVersion", "walletWorkchain", "walletContext",
       "walletNetworkGlobalId", "walletPublicKeyHash", "amountNano", "amountAtomic",
       "reference", "updatedAt"
     ) VALUES (
       'rollout-invoice', 'rollout-order', 'mainnet', 500, '5000000', 'USD',
       '${rolloutOwner}', '${rolloutOwner}', 'v5r1', 0, 950001, -239, 'rollout-key',
       '5000000000', '5000000000', 'rollout-reference', CURRENT_TIMESTAMP
     );
     INSERT INTO "TonhubDepositAddress" (
       "id", "invoiceId", "network", "address", "addressRaw", "walletVersion",
       "walletWorkchain", "walletContext", "walletNetworkGlobalId", "walletPublicKeyHash",
       "updatedAt"
     ) VALUES (
       'rollout-deposit', 'rollout-invoice', 'mainnet', '${rolloutOwner}', '${rolloutOwner}',
       'v5r1', 0, 950001, -239, 'rollout-key', CURRENT_TIMESTAMP
     );
     INSERT INTO "TonhubDepositAssetAccount" (
       "id", "depositAddressId", "network", "asset", "assetKind", "assetDecimals",
       "jettonMasterAddress", "assetWalletAddress", "status", "updatedAt"
     ) VALUES (
       'rollout-account', 'rollout-deposit', 'mainnet', 'USDT', 'JETTON', 6,
       '${rolloutMaster}', '${rolloutWallet}', 'VERIFIED', CURRENT_TIMESTAMP
     );
     INSERT INTO "TonhubPaymentMovement" (
       "id", "fingerprint", "depositAddressId", "network", "direction", "asset",
       "assetKind", "assetDecimals", "amountAtomic", "toAddress", "ownerAddress",
       "jettonMasterAddress", "jettonWalletAddress", "transactionHash", "transactionLt",
       "blockchainAt", "rawPayload", "updatedAt"
     ) VALUES (
       'rollout-movement', 'rollout-usdt-movement', 'rollout-deposit', 'mainnet',
       'INCOMING', 'USDT', 'JETTON', 6, '5000000', '${rolloutOwner}', '${rolloutOwner}',
       '${rolloutMaster}', '${rolloutWallet}', '${"b1".repeat(64)}', '950001',
       CURRENT_TIMESTAMP, '{"officialUsdt":true,"evidenceVersion":1}', CURRENT_TIMESTAMP
     );`,
  );
  psql(
    "usdt_sweep_rollout",
    readFileSync(
      resolve(projectRoot, "prisma", "migrations", usdtSweepMigration, "migration.sql"),
      "utf8",
    ),
  );
  assertEqual(
    psql(
      "usdt_sweep_rollout",
      `SELECT COUNT(*) FROM "TonhubAssetSweep"
       WHERE "depositAddressId" = 'rollout-deposit' AND "status" = 'QUEUED'
         AND "idempotencyKey" = 'official-usdt-movement:rollout-movement';`,
    ),
    "1",
    "pre-step-13 official USDT movement sweep backfill",
  );

  const legacyFixtureSql = prisma(
    databaseUrl("legacy_migration"),
    "migrate",
    "diff",
    "--from-empty",
    "--to-schema-datamodel",
    "tests/fixtures/gram-only-schema.prisma",
    "--script",
  );
  assertEqual(
    normalizeSql(baselineMigrationSql),
    normalizeSql(legacyFixtureSql),
    "baseline migration versus independent GRAM-only datamodel",
  );

  prisma(databaseUrl("clean_migration"), "migrate", "deploy");
  prisma(databaseUrl("clean_migration"), "migrate", "deploy");
  prisma(databaseUrl("clean_migration"), "migrate", "status");
  prisma(databaseUrl("clean_migration"), "generate", "--schema", "prisma/schema.prisma");
  run(process.execPath, [tsxCli, "scripts/verify-order-attempt-repository.ts"], {
    env: { ...process.env, DATABASE_URL: databaseUrl("clean_migration") },
  });
  run(process.execPath, [tsxCli, "scripts/verify-rate-snapshot-repository.ts"], {
    env: { ...process.env, DATABASE_URL: databaseUrl("clean_migration") },
  });
  run(process.execPath, [tsxCli, "scripts/verify-movement-ledger.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl("clean_migration"),
      TONHUB_LEDGER_VERIFY_SUFFIX: "clean",
    },
  });
  run(process.execPath, [tsxCli, "scripts/verify-mainnet-usdt-sweep.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl("clean_migration"),
      TONHUB_USDT_SWEEP_VERIFY_SUFFIX: "clean",
    },
  });
  run(process.execPath, [tsxCli, "scripts/verify-gram-shadow-scanner.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl("clean_migration"),
      TONHUB_GRAM_SHADOW_VERIFY_SUFFIX: "clean",
    },
  });
  run(process.execPath, [tsxCli, "scripts/verify-gram-ledger-cutover.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl("clean_migration"),
      TONHUB_GRAM_CUTOVER_VERIFY_SUFFIX: "clean",
    },
  });
  run(process.execPath, [tsxCli, "scripts/verify-admin-repository.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl("clean_migration"),
      TONHUB_ADMIN_VERIFY_SUFFIX: "clean",
    },
  });
  run(process.execPath, [tsxCli, "scripts/verify-webhook-outbox.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl("clean_migration"),
      TONHUB_WEBHOOK_VERIFY_SUFFIX: "clean",
    },
  });
  run(process.execPath, [tsxCli, "scripts/verify-mainnet-usdt-canary.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl("clean_migration"),
      TONHUB_CANARY_VERIFY_SUFFIX: "clean",
    },
  });
  run(process.execPath, [tsxCli, "scripts/verify-ton-checkout-policy-foundation.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl("clean_migration"),
      TONHUB_CHECKOUT_POLICY_VERIFY_SUFFIX: "clean",
    },
  });
  run(process.execPath, [tsxCli, "scripts/verify-ton-checkout-issuance.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl("clean_migration"),
      TONHUB_CHECKOUT_ISSUANCE_VERIFY_SUFFIX: "clean",
    },
  });
  prisma(
    databaseUrl("clean_migration"),
    "migrate",
    "diff",
    "--from-url",
    databaseUrl("clean_migration"),
    "--to-schema-datamodel",
    "prisma/schema.prisma",
    "--exit-code",
  );
  assertEqual(
    psql(
      "clean_migration",
      `SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;`,
    ),
    expectedMigrationCount,
    "clean migration count",
  );

  run("docker", [
    "exec",
    "-i",
    containerName,
    "psql",
    "--set",
    "ON_ERROR_STOP=1",
    "--username",
    "postgres",
    "--dbname",
    "legacy_migration",
  ], { input: legacyFixtureSql });
  psql(
    "legacy_migration",
    `INSERT INTO "TonhubPaymentInvoice" (
      "id", "externalId", "network", "fiatAmountCents", "address", "addressRaw",
      "walletVersion", "walletWorkchain", "walletContext", "walletNetworkGlobalId",
      "walletPublicKeyHash", "amountNano", "paidNano", "reference", "status",
      "observedAt", "partialPaymentStartedAt", "partialPaymentExpiresAt", "expiresAt", "updatedAt"
    ) VALUES
      (
        'legacy-invoice-1', 'legacy-order-1', 'testnet', 1250, 'legacy-address',
        '0:legacy-address', 'v5r1', 0, 1, -3, 'legacy-key-hash', '1000000000', '0',
        'legacy-reference-1', 'PENDING', NULL, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      ),
      (
        'legacy-partial', 'legacy-order-partial', 'testnet', 500, 'legacy-partial-address',
        '0:legacy-partial-address', 'v5r1', 0, 11, -3, 'legacy-partial-key', '2000000000', '500000000',
        'legacy-reference-partial', 'PARTIAL', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP + INTERVAL '24 hours', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      ),
      (
        'legacy-paid', 'legacy-order-paid', 'testnet', 700, 'legacy-paid-address',
        '0:legacy-paid-address', 'v5r1', 0, 12, -3, 'legacy-paid-key', '1000000000', '1000000000',
        'legacy-reference-paid', 'PAID', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP + INTERVAL '24 hours', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      ),
      (
        'legacy-expired-funded', 'legacy-order-expired-funded', 'testnet', 900,
        'legacy-expired-funded-address', '0:legacy-expired-funded-address', 'v5r1', 0, 13, -3,
        'legacy-expired-funded-key', '3000000000', '1000000000', 'legacy-reference-expired-funded',
        'EXPIRED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      ),
      (
        'legacy-anonymous', NULL, 'testnet', 100, 'legacy-anonymous-address',
        '0:legacy-anonymous-address', 'v5r1', 0, 14, -3, 'legacy-anonymous-key', '400000000', '0',
        'legacy-reference-anonymous', 'PENDING', NULL, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );`,
  );

  prisma(
    databaseUrl("legacy_migration"),
    "migrate",
    "resolve",
    "--applied",
    baselineMigration,
  );
  prisma(databaseUrl("legacy_migration"), "migrate", "deploy");
  prisma(databaseUrl("legacy_migration"), "migrate", "status");
  run(process.execPath, [tsxCli, "scripts/verify-rate-snapshot-repository.ts"], {
    env: { ...process.env, DATABASE_URL: databaseUrl("legacy_migration") },
  });
  run(process.execPath, [tsxCli, "scripts/verify-movement-ledger.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl("legacy_migration"),
      TONHUB_LEDGER_VERIFY_SUFFIX: "legacy",
    },
  });
  run(process.execPath, [tsxCli, "scripts/verify-mainnet-usdt-sweep.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl("legacy_migration"),
      TONHUB_USDT_SWEEP_VERIFY_SUFFIX: "legacy",
    },
  });
  run(process.execPath, [tsxCli, "scripts/verify-gram-shadow-scanner.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl("legacy_migration"),
      TONHUB_GRAM_SHADOW_VERIFY_SUFFIX: "legacy",
    },
  });
  run(process.execPath, [tsxCli, "scripts/verify-gram-ledger-cutover.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl("legacy_migration"),
      TONHUB_GRAM_CUTOVER_VERIFY_SUFFIX: "legacy",
    },
  });
  run(process.execPath, [tsxCli, "scripts/verify-admin-repository.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl("legacy_migration"),
      TONHUB_ADMIN_VERIFY_SUFFIX: "legacy",
    },
  });
  run(process.execPath, [tsxCli, "scripts/verify-webhook-outbox.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl("legacy_migration"),
      TONHUB_WEBHOOK_VERIFY_SUFFIX: "legacy",
    },
  });
  run(process.execPath, [tsxCli, "scripts/verify-mainnet-usdt-canary.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl("legacy_migration"),
      TONHUB_CANARY_VERIFY_SUFFIX: "legacy",
    },
  });
  run(process.execPath, [tsxCli, "scripts/verify-ton-checkout-policy-foundation.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl("legacy_migration"),
      TONHUB_CHECKOUT_POLICY_VERIFY_SUFFIX: "legacy",
    },
  });
  run(process.execPath, [tsxCli, "scripts/verify-ton-checkout-issuance.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl("legacy_migration"),
      TONHUB_CHECKOUT_ISSUANCE_VERIFY_SUFFIX: "legacy",
    },
  });

  assertEqual(
    psql(
      "legacy_migration",
      `SELECT "checkoutAsset" || ':' || "assetKind" || ':' || "assetDecimals" || ':' || "creditedFiatMicros"
       FROM "TonhubPaymentInvoice" WHERE "id" = 'legacy-invoice-1';`,
    ),
    "GRAM:NATIVE:9:0",
    "legacy invoice defaults",
  );
  assertEqual(
    psql("legacy_migration", `SELECT to_regclass('public."TonhubPaymentMovement"') IS NOT NULL;`),
    "t",
    "multi-asset movement table",
  );
  assertEqual(
    psql(
      "legacy_migration",
      `SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;`,
    ),
    expectedMigrationCount,
    "legacy migration count",
  );
  assertEqual(
    psql(
      "legacy_migration",
      `SELECT COUNT(*) FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = 'TonhubPaymentInvoice_one_active_attempt_per_order_key'
         AND indexdef LIKE '%WHERE (("orderId" IS NOT NULL) AND (status = ANY%';`,
    ),
    "1",
    "one-active-attempt partial unique index",
  );
  assertEqual(
    psql(
      "legacy_migration",
      `SELECT invoice."orderId" || ':' || payment_order."externalId" || ':' ||
              payment_order."fiatAmountMicros" || ':' || payment_order."status"
       FROM "TonhubPaymentInvoice" invoice
       JOIN "TonhubPaymentOrder" payment_order ON payment_order."id" = invoice."orderId"
       WHERE invoice."id" = 'legacy-invoice-1';`,
    ),
    "legacy-order:legacy-invoice-1:legacy-order-1:12500000:PENDING",
    "legacy invoice order backfill",
  );
  assertEqual(
    psql(
      "legacy_migration",
      `SELECT string_agg(
         invoice."id" || ':' || payment_order."status" || ':' ||
         payment_order."creditedFiatMicros" || ':' || invoice."remainingFiatMicros" || ':' ||
         invoice."amountAtomic" || ':' || invoice."paidAmountAtomic" || ':' ||
         (invoice."firstMovementAt" IS NOT NULL),
         ',' ORDER BY invoice."id"
       )
       FROM "TonhubPaymentInvoice" invoice
       JOIN "TonhubPaymentOrder" payment_order ON payment_order."id" = invoice."orderId"
       WHERE invoice."id" IN (
         'legacy-anonymous', 'legacy-expired-funded', 'legacy-paid', 'legacy-partial'
       );`,
    ),
    [
      "legacy-anonymous:PENDING:0:1000000:400000000:0:false",
      "legacy-expired-funded:RECOVERY:3000000:6000000:3000000000:1000000000:true",
      "legacy-paid:PAID:7000000:0:1000000000:1000000000:true",
      "legacy-partial:PARTIAL:1250000:3750000:2000000000:500000000:true",
    ].join(","),
    "legacy status and neutral amount backfill",
  );
  assertEqual(
    psql(
      "legacy_migration",
      `SELECT payment_order."externalId" IS NULL
       FROM "TonhubPaymentInvoice" invoice
       JOIN "TonhubPaymentOrder" payment_order ON payment_order."id" = invoice."orderId"
       WHERE invoice."id" = 'legacy-anonymous';`,
    ),
    "t",
    "anonymous legacy order",
  );

  psql(
    "legacy_migration",
    `DO $$
     BEGIN
       INSERT INTO "TonhubPaymentInvoice" (
         "id", "orderId", "network", "fiatAmountCents", "address", "addressRaw",
         "walletVersion", "walletWorkchain", "walletContext", "walletNetworkGlobalId",
         "walletPublicKeyHash", "amountNano", "reference", "updatedAt"
       ) VALUES (
         'blocked-active-attempt', 'legacy-order:legacy-invoice-1', 'testnet', 1250, 'blocked-address',
         '0:blocked-address', 'v5r1', 0, 2, -3, 'blocked-key-hash', '1000000000',
         'blocked-reference', CURRENT_TIMESTAMP
       );
       RAISE EXCEPTION 'second active attempt was accepted';
     EXCEPTION WHEN unique_violation THEN
       NULL;
     END $$;
     UPDATE "TonhubPaymentInvoice" SET "status" = 'EXPIRED' WHERE "id" = 'legacy-invoice-1';
     INSERT INTO "TonhubPaymentInvoice" (
       "id", "orderId", "network", "fiatAmountCents", "address", "addressRaw",
       "walletVersion", "walletWorkchain", "walletContext", "walletNetworkGlobalId",
       "walletPublicKeyHash", "amountNano", "reference", "updatedAt"
     ) VALUES (
       'replacement-attempt', 'legacy-order:legacy-invoice-1', 'testnet', 1250, 'replacement-address',
       '0:replacement-address', 'v5r1', 0, 3, -3, 'replacement-key-hash', '1000000000',
       'replacement-reference', CURRENT_TIMESTAMP
     );`,
  );
  assertEqual(
    psql(
      "legacy_migration",
      `SELECT COUNT(*) FROM "TonhubPaymentInvoice"
       WHERE "orderId" = 'legacy-order:legacy-invoice-1' AND "status" IN ('PENDING', 'PARTIAL');`,
    ),
    "1",
    "one active attempt behavior with terminal replacement",
  );

  psql(
    "legacy_migration",
    `INSERT INTO "TonhubDepositAddress" (
       "id", "invoiceId", "network", "address", "addressRaw", "walletVersion", "walletWorkchain",
       "walletContext", "walletNetworkGlobalId", "walletPublicKeyHash", "updatedAt"
     ) VALUES (
       'deposit-1', 'replacement-attempt', 'testnet', 'deposit-address', '0:deposit-address', 'v5r1', 0,
       4, -3, 'deposit-key-hash', CURRENT_TIMESTAMP
     );
     INSERT INTO "TonhubAssetSweep" (
       "id", "idempotencyKey", "depositAddressId", "asset", "assetKind", "updatedAt"
     ) VALUES ('sweep-1', 'sweep-key-1', 'deposit-1', 'USDT', 'JETTON', CURRENT_TIMESTAMP);
     DO $$
     BEGIN
       INSERT INTO "TonhubAssetSweep" (
         "id", "idempotencyKey", "depositAddressId", "asset", "assetKind", "updatedAt"
       ) VALUES ('blocked-sweep', 'sweep-key-2', 'deposit-1', 'USDT', 'JETTON', CURRENT_TIMESTAMP);
       RAISE EXCEPTION 'second active sweep was accepted';
     EXCEPTION WHEN unique_violation THEN
       NULL;
     END $$;
     UPDATE "TonhubAssetSweep"
       SET "status" = 'CONFIRMED', "transactionHash" = 'sweep-tx-1',
           "gasTopupTransactionHash" = 'gas-topup-tx-1',
           "amountAtomic" = '1', "reserveAtomic" = '0',
           "recipientAddress" = '0:fixture-recipient', "seqno" = 1, "queryId" = '1',
           "sentAt" = CURRENT_TIMESTAMP, "confirmedAt" = CURRENT_TIMESTAMP
       WHERE "id" = 'sweep-1';
     INSERT INTO "TonhubAssetSweep" (
       "id", "idempotencyKey", "depositAddressId", "asset", "assetKind", "updatedAt"
     ) VALUES ('sweep-2', 'sweep-key-2', 'deposit-1', 'USDT', 'JETTON', CURRENT_TIMESTAMP);
     UPDATE "TonhubAssetSweep" SET "status" = 'FAILED' WHERE "id" = 'sweep-2';
     DO $$
     BEGIN
       INSERT INTO "TonhubAssetSweep" (
         "id", "idempotencyKey", "depositAddressId", "asset", "assetKind", "updatedAt"
       ) VALUES ('blocked-failed-sweep', 'sweep-key-3', 'deposit-1', 'USDT', 'JETTON', CURRENT_TIMESTAMP);
       RAISE EXCEPTION 'a retryable failed sweep did not retain its uniqueness lease';
     EXCEPTION WHEN unique_violation THEN
       NULL;
     END $$;
     UPDATE "TonhubAssetSweep" SET "status" = 'QUEUED' WHERE "id" = 'sweep-2';
     DO $$
     BEGIN
       UPDATE "TonhubAssetSweep" SET "transactionHash" = 'sweep-tx-1' WHERE "id" = 'sweep-2';
       RAISE EXCEPTION 'duplicate sweep transaction hash was accepted';
     EXCEPTION WHEN unique_violation THEN
       NULL;
     END $$;
     DO $$
     BEGIN
       UPDATE "TonhubAssetSweep" SET "gasTopupTransactionHash" = 'gas-topup-tx-1' WHERE "id" = 'sweep-2';
       RAISE EXCEPTION 'duplicate gas top-up transaction hash was accepted';
     EXCEPTION WHEN unique_violation THEN
       NULL;
     END $$;
     INSERT INTO "TonhubDepositAddress" (
       "id", "network", "address", "addressRaw", "walletVersion", "walletWorkchain",
       "walletContext", "walletNetworkGlobalId", "walletPublicKeyHash", "updatedAt"
     ) VALUES (
       'deposit-2', 'testnet', 'deposit-address-2', '0:deposit-address-2', 'v5r1', 0,
       5, -3, 'deposit-key-hash-2', CURRENT_TIMESTAMP
     );
     DO $$
     BEGIN
       INSERT INTO "TonhubAssetSweep" (
         "id", "idempotencyKey", "depositAddressId", "asset", "assetKind", "updatedAt"
       ) VALUES ('blocked-idempotency', 'sweep-key-2', 'deposit-2', 'GRAM', 'NATIVE', CURRENT_TIMESTAMP);
       RAISE EXCEPTION 'duplicate sweep idempotency key was accepted';
     EXCEPTION WHEN unique_violation THEN
       NULL;
     END $$;`,
  );
  assertEqual(
    psql(
      "legacy_migration",
      `SELECT COUNT(*) FROM "TonhubAssetSweep"
       WHERE "depositAddressId" = 'deposit-1' AND "asset" = 'USDT'
         AND "status" IN ('QUEUED', 'GAS_CHECK', 'GAS_TOPUP_REQUIRED', 'GAS_TOPUP_SENT', 'READY', 'SENT', 'FAILED');`,
    ),
    "1",
    "one active sweep behavior with confirmed replacement",
  );

  psql(
    "legacy_migration",
    `INSERT INTO "TonhubRateSnapshot" (
       "id", "asset", "baseCurrency", "quoteCurrency", "price", "source", "observedAt", "fetchedAt"
     ) VALUES (
       'rate-1', 'GRAM', 'GRAM', 'EUR', 2.5, 'coingecko', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
     );
     INSERT INTO "TonhubPaymentMovement" (
       "id", "fingerprint", "depositAddressId", "network", "direction", "asset", "assetKind",
       "assetDecimals", "amountAtomic", "toAddress", "transactionHash", "blockchainAt", "rawPayload", "updatedAt"
     ) VALUES (
       'movement-1', 'testnet:tx-1:in:0', 'deposit-1', 'testnet', 'INCOMING', 'GRAM', 'NATIVE',
       9, '1000000000', 'deposit-address', 'tx-1', CURRENT_TIMESTAMP, '{"source":"fixture"}', CURRENT_TIMESTAMP
     );
     INSERT INTO "TonhubPaymentMovement" (
       "id", "fingerprint", "depositAddressId", "network", "direction", "asset", "assetKind",
       "assetDecimals", "amountAtomic", "toAddress", "transactionHash", "blockchainAt", "updatedAt"
     ) VALUES
       ('movement-rate-pending', 'testnet:tx-2:in:0', 'deposit-1', 'testnet', 'INCOMING', 'GRAM', 'NATIVE',
        9, '1', 'deposit-address', 'tx-2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
       ('movement-recovery', 'testnet:tx-3:in:0', 'deposit-1', 'testnet', 'INCOMING', 'GRAM', 'NATIVE',
        9, '2', 'deposit-address', 'tx-3', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
       ('movement-missing-credit-evidence', 'testnet:tx-4:in:0', 'deposit-1', 'testnet', 'INCOMING', 'GRAM', 'NATIVE',
        9, '3', 'deposit-address', 'tx-4', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
       ('movement-missing-reject-evidence', 'testnet:tx-5:in:0', 'deposit-1', 'testnet', 'INCOMING', 'GRAM', 'NATIVE',
        9, '4', 'deposit-address', 'tx-5', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
     UPDATE "TonhubPaymentMovement"
       SET "status" = 'RATE_PENDING'
       WHERE "id" = 'movement-rate-pending';
     UPDATE "TonhubPaymentMovement"
       SET "status" = 'HELD_UNDER_MINIMUM'
       WHERE "id" = 'movement-rate-pending';
     UPDATE "TonhubPaymentMovement"
       SET "status" = 'RECOVERY'
       WHERE "id" = 'movement-recovery';
     UPDATE "TonhubPaymentMovement"
       SET "status" = 'VALIDATED', "validationCode" = 'RECOVERED_VALID'
       WHERE "id" = 'movement-recovery';
     DO $$
     BEGIN
       UPDATE "TonhubPaymentMovement" SET "status" = 'CREDITED'
       WHERE "id" = 'movement-missing-credit-evidence';
       RAISE EXCEPTION 'CREDITED without evidence was accepted';
     EXCEPTION WHEN check_violation THEN
       NULL;
     END $$;
     DO $$
     BEGIN
       UPDATE "TonhubPaymentMovement" SET "status" = 'REJECTED'
       WHERE "id" = 'movement-missing-reject-evidence';
       RAISE EXCEPTION 'REJECTED without validation evidence was accepted';
     EXCEPTION WHEN check_violation THEN
       NULL;
     END $$;
     UPDATE "TonhubPaymentMovement"
       SET "status" = 'VALIDATED', "validationCode" = 'VALID'
       WHERE "id" = 'movement-1';
     DO $$
     BEGIN
       UPDATE "TonhubPaymentMovement" SET "status" = 'OBSERVED' WHERE "id" = 'movement-1';
       RAISE EXCEPTION 'movement lifecycle regressed';
     EXCEPTION WHEN SQLSTATE '55000' THEN
       NULL;
     END $$;
     DO $$
     BEGIN
       UPDATE "TonhubPaymentMovement" SET "validationCode" = 'REPLACED' WHERE "id" = 'movement-1';
       RAISE EXCEPTION 'movement validation evidence was replaced';
     EXCEPTION WHEN SQLSTATE '55000' THEN
       NULL;
     END $$;
     UPDATE "TonhubPaymentMovement"
       SET "status" = 'CREDITED', "rateSnapshotId" = 'rate-1', "fiatCreditMicros" = '2500000'
       WHERE "id" = 'movement-1';
     INSERT INTO "TonhubPaymentOrder" (
       "id", "externalId", "fiatAmountMicros", "fiatCurrency", "updatedAt"
     ) VALUES ('order-2', 'order-2', '12500000', 'EUR', CURRENT_TIMESTAMP);
     INSERT INTO "TonhubMovementAllocation" (
       "id", "movementId", "orderId", "invoiceId", "kind", "fiatCreditMicros"
     ) VALUES ('allocation-1', 'movement-1', 'legacy-order:legacy-invoice-1', 'replacement-attempt', 'CREDIT', '2500000');
     DO $$
     BEGIN
       INSERT INTO "TonhubMovementAllocation" (
         "id", "movementId", "orderId", "invoiceId", "kind", "reversesAllocationId", "fiatCreditMicros"
       ) VALUES (
         'allocation-self', 'movement-1', 'legacy-order:legacy-invoice-1', 'replacement-attempt', 'REVERSAL',
         'allocation-self', '2500000'
       );
       RAISE EXCEPTION 'self reversal was accepted';
     EXCEPTION WHEN check_violation THEN
       NULL;
     END $$;
     DO $$
     BEGIN
       INSERT INTO "TonhubMovementAllocation" (
         "id", "movementId", "orderId", "invoiceId", "kind", "reversesAllocationId", "fiatCreditMicros"
       ) VALUES (
         'allocation-wrong-amount', 'movement-1', 'legacy-order:legacy-invoice-1', 'replacement-attempt', 'REVERSAL',
         'allocation-1', '1'
       );
       RAISE EXCEPTION 'non-mirroring reversal amount was accepted';
     EXCEPTION WHEN check_violation THEN
       NULL;
     END $$;
     DO $$
     BEGIN
       INSERT INTO "TonhubMovementAllocation" (
         "id", "movementId", "orderId", "invoiceId", "kind", "reversesAllocationId", "fiatCreditMicros"
       ) VALUES (
         'allocation-wrong-owner', 'movement-1', 'order-2', NULL, 'REVERSAL',
         'allocation-1', '2500000'
       );
       RAISE EXCEPTION 'cross-ledger reversal was accepted';
     EXCEPTION WHEN check_violation THEN
       NULL;
     END $$;
     INSERT INTO "TonhubMovementAllocation" (
       "id", "movementId", "orderId", "invoiceId", "kind", "reversesAllocationId", "fiatCreditMicros", "note"
     ) VALUES (
       'allocation-reversal-1', 'movement-1', 'legacy-order:legacy-invoice-1', 'replacement-attempt', 'REVERSAL',
       'allocation-1', '2500000', 'rehearsal correction'
     );
     DO $$
     BEGIN
       INSERT INTO "TonhubMovementAllocation" (
         "id", "movementId", "orderId", "invoiceId", "kind", "reversesAllocationId", "fiatCreditMicros"
       ) VALUES (
         'allocation-reversal-of-reversal', 'movement-1', 'legacy-order:legacy-invoice-1', 'replacement-attempt', 'REVERSAL',
         'allocation-reversal-1', '2500000'
       );
       RAISE EXCEPTION 'reversal of a reversal was accepted';
     EXCEPTION WHEN check_violation THEN
       NULL;
     END $$;
     DO $$
     BEGIN
       UPDATE "TonhubPaymentMovement" SET "amountAtomic" = '2' WHERE "id" = 'movement-1';
       RAISE EXCEPTION 'movement facts were mutable';
     EXCEPTION WHEN SQLSTATE '55000' THEN
       NULL;
     END $$;
     DO $$
     BEGIN
       DELETE FROM "TonhubPaymentMovement" WHERE "id" = 'movement-1';
       RAISE EXCEPTION 'movement was deletable';
     EXCEPTION WHEN SQLSTATE '55000' THEN
       NULL;
     END $$;
     DO $$
     BEGIN
       UPDATE "TonhubMovementAllocation" SET "fiatCreditMicros" = '1' WHERE "id" = 'allocation-1';
       RAISE EXCEPTION 'allocation was mutable';
     EXCEPTION WHEN SQLSTATE '55000' THEN
       NULL;
     END $$;
     DO $$
     BEGIN
       DELETE FROM "TonhubMovementAllocation" WHERE "id" = 'allocation-reversal-1';
       RAISE EXCEPTION 'allocation was deletable';
     EXCEPTION WHEN SQLSTATE '55000' THEN
       NULL;
     END $$;
     DO $$
     BEGIN
       UPDATE "TonhubRateSnapshot" SET "price" = 3 WHERE "id" = 'rate-1';
       RAISE EXCEPTION 'rate snapshot was mutable';
     EXCEPTION WHEN SQLSTATE '55000' THEN
       NULL;
     END $$;
     DO $$
     BEGIN
       DELETE FROM "TonhubRateSnapshot" WHERE "id" = 'rate-1';
       RAISE EXCEPTION 'rate snapshot was deletable';
     EXCEPTION WHEN SQLSTATE '55000' THEN
       NULL;
     END $$;
     INSERT INTO "TonhubAdminAuditEvent" (
       "id", "adminUsername", "action", "targetType", "targetId"
     ) VALUES ('audit-1', 'rehearsal-admin', 'VERIFY', 'movement', 'movement-1');
     DO $$
     BEGIN
       UPDATE "TonhubAdminAuditEvent" SET "action" = 'REWRITTEN' WHERE "id" = 'audit-1';
       RAISE EXCEPTION 'admin audit event was mutable';
     EXCEPTION WHEN SQLSTATE '55000' THEN
       NULL;
     END $$;
     DO $$
     BEGIN
       TRUNCATE TABLE "TonhubPaymentMovement" CASCADE;
       RAISE EXCEPTION 'movement ledger was truncatable';
     EXCEPTION WHEN SQLSTATE '55000' THEN
       NULL;
     END $$;
     DO $$
     BEGIN
       TRUNCATE TABLE "TonhubMovementAllocation" CASCADE;
       RAISE EXCEPTION 'allocation ledger was truncatable';
     EXCEPTION WHEN SQLSTATE '55000' THEN
       NULL;
     END $$;
     DO $$
     BEGIN
       TRUNCATE TABLE "TonhubRateSnapshot" CASCADE;
       RAISE EXCEPTION 'rate evidence was truncatable';
     EXCEPTION WHEN SQLSTATE '55000' THEN
       NULL;
     END $$;
     DO $$
     BEGIN
       TRUNCATE TABLE "TonhubAdminAuditEvent";
       RAISE EXCEPTION 'admin audit was truncatable';
     EXCEPTION WHEN SQLSTATE '55000' THEN
       NULL;
     END $$;`,
  );
  assertEqual(
    psql(
      "legacy_migration",
      `SELECT "amountAtomic" || ':' || "status" || ':' || COUNT(*) OVER ()
       FROM "TonhubPaymentMovement" WHERE "id" = 'movement-1';`,
    ),
    "1000000000:CREDITED:1",
    "immutable movement facts",
  );
  assertEqual(
    psql(
      "legacy_migration",
      `SELECT COUNT(*) FROM "TonhubMovementAllocation" WHERE "movementId" = 'movement-1';`,
    ),
    "2",
    "append-only allocation and compensating reversal",
  );

  process.stdout.write("Migration rehearsal passed for clean and legacy databases.\n");
} finally {
  if (started) {
    const inspectedName = docker("inspect", "--format", "{{.Name}}", containerName);
    if (inspectedName !== `/${containerName}`) {
      throw new Error(`Refusing to remove unexpected container ${inspectedName}`);
    }
    docker("rm", "--force", containerName);
  }
}
