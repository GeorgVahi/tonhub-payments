import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import { Address } from "@ton/core";
import {
  scanGramShadowTransactions,
  type GramShadowRejectionCode,
} from "../backend/src/ton/gram-shadow-scanner";
import type { TonCenterTransaction } from "../backend/src/ton/direct-payments";
import {
  createPrismaGramShadowScannerRepository,
  runGramShadowScanBatch,
  type GramShadowScanTarget,
  type GramShadowScannerRepository,
} from "../worker/src/gram-shadow";

const destinationRaw = `0:${"11".repeat(32)}`;
const sourceRaw = `0:${"22".repeat(32)}`;
const wrongDestinationRaw = `0:${"33".repeat(32)}`;
const destinationFriendly = Address.parse(destinationRaw).toString({
  bounceable: true,
  testOnly: true,
});
const sourceFriendly = Address.parse(sourceRaw).toString({
  bounceable: false,
  testOnly: true,
});
const hashHex = "ab".repeat(32);
const hashBase64Url = Buffer.from(hashHex, "hex").toString("base64url");
const scanStart = new Date("2026-08-13T10:00:00.000Z");
const scanNow = new Date("2026-08-13T10:30:00.000Z");

function transaction(overrides: Partial<TonCenterTransaction> = {}): TonCenterTransaction {
  return {
    hash: hashHex,
    lt: "900001",
    now: Math.floor(new Date("2026-08-13T10:10:00.000Z").getTime() / 1000),
    description: { aborted: false, action: { success: true } },
    in_msg: {
      source: sourceFriendly,
      destination: destinationFriendly,
      value: "1500000000",
      message_content: { decoded: { text: "ignored comment" } },
    },
    ...overrides,
  };
}

function scan(transactions: TonCenterTransaction[]) {
  return scanGramShadowTransactions({
    network: "testnet",
    depositAddressId: "deposit-1",
    address: destinationFriendly,
    addressRaw: destinationRaw,
    notBefore: scanStart,
    notAfter: scanNow,
    transactions,
  });
}

test("GRAM shadow parser emits stable native movement evidence across TON address/hash encodings", () => {
  const first = scan([transaction()]);
  const encoded = scan([transaction({
    hash: hashBase64Url,
    in_msg: {
      source: sourceRaw,
      destination: destinationRaw,
      value: "1500000000",
      message_content: { decoded: { text: "another irrelevant comment" } },
    },
  })]);

  assert.equal(first.rejections.length, 0);
  assert.equal(first.movements.length, 1);
  assert.deepEqual(encoded.movements, first.movements);
  assert.deepEqual(first.movements[0], {
    fingerprint: `ton:testnet:native-in:${hashHex}:0`,
    depositAddressId: "deposit-1",
    network: "testnet",
    direction: "INCOMING",
    asset: "GRAM",
    assetKind: "NATIVE",
    assetDecimals: 9,
    amountAtomic: "1500000000",
    fromAddress: sourceRaw,
    toAddress: destinationRaw,
    transactionHash: hashHex,
    transactionLt: "900001",
    blockchainAt: new Date("2026-08-13T10:10:00.000Z"),
    rawPayload: {
      evidenceVersion: 1,
      provider: "toncenter-v3",
      transaction: {
        hash: hashHex,
        lt: "900001",
        now: 1786615800,
        successful: true,
        source: sourceRaw,
        destination: destinationRaw,
        value: "1500000000",
      },
    },
  });
});

