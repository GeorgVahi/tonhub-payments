import { resolveAllowedNetworks } from "./config";
import { resolveCheckoutAssetPolicy } from "./checkout-assets";

const requiredMigration = "20260814102000_cross_scanner_settlement_horizon";

type CanaryDb = {
  $queryRawUnsafe: (query: string, ...values: unknown[]) => Promise<any[]>;
  tonhubRateSnapshot: { findFirst: (input: unknown) => Promise<any> };
  tonhubPaymentOrder: { findMany: (input: unknown) => Promise<any[]> };
  tonhubOutboxEvent: { count: (input: unknown) => Promise<number> };
};

function snapshotMaxAgeMs(env: NodeJS.ProcessEnv | Record<string, string | undefined>) {
  const raw = String(env.TON_RATE_SNAPSHOT_MAX_AGE_SECONDS ?? "300").trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error("TON_RATE_SNAPSHOT_MAX_AGE_SECONDS must be an integer.");
  }
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds < 30 || seconds > 3_600) {
    throw new Error("TON_RATE_SNAPSHOT_MAX_AGE_SECONDS must be between 30 and 3600.");
  }
  return seconds * 1_000;
}

function statusCounts(values: Array<{ status: string }>) {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value.status] = (counts[value.status] ?? 0) + 1;
    return counts;
  }, {});
}

export async function inspectMainnetUsdtCanary(input: {
  db: CanaryDb;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  now?: Date;
}) {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const policy = resolveCheckoutAssetPolicy(env);
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (policy.usdtMainnetEnabled) {
    blockers.push("Public mainnet USDT checkout must remain disabled during the canary.");
  }
  if (!policy.usdtMainnetCanaryEnabled) {
    blockers.push("Mainnet USDT canary prerequisites or the external-id allowlist are not enabled.");
  }
  if (!resolveAllowedNetworks(env as NodeJS.ProcessEnv).includes("mainnet")) {
    blockers.push("TON_ALLOWED_NETWORKS must include mainnet.");
  }
  if (String(env.TON_GRAM_SETTLEMENT_MODE ?? "ledger").trim().toLowerCase() !== "ledger") {
    blockers.push("TON_GRAM_SETTLEMENT_MODE must be ledger for the production canary.");
  }

  const migrationRows = await input.db.$queryRawUnsafe(
    `SELECT "finished_at", "rolled_back_at" FROM "_prisma_migrations" WHERE "migration_name" = $1`,
    requiredMigration,
  );
  if (migrationRows.length !== 1 || !migrationRows[0].finished_at || migrationRows[0].rolled_back_at) {
    blockers.push(`Required migration ${requiredMigration} is not successfully applied.`);
  }

  const maxAgeMs = snapshotMaxAgeMs(env);
  const rateRows = await Promise.all((["GRAM", "USDT"] as const).flatMap((asset) =>
    (["USD", "EUR"] as const).map(async (quoteCurrency) => ({
    asset,
    quoteCurrency,
    row: await input.db.tonhubRateSnapshot.findFirst({
      where: { asset, baseCurrency: asset, quoteCurrency },
      orderBy: [{ observedAt: "desc" }, { id: "desc" }],
    }),
  }))));
  for (const { asset, quoteCurrency, row } of rateRows) {
    if (!row || !(row.observedAt instanceof Date) || row.observedAt > now ||
        now.getTime() - row.observedAt.getTime() > maxAgeMs) {
      blockers.push(`A fresh no-lookahead ${asset}/${quoteCurrency} rate snapshot is required.`);
      continue;
    }
    if (asset === "USDT" && quoteCurrency === "USD" && String(row.price) !== "1") {
      blockers.push("The canary requires the exact 1 USDT = 1 USD snapshot policy.");
    }
  }

  const orders = await input.db.tonhubPaymentOrder.findMany({
    where: { externalId: { in: [...policy.usdtMainnetCanaryExternalIds] } },
    select: {
      id: true,
      externalId: true,
      status: true,
      recoveryCases: { select: { id: true, status: true } },
      sweeps: { select: { id: true, status: true } },
      invoices: {
        select: {
          id: true,
          network: true,
          checkoutAsset: true,
          status: true,
          recoveryCases: { select: { id: true, status: true } },
          sweeps: { select: { id: true, status: true } },
          depositAddress: { select: { sweepStatus: true } },
        },
      },
    },
  });
  const invoices = orders.flatMap((order) => order.invoices ?? []);
  const recoveryRecords = orders.flatMap((order) => [
    ...(order.recoveryCases ?? []),
    ...(order.invoices ?? []).flatMap((invoice: any) => (
      invoice.recoveryCases ?? []
    )),
  ]);
  const sweepRecords = orders.flatMap((order) => [
    ...(order.sweeps ?? []),
    ...(order.invoices ?? []).flatMap((invoice: any) => (
      invoice.sweeps ?? []
    )),
  ]);
  const unresolvedRecoveryIds = new Set(
    recoveryRecords.filter((value: any) => value.status !== "RESOLVED").map((value: any) => value.id),
  );
  const failedSweepIds = new Set(
    sweepRecords.filter((value: any) => value.status === "FAILED").map((value: any) => value.id),
  );
  const failedNativeSweeps = invoices.filter((invoice) => invoice.depositAddress?.sweepStatus === "FAILED");
  if (unresolvedRecoveryIds.size > 0 || orders.some((order) => order.status === "RECOVERY")) {
    blockers.push("A canary order has an unresolved recovery case or recovery status.");
  }
  if (failedSweepIds.size > 0 || failedNativeSweeps.length > 0) {
    blockers.push("A canary order has a failed asset or native sweep.");
  }
  if (invoices.some((invoice) => invoice.network !== "mainnet" || !["GRAM", "USDT"].includes(invoice.checkoutAsset))) {
    blockers.push("A canary order contains an invoice with inconsistent network or asset identity.");
  }

  const aggregateIds = [
    ...orders.map((order) => order.id),
    ...invoices.map((invoice) => invoice.id),
    ...new Set(recoveryRecords.map((value: any) => value.id)),
    ...new Set(sweepRecords.map((value: any) => value.id)),
  ];
  const failedWebhooks = aggregateIds.length === 0 ? 0 : await input.db.tonhubOutboxEvent.count({
    where: { aggregateId: { in: aggregateIds }, status: "FAILED" },
  });
  if (failedWebhooks > 0) blockers.push("A canary-related webhook is waiting for retry.");

  return {
    ok: blockers.length === 0,
    checkedAt: now.toISOString(),
    mode: "allowlisted-mainnet-usdt",
    configuredOrders: policy.usdtMainnetCanaryExternalIds.length,
    materializedOrders: orders.length,
    orderStatuses: statusCounts(orders),
    invoiceStatuses: statusCounts(invoices),
    unresolvedRecoveries: unresolvedRecoveryIds.size,
    failedSweeps: failedSweepIds.size + failedNativeSweeps.length,
    failedWebhooks,
    blockers,
    warnings,
  };
}
