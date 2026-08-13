import assert from "node:assert/strict";
import test from "node:test";
import { inspectMainnetUsdtCanary } from "../backend/src/mainnet-usdt-canary";

const env = {
  TON_ALLOWED_NETWORKS: "testnet,mainnet",
  TON_USDT_MAINNET_CHECKOUT_ENABLED: "false",
  TON_USDT_MAINNET_ADAPTER_ENABLED: "true",
  TON_MOVEMENT_SETTLEMENT_ENABLED: "true",
  TON_GRAM_SETTLEMENT_MODE: "ledger",
  TON_USDT_MAINNET_CANARY_EXTERNAL_IDS: "canary-order-1,canary-order-2",
  TON_RATE_SNAPSHOT_MAX_AGE_SECONDS: "300",
};

function db(input: { orders?: any[]; rates?: Record<string, any>; migration?: boolean; failedWebhooks?: number } = {}) {
  const now = new Date("2026-08-13T12:00:00.000Z");
  return {
    $queryRawUnsafe: async () => input.migration === false ? [] : [{ finished_at: now, rolled_back_at: null }],
    tonhubRateSnapshot: {
      findFirst: async (query: any) => input.rates?.[query.where.quoteCurrency] ?? {
        price: query.where.quoteCurrency === "USD" ? "1" : "0.9",
        observedAt: new Date(now.getTime() - 30_000),
      },
    },
    tonhubPaymentOrder: { findMany: async () => input.orders ?? [] },
    tonhubOutboxEvent: { count: async () => input.failedWebhooks ?? 0 },
  };
}

test("mainnet canary preflight is read-only and ready before allowlisted orders are issued", async () => {
  const report = await inspectMainnetUsdtCanary({
    db: db() as any,
    env,
    now: new Date("2026-08-13T12:00:00.000Z"),
  });
  assert.equal(report.ok, true);
  assert.equal(report.configuredOrders, 2);
  assert.equal(report.materializedOrders, 0);
  assert.deepEqual(report.blockers, []);
});

test("mainnet canary preflight stops on public exposure, stale rates, recovery, or sweep failure", async () => {
  const now = new Date("2026-08-13T12:00:00.000Z");
  const report = await inspectMainnetUsdtCanary({
    db: db({
      rates: {
        USD: { price: "0.99", observedAt: new Date(now.getTime() - 301_000) },
        EUR: { price: "0.9", observedAt: new Date(now.getTime() + 1_000) },
      },
      orders: [{
        id: "order-1",
        externalId: "canary-order-1",
        status: "RECOVERY",
        recoveryCases: [{ id: "recovery-1", status: "OPEN" }],
        sweeps: [{ id: "sweep-1", status: "FAILED" }],
        invoices: [{
          id: "invoice-1",
          network: "mainnet",
          checkoutAsset: "USDT",
          status: "PARTIAL",
          recoveryCases: [],
          sweeps: [],
          depositAddress: { sweepStatus: "FAILED" },
        }],
      }],
      failedWebhooks: 1,
    }) as any,
    env: { ...env, TON_USDT_MAINNET_CHECKOUT_ENABLED: "true" },
    now,
  });
  assert.equal(report.ok, false);
  assert.ok(report.blockers.some((value) => value.includes("Public mainnet")));
  assert.ok(report.blockers.some((value) => value.includes("USDT/USD")));
  assert.ok(report.blockers.some((value) => value.includes("USDT/EUR")));
  assert.ok(report.blockers.some((value) => value.includes("recovery")));
  assert.ok(report.blockers.some((value) => value.includes("sweep")));
  assert.ok(report.blockers.some((value) => value.includes("webhook")));
  assert.deepEqual(report.warnings, []);
});

test("mainnet canary preflight blocks reviewed recovery and a recovery order until resolution", async () => {
  const report = await inspectMainnetUsdtCanary({
    db: db({
      orders: [{
        id: "order-1",
        externalId: "canary-order-1",
        status: "RECOVERY",
        recoveryCases: [{ id: "recovery-1", status: "REVIEWED" }],
        sweeps: [],
        invoices: [],
      }],
    }) as any,
    env,
    now: new Date("2026-08-13T12:00:00.000Z"),
  });
  assert.equal(report.ok, false);
  assert.equal(report.unresolvedRecoveries, 1);
  assert.ok(report.blockers.some((value) => value.includes("unresolved recovery")));
});