test("GRAM shadow parser rejects unsuccessful, malformed, foreign, non-positive, and out-of-window evidence", () => {
  const cases: Array<{ expected: GramShadowRejectionCode; value: TonCenterTransaction }> = [
    { expected: "TRANSACTION_ID_INVALID", value: transaction({ hash: "not-a-hash" }) },
    { expected: "TRANSACTION_ID_INVALID", value: transaction({ lt: "bad-lt" }) },
    { expected: "TRANSACTION_TIME_INVALID", value: transaction({ now: 0 }) },
    {
      expected: "TRANSACTION_OUTSIDE_WINDOW",
      value: transaction({ now: Math.floor(scanStart.getTime() / 1000) - 1 }),
    },
    { expected: "TRANSACTION_NOT_SUCCESSFUL", value: transaction({ description: { aborted: true } }) },
    { expected: "TRANSACTION_NOT_SUCCESSFUL", value: transaction({ description: { aborted: false } }) },
    {
      expected: "TRANSACTION_NOT_SUCCESSFUL",
      value: transaction({ description: { aborted: false, action: { success: false } } }),
    },
    { expected: "TRANSACTION_NOT_SUCCESSFUL", value: transaction({ description: null }) },
    { expected: "IN_MESSAGE_MISSING", value: transaction({ in_msg: null }) },
    {
      expected: "DESTINATION_MISMATCH",
      value: transaction({ in_msg: { source: sourceRaw, destination: wrongDestinationRaw, value: "1" } }),
    },
    {
      expected: "SOURCE_INVALID",
      value: transaction({ in_msg: { source: "invalid", destination: destinationRaw, value: "1" } }),
    },
    {
      expected: "AMOUNT_INVALID",
      value: transaction({ in_msg: { source: sourceRaw, destination: destinationRaw, value: "0" } }),
    },
    {
      expected: "AMOUNT_INVALID",
      value: transaction({ in_msg: { source: sourceRaw, destination: destinationRaw, value: "1.5" } }),
    },
  ];

  const result = scan(cases.map(({ value }) => value));
  assert.equal(result.movements.length, 0);
  assert.deepEqual(result.rejections.map(({ code }) => code), cases.map(({ expected }) => expected));
});

test("GRAM shadow parser accepts only finalized non-bounce credit into an uninitialized deposit wallet", () => {
  const creditedUninitialized = transaction({
    description: {
      aborted: true,
      credit_first: true,
      credit_ph: { credit: "1500000000" },
      compute_ph: { skipped: true, reason: "no_state" },
      action: null,
    },
    in_msg: {
      source: sourceRaw,
      destination: destinationRaw,
      value: "1500000000",
      bounce: false,
      bounced: false,
    },
    orig_status: "nonexist",
    end_status: "uninit",
    finality: "finalized",
  } as TonCenterTransaction);

  const accepted = scan([creditedUninitialized]);
  assert.equal(accepted.rejections.length, 0);
  assert.equal(accepted.movements.length, 1);
  assert.equal(accepted.movements[0]?.amountAtomic, "1500000000");
  assert.deepEqual(accepted.movements[0]?.rawPayload, {
    evidenceVersion: 1,
    provider: "toncenter-v3",
    transaction: {
      hash: hashHex,
      lt: "900001",
      now: 1786615800,
      successful: false,
      creditedUninitialized: true,
      source: sourceRaw,
      destination: destinationRaw,
      value: "1500000000",
    },
  });

  const unsafeVariants = [
    { ...creditedUninitialized, finality: "unfinalized" },
    { ...creditedUninitialized, end_status: "nonexist" },
    {
      ...creditedUninitialized,
      description: { ...creditedUninitialized.description, credit_ph: { credit: "1499999999" } },
    },
    {
      ...creditedUninitialized,
      in_msg: { ...creditedUninitialized.in_msg, bounce: true },
    },
    {
      ...creditedUninitialized,
      in_msg: { ...creditedUninitialized.in_msg, bounced: true },
    },
  ] as TonCenterTransaction[];
  const rejected = scan(unsafeVariants);
  assert.equal(rejected.movements.length, 0);
  assert.deepEqual(rejected.rejections.map(({ code }) => code), unsafeVariants.map(
    () => "TRANSACTION_NOT_SUCCESSFUL",
  ));
});

test("GRAM shadow parser rejects base64 transaction hashes with ignored junk or non-canonical padding", () => {
  const result = scan([
    transaction({ hash: `${hashBase64Url}!` }),
    transaction({ hash: `${hashBase64Url}===` }),
  ]);
  assert.equal(result.movements.length, 0);
  assert.deepEqual(result.rejections.map(({ code }) => code), [
    "TRANSACTION_ID_INVALID",
    "TRANSACTION_ID_INVALID",
  ]);
});

test("GRAM shadow parser accepts exact inclusive blockchain-time boundaries", () => {
  const start = transaction({ hash: "01".repeat(32), lt: "1", now: scanStart.getTime() / 1000 });
  const end = transaction({ hash: "02".repeat(32), lt: "2", now: scanNow.getTime() / 1000 });
  assert.equal(scan([start, end]).movements.length, 2);
});

test("GRAM shadow parser refuses inconsistent stored friendly and raw deposit addresses", () => {
  assert.throws(
    () => scanGramShadowTransactions({
      network: "testnet",
      depositAddressId: "deposit-1",
      address: destinationFriendly,
      addressRaw: wrongDestinationRaw,
      notBefore: scanStart,
      notAfter: scanNow,
      transactions: [transaction()],
    }),
    /invalid or inconsistent/,
  );
});

function target(overrides: Partial<GramShadowScanTarget> = {}): GramShadowScanTarget {
  return {
    invoiceId: "invoice-1",
    depositAddressId: "deposit-1",
    network: "testnet",
    depositNetwork: "testnet",
    address: destinationFriendly,
    addressRaw: destinationRaw,
    invoiceAddress: destinationFriendly,
    invoiceAddressRaw: destinationRaw,
    status: "PENDING",
    createdAt: scanStart,
    updatedAt: scanStart,
    terminalMonitorUntil: null,
    cursor: {
      hash: "44".repeat(32),
      lt: "800000",
      timestamp: new Date("2026-08-13T10:05:00.000Z"),
    },
    leaseOwner: "worker-1",
    ...overrides,
  };
}

function repositoryHarness(scanTarget = target()) {
  const calls = {
    renew: 0,
    complete: [] as any[],
    fail: [] as any[],
  };
  const repository: GramShadowScannerRepository = {
    claimDueTargets: async () => [scanTarget],
    renewLease: async () => {
      calls.renew += 1;
      return true;
    },
    completeScan: async (input) => {
      calls.complete.push(input);
      return true;
    },
    failScan: async (input) => {
      calls.fail.push(input);
      return true;
    },
  };
  return { repository, calls };
}

test("GRAM shadow candidate selection includes a USDT checkout deposit", async () => {
  let candidateWhere: Record<string, unknown> | null = null;
  const cursorQueries: Array<{ query: string; values: unknown[] }> = [];
  const cursorUpdates: any[] = [];
  const cursor = {
    id: "cursor-1",
    lastHash: null,
    lastLt: null,
    lastTimestamp: null,
    leaseOwner: null as string | null,
    leaseExpiresAt: null as Date | null,
  };
  const db = {
    $transaction: async (handler: (tx: unknown) => Promise<unknown>) => handler(db),
    $queryRawUnsafe: async (query: string, ...values: unknown[]) => {
      cursorQueries.push({ query, values });
      if (query.includes("clock_timestamp()")) {
        return [{ now: scanNow }];
      }
      return [{ ...cursor }];
    },
    tonhubPaymentInvoice: {
      findMany: async (input: { where: Record<string, unknown> }) => {
        candidateWhere = input.where;
        return [{
          id: "invoice-usdt",
          network: "mainnet",
          checkoutAsset: "USDT",
          address: destinationFriendly,
          addressRaw: destinationRaw,
          status: "PENDING",
          createdAt: scanStart,
          updatedAt: scanStart,
          terminalMonitorUntil: null,
          depositAddress: {
            id: "deposit-usdt",
            network: "mainnet",
            address: destinationFriendly,
            addressRaw: destinationRaw,
          },
        }];
      },
      updateMany: async () => ({ count: 1 }),
      findUnique: async () => ({ id: "invoice-usdt" }),
    },
    tonhubScanCursor: {
      createMany: async () => ({ count: 1 }),
      findUnique: async () => cursor,
      updateMany: async (input: any) => {
        cursorUpdates.push(input);
        Object.assign(cursor, input.data);
        return { count: 1 };
      },
    },
  };
  const repository = createPrismaGramShadowScannerRepository(db as any);
  const targets = await repository.claimDueTargets({
    network: "mainnet",
    workerId: "gram-worker",
    now: scanNow,
    limit: 1,
    leaseMs: 60_000,
    terminalMonitorMs: 30 * 24 * 60 * 60 * 1000,
  });

  assert.equal(Object.hasOwn(candidateWhere ?? {}, "checkoutAsset"), false);
  assert.equal(targets.length, 1);
  assert.equal(targets[0]?.invoiceId, "invoice-usdt");
  const scannedAt = new Date("2026-08-13T10:30:00.000Z");
  assert.equal(await repository.renewLease({
    target: targets[0]!,
    now: scannedAt,
    leaseMs: 60_000,
  }), true);
  assert.equal(cursorUpdates.at(-1)?.data.leaseExpiresAt.toISOString(), "2026-08-13T10:31:00.000Z");
  assert.ok(cursorQueries.some(({ query }) => query.includes("clock_timestamp()")));
  assert.equal(await repository.completeScan({
    target: targets[0]!,
    scannedAt,
    completedAt: scannedAt,
    nextScanAt: new Date("2026-08-13T10:30:15.000Z"),
    terminalMonitorUntil: null,
    cursor: null,
  }), true);
  assert.equal(cursorUpdates.at(-1)?.data.scannedThroughAt, scannedAt);
  assert.equal(cursorUpdates.at(-1)?.data.leaseOwner, null);
  assert.equal(cursorUpdates.at(-1)?.data.leaseExpiresAt, null);
  assert.equal(Object.hasOwn(cursorUpdates.at(-1)?.data ?? {}, "lastTimestamp"), false);
});

test("GRAM shadow batch paginates until its cursor and records only newer successful movements", async () => {
  const harness = repositoryHarness();
  const observed: any[] = [];
  const newest = transaction({ hash: "55".repeat(32), lt: "900100" });
  const aborted = transaction({
    hash: "56".repeat(32),
    lt: "900099",
    description: { aborted: true },
  });
  const previousCursor = transaction({
    hash: "44".repeat(32),
    lt: "800000",
    now: Math.floor(new Date("2026-08-13T10:05:00.000Z").getTime() / 1000),
  });
  const older = transaction({
    hash: "43".repeat(32),
    lt: "700000",
    now: Math.floor(new Date("2026-08-13T10:04:00.000Z").getTime() / 1000),
  });
  const pages = [[newest, aborted], [previousCursor, older]];
  const result = await runGramShadowScanBatch({
    network: "testnet",
    workerId: "worker-1",
    now: scanNow,
    repository: harness.repository,
    ledger: { recordObserved: async (movement) => observed.push(movement) },
    pageSize: 2,
    fetchTransactions: async ({ offset }) => ({ transactions: pages[offset / 2] ?? [] }),
    resolveConfig: () => ({
      network: "testnet",
      baseUrl: "https://example.invalid",
      address: "",
      addressEnvName: "",
    }),
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.outcomes[0]?.transactionsScanned, 2);
  assert.equal(result.outcomes[0]?.movementsObserved, 1);
  assert.deepEqual(result.outcomes[0]?.rejections.map(({ code }) => code), [
    "TRANSACTION_NOT_SUCCESSFUL",
  ]);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].transactionHash, "55".repeat(32));
  assert.equal(harness.calls.renew, 3);
  assert.equal(harness.calls.fail.length, 0);
  assert.equal(harness.calls.complete.length, 1);
  assert.equal(harness.calls.complete[0].cursor.hash, "55".repeat(32));
});

test("GRAM shadow restart resumes from its persisted cursor without replaying a movement", async () => {
  let storedCursor: GramShadowScanTarget["cursor"] = { hash: null, lt: null, timestamp: null };
  const observed: string[] = [];
  const repository: GramShadowScannerRepository = {
    claimDueTargets: async ({ workerId }) => [{
      ...target({ cursor: storedCursor }),
      leaseOwner: workerId,
    }],
    renewLease: async () => true,
    completeScan: async ({ cursor }) => {
      if (cursor) storedCursor = cursor;
      return true;
    },
    failScan: async () => true,
  };
  const run = (workerId: string) => runGramShadowScanBatch({
    network: "testnet",
    workerId,
    repository,
    ledger: {
      recordObserved: async (movement) => {
        observed.push(movement.fingerprint);
      },
    },
    now: scanNow,
    clock: () => scanNow,
    pageSize: 10,
    fetchTransactions: async () => ({ transactions: [transaction()] }),
    resolveConfig: () => ({
      network: "testnet",
      baseUrl: "https://testnet.toncenter.com/api/v3",
      address: destinationFriendly,
      addressEnvName: "TON_TESTNET_ADDRESS",
    }),
  });

  const first = await run("restart-worker-1");
  const second = await run("restart-worker-2");

  assert.equal(first.outcomes[0]?.movementsObserved, 1);
  assert.equal(second.outcomes[0]?.movementsObserved, 0);
  assert.deepEqual(observed, [`ton:testnet:native-in:${hashHex}:0`]);
  assert.equal(storedCursor.hash, hashHex);
});

test("GRAM shadow batch keeps settlement untouched and releases a failed scan for retry", async () => {
  const harness = repositoryHarness();
  const settlement = {
    invoiceStatus: "PENDING",
    invoicePaidAtomic: "0",
    orderStatus: "PENDING",
    orderCreditedFiatMicros: "0",
  };
  const result = await runGramShadowScanBatch({
    network: "testnet",
    workerId: "worker-1",
    now: scanNow,
    repository: harness.repository,
    ledger: {
      recordObserved: async () => {
        throw new Error("shadow persistence unavailable");
      },
    },
    fetchTransactions: async () => ({ transactions: [transaction()] }),
    resolveConfig: () => ({
      network: "testnet",
      baseUrl: "https://example.invalid",
      address: "",
      addressEnvName: "",
    }),
  });

  assert.equal(result.failed, 1);
  assert.match(result.outcomes[0]?.error ?? "", /shadow persistence unavailable/);
  assert.equal(harness.calls.complete.length, 0);
  assert.equal(harness.calls.fail.length, 1);
  assert.deepEqual(settlement, {
    invoiceStatus: "PENDING",
    invoicePaidAtomic: "0",
    orderStatus: "PENDING",
    orderCreditedFiatMicros: "0",
  });
});

test("GRAM shadow batch refuses inconsistent invoice and deposit ownership addresses before fetching", async () => {
  const harness = repositoryHarness(target({ invoiceAddressRaw: wrongDestinationRaw }));
  let fetches = 0;
  const result = await runGramShadowScanBatch({
    network: "testnet",
    workerId: "worker-1",
    now: scanNow,
    clock: () => scanNow,
    repository: harness.repository,
    ledger: { recordObserved: async () => undefined },
    fetchTransactions: async () => {
      fetches += 1;
      return { transactions: [] };
    },
    resolveConfig: () => ({
      network: "testnet",
      baseUrl: "https://example.invalid",
      address: "",
      addressEnvName: "",
    }),
  });

  assert.equal(result.failed, 1);
  assert.match(result.outcomes[0]?.error ?? "", /invoice and deposit address evidence/);
  assert.equal(fetches, 0);
  assert.equal(harness.calls.fail.length, 1);
});

test("GRAM shadow batch refuses an invoice/deposit network mismatch before fetching", async () => {
  const harness = repositoryHarness(target({ depositNetwork: "mainnet" }));
  let fetches = 0;
  const result = await runGramShadowScanBatch({
    network: "testnet",
    workerId: "worker-1",
    now: scanNow,
    clock: () => scanNow,
    repository: harness.repository,
    ledger: { recordObserved: async () => undefined },
    fetchTransactions: async () => {
      fetches += 1;
      return { transactions: [] };
    },
    resolveConfig: () => ({
      network: "testnet",
      baseUrl: "https://example.invalid",
      address: "",
      addressEnvName: "",
    }),
  });

  assert.equal(result.failed, 1);
  assert.match(result.outcomes[0]?.error ?? "", /network evidence is inconsistent/);
  assert.equal(fetches, 0);
});

test("GRAM shadow batch deduplicates identical provider page overlap before ledger persistence", async () => {
  const harness = repositoryHarness(target({
    cursor: { hash: null, lt: null, timestamp: null },
  }));
  const observed: any[] = [];
  const duplicate = transaction();
  const result = await runGramShadowScanBatch({
    network: "testnet",
    workerId: "worker-1",
    now: scanNow,
    clock: () => scanNow,
    repository: harness.repository,
    ledger: { recordObserved: async (movement) => observed.push(movement) },
    fetchTransactions: async () => ({ transactions: [duplicate, structuredClone(duplicate)] }),
    resolveConfig: () => ({
      network: "testnet",
      baseUrl: "https://example.invalid",
      address: "",
      addressEnvName: "",
    }),
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.outcomes[0]?.movementsObserved, 1);
  assert.equal(observed.length, 1);
});

test("GRAM shadow cursor never advances past provider evidence from the future", async () => {
  const harness = repositoryHarness();
  const future = transaction({
    hash: "77".repeat(32),
    lt: "999999",
    now: Math.floor(scanNow.getTime() / 1000) + 30,
  });
  const previous = transaction({
    hash: "44".repeat(32),
    lt: "800000",
    now: Math.floor(new Date("2026-08-13T10:05:00.000Z").getTime() / 1000),
  });
  const result = await runGramShadowScanBatch({
    network: "testnet",
    workerId: "worker-1",
    now: scanNow,
    clock: () => scanNow,
    repository: harness.repository,
    ledger: { recordObserved: async () => undefined },
    fetchTransactions: async () => ({ transactions: [future, previous] }),
    resolveConfig: () => ({
      network: "testnet",
      baseUrl: "https://example.invalid",
      address: "",
      addressEnvName: "",
    }),
  });

  assert.equal(result.scanned, 1);
  assert.deepEqual(result.outcomes[0]?.rejections.map(({ code }) => code), [
    "TRANSACTION_OUTSIDE_WINDOW",
  ]);
  assert.equal(harness.calls.complete[0].cursor.hash, "44".repeat(32));
});

test("GRAM shadow batch does not fetch or advance after losing its lease", async () => {
  const harness = repositoryHarness();
  harness.repository.renewLease = async () => false;
  let fetches = 0;
  const result = await runGramShadowScanBatch({
    network: "testnet",
    workerId: "worker-1",
    now: scanNow,
    repository: harness.repository,
    ledger: { recordObserved: async () => undefined },
    fetchTransactions: async () => {
      fetches += 1;
      return { transactions: [] };
    },
    resolveConfig: () => ({
      network: "testnet",
      baseUrl: "https://example.invalid",
      address: "",
      addressEnvName: "",
    }),
  });

  assert.equal(result.failed, 1);
  assert.equal(fetches, 0);
  assert.equal(harness.calls.complete.length, 0);
  assert.equal(harness.calls.fail.length, 1);
});

test("GRAM shadow cannot journal after its lease expires during a provider pass", async () => {
  let renewals = 0;
  let observations = 0;
  let completions = 0;
  let failures = 0;
  const result = await runGramShadowScanBatch({
    network: "testnet",
    now: scanNow,
    clock: () => scanNow,
    repository: {
      claimDueTargets: async () => [target({ cursor: { hash: null, lt: null, timestamp: null } })],
      renewLease: async () => {
        renewals += 1;
        return renewals === 1;
      },
      completeScan: async () => {
        completions += 1;
        return true;
      },
      failScan: async () => {
        failures += 1;
        return true;
      },
    },
    ledger: {
      recordObserved: async () => {
        observations += 1;
      },
    },
    fetchTransactions: async () => ({ transactions: [transaction()] }),
    resolveConfig: () => ({
      network: "testnet",
      baseUrl: "https://testnet.toncenter.com/api/v3",
      address: destinationFriendly,
      addressEnvName: "TON_TESTNET_DEPOSIT_ADDRESS",
    }),
  });

  assert.equal(result.failed, 1);
  assert.equal(renewals, 2);
  assert.equal(observations, 0);
  assert.equal(completions, 0);
  assert.equal(failures, 1);
});

test("GRAM shadow terminal cadence ends exactly 30 days after the terminal transition", async () => {
  const terminalAt = new Date("2026-08-03T10:30:00.000Z");
  const harness = repositoryHarness(target({
    status: "EXPIRED",
    updatedAt: terminalAt,
    cursor: { hash: null, lt: null, timestamp: null },
  }));
  const result = await runGramShadowScanBatch({
    network: "testnet",
    workerId: "worker-1",
    now: scanNow,
    clock: () => scanNow,
    repository: harness.repository,
    ledger: { recordObserved: async () => undefined },
    fetchTransactions: async () => ({ transactions: [] }),
    resolveConfig: () => ({
      network: "testnet",
      baseUrl: "https://example.invalid",
      address: "",
      addressEnvName: "",
    }),
  });

  assert.equal(result.scanned, 1);
  assert.equal(
    harness.calls.complete[0].terminalMonitorUntil.toISOString(),
    "2026-09-02T10:30:00.000Z",
  );
  assert.equal(
    harness.calls.complete[0].nextScanAt.toISOString(),
    "2026-08-14T10:30:00.000Z",
  );
});

test("GRAM shadow does not advance a cursor when the pagination safety cap is exhausted", async () => {
  const harness = repositoryHarness();
  const result = await runGramShadowScanBatch({
    network: "testnet",
    workerId: "worker-1",
    now: scanNow,
    clock: () => scanNow,
    repository: harness.repository,
    ledger: { recordObserved: async () => undefined },
    pageSize: 1,
    maxPages: 1,
    fetchTransactions: async () => ({
      transactions: [transaction({ hash: "66".repeat(32), lt: "990000" })],
    }),
    resolveConfig: () => ({
      network: "testnet",
      baseUrl: "https://example.invalid",
      address: "",
      addressEnvName: "",
    }),
  });

  assert.equal(result.failed, 1);
  assert.match(result.outcomes[0]?.error ?? "", /exceeded 1 pages/);
  assert.equal(harness.calls.complete.length, 0);
  assert.equal(harness.calls.fail.length, 1);
});
