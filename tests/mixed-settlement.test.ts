import assert from "node:assert/strict";
import test from "node:test";
import { createMixedAssetSettlement } from "../backend/src/mixed-settlement";
import { officialMainnetUsdtMasterAddress } from "../backend/src/ton/mainnet-usdt";
import type { TonhubPaymentInvoiceRecord } from "../backend/src/types";
import { runMixedSettlementBatch } from "../worker/src/mixed-settlement";

const createdAt = new Date("2026-08-13T10:00:00.000Z");
const now = new Date("2026-08-13T10:30:00.000Z");

function invoice(overrides: Partial<TonhubPaymentInvoiceRecord> = {}): TonhubPaymentInvoiceRecord {
  return {
    id: "mixed-invoice",
    externalId: "mixed-order",
    orderId: "order-1",
    order: {
      id: "order-1",
      externalId: "mixed-order",
      fiatAmountMicros: "5000000",
      fiatCurrency: "USD",
      creditedFiatMicros: "0",
      overpaymentFiatMicros: "0",
      status: "PENDING",
      paidAt: null,
      expiresAt: new Date("2026-08-13T11:00:00.000Z"),
      cancelledAt: null,
      createdAt,
      updatedAt: createdAt,
      metadata: null,
    },
    network: "testnet",
    asset: "GRAM",
    checkoutAsset: "GRAM",
    assetKind: "NATIVE",
    assetDecimals: 9,
    fiatAmountCents: 500,
    fiatAmountMicros: "5000000",
    creditedFiatMicros: "0",
    remainingFiatMicros: "5000000",
    activationThresholdFiatMicros: "2500000",
    fiatCurrency: "USD",
    address: "EQ_MIXED",
    addressRaw: "0:mixed",
    addressStrategy: "unique-address",
    walletVersion: "v5r1",
    walletWorkchain: 0,
    walletContext: 1,
    walletNetworkGlobalId: -3,
    walletPublicKeyHash: "mixed-key",
    amountNano: "2000000000",
    paidNano: "0",
    amountAtomic: "2000000000",
    paidAmountAtomic: "0",
    reference: "MIXED",
    status: "PENDING",
    providerName: "ton-direct",
    observedTransactionHash: null,
    observedAt: null,
    firstMovementAt: null,
    partialPaymentStartedAt: null,
    partialPaymentExpiresAt: null,
    expiresAt: new Date("2026-08-13T11:00:00.000Z"),
    priceLockedAt: createdAt,
    priceLockedUntil: new Date("2026-08-13T11:00:00.000Z"),
    observedPayments: null,
    createdAt,
    updatedAt: createdAt,
    metadata: null,
    payload: null,
    ...overrides,
  };
}

function harness(input: {
  movements?: any[];
  current?: TonhubPaymentInvoiceRecord;
  depositAddress?: any;
} = {}) {
  let current = input.current ?? invoice();
  let expired = 0;
  let movementQuery: any = null;
  const creditCalls: any[] = [];
  const outcomes = new Map<
    string,
    "credited" | "rate-pending" | "held-under-minimum" | "recovery" | "blocked-earlier-movement" | "awaiting-scan-horizon"
  >();
  const depositAddress = input.depositAddress ?? { id: "deposit-1", network: current.network };
  const db = {
    tonhubPaymentInvoice: {
      findUnique: async () => ({ ...current, depositAddress }),
    },
    tonhubPaymentMovement: {
      findMany: async ({ where }: any) => {
        movementQuery = where;
        const retryBefore = where.OR?.find((branch: any) => branch.status === "RATE_PENDING")
          ?.updatedAt?.lte;
        return (input.movements ?? []).map((movement) => ({
          network: current.network,
          ...movement,
        })).filter((movement) =>
          movement.status !== "RATE_PENDING" ||
          !retryBefore ||
          movement.updatedAt.getTime() <= retryBefore.getTime());
      },
    },
  };
  const creditor = {
    creditMovement: async (value: any) => {
      creditCalls.push(value);
      return {
        outcome: outcomes.get(value.movementId) ?? "credited",
        movement: { id: value.movementId },
      };
    },
  };
  const repository = {
    findInvoiceById: async () => current,
    markInvoiceExpired: async ({ expiredAt }: any) => {
      expired += 1;
      current = { ...current, status: "EXPIRED", observedAt: expiredAt };
      return current;
    },
  };
  return {
    service: createMixedAssetSettlement(db as any, creditor as any, repository as any),
    outcomes,
    creditCalls,
    expired: () => expired,
    movementQuery: () => movementQuery,
  };
}

test("mixed settlement stops at the earliest rate-pending movement before later assets can lock state", async () => {
  const first = {
    id: "movement-gram",
    depositAddressId: "deposit-1",
    direction: "INCOMING",
    asset: "GRAM",
    assetKind: "NATIVE",
    assetDecimals: 9,
    blockchainAt: new Date("2026-08-13T10:01:00.000Z"),
  };
  const second = {
    id: "movement-usdt",
    depositAddressId: "deposit-1",
    direction: "INCOMING",
    asset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    blockchainAt: new Date("2026-08-13T10:02:00.000Z"),
  };
  const testHarness = harness({ movements: [first, second] });
  testHarness.outcomes.set(first.id, "rate-pending");
  const result = await testHarness.service.settleInvoice({ invoiceId: "mixed-invoice", now });

  assert.equal(result.ratePending, true);
  assert.deepEqual(testHarness.creditCalls.map(({ movementId }) => movementId), [first.id]);
  assert.equal(testHarness.expired(), 0);
});

test("mixed settlement excludes RATE_PENDING evidence until the worker retry cutoff even when a later movement is observed", async () => {
  const retryBefore = new Date("2026-08-13T10:29:00.000Z");
  const pending = {
    id: "movement-rate-pending",
    depositAddressId: "deposit-1",
    direction: "INCOMING",
    status: "RATE_PENDING",
    updatedAt: new Date("2026-08-13T10:29:30.000Z"),
    asset: "GRAM",
    assetKind: "NATIVE",
    assetDecimals: 9,
    blockchainAt: new Date("2026-08-13T10:01:00.000Z"),
  };
  const observed = {
    id: "movement-observed-later",
    depositAddressId: "deposit-1",
    direction: "INCOMING",
    status: "OBSERVED",
    updatedAt: new Date("2026-08-13T10:29:45.000Z"),
    asset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    blockchainAt: new Date("2026-08-13T10:02:00.000Z"),
  };
  const testHarness = harness({ movements: [pending, observed] });
  await testHarness.service.settleInvoice({
    invoiceId: "mixed-invoice",
    now,
    ratePendingBefore: retryBefore,
  });

  assert.deepEqual(testHarness.creditCalls.map(({ movementId }) => movementId), [observed.id]);
  assert.equal(
    testHarness.movementQuery().OR[1].updatedAt.lte.toISOString(),
    retryBefore.toISOString(),
  );
});

test("mixed settlement does not expire while an earlier movement is being settled concurrently", async () => {
  const movement = {
    id: "movement-blocked",
    depositAddressId: "deposit-1",
    direction: "INCOMING",
    asset: "GRAM",
    assetKind: "NATIVE",
    assetDecimals: 9,
    blockchainAt: new Date("2026-08-13T10:01:00.000Z"),
  };
  const testHarness = harness({
    current: invoice({ expiresAt: new Date("2026-08-13T10:20:00.000Z") }),
    movements: [movement],
  });
  testHarness.outcomes.set(movement.id, "blocked-earlier-movement");
  const result = await testHarness.service.settleInvoice({ invoiceId: "mixed-invoice", now });

  assert.equal(result.deferred, true);
  assert.equal(result.invoice.status, "PENDING");
  assert.equal(testHarness.expired(), 0);
});

test("mixed settlement does not expire while mainnet scanners have not crossed the movement horizon", async () => {
  const movement = {
    id: "movement-awaiting-horizon",
    depositAddressId: "deposit-1",
    direction: "INCOMING",
    asset: "GRAM",
    assetKind: "NATIVE",
    assetDecimals: 9,
    blockchainAt: new Date("2026-08-13T10:01:00.000Z"),
  };
  const testHarness = harness({
    current: invoice({ expiresAt: new Date("2026-08-13T10:20:00.000Z") }),
    movements: [movement],
  });
  testHarness.outcomes.set(movement.id, "awaiting-scan-horizon");
  const result = await testHarness.service.settleInvoice({ invoiceId: "mixed-invoice", now });

  assert.equal(result.deferred, true);
  assert.equal(result.invoice.status, "PENDING");
  assert.equal(testHarness.expired(), 0);
});

test("mixed settlement expires an empty invoice only after exhausting on-chain candidates", async () => {
  const testHarness = harness({
    current: invoice({ expiresAt: new Date("2026-08-13T10:20:00.000Z") }),
  });
  const result = await testHarness.service.settleInvoice({ invoiceId: "mixed-invoice", now });

  assert.equal(result.invoice.status, "EXPIRED");
  assert.equal(testHarness.expired(), 1);
  assert.deepEqual(testHarness.creditCalls, []);
});

test("an under-minimum payment expires in the background after its window without another movement", async () => {
  const expiredAt = new Date("2026-08-13T10:20:00.000Z");
  const testHarness = harness({ current: invoice({ expiresAt: expiredAt }) });
  let selectedWhere: any = null;
  const scheduledAttempts: Date[] = [];
  const db = {
    tonhubDepositAddress: {
      findMany: async ({ where }: any) => {
        selectedWhere = where;
        return [{ id: "deposit-1", invoice: { id: "mixed-invoice" }, _count: { movements: 0 } }];
      },
      updateMany: async ({ data }: any) => {
        if (data.settlementNextAttemptAt instanceof Date) {
          scheduledAttempts.push(data.settlementNextAttemptAt);
        }
        return { count: 1 };
      },
    },
  };

  const result = await runMixedSettlementBatch({
    db: db as any,
    settlement: testHarness.service,
    now,
    limit: 1,
  });

  assert.equal(selectedWhere.OR[1].movements.some.status, "HELD_UNDER_MINIMUM");
  assert.equal(selectedWhere.OR[1].invoice.is.partialPaymentExpiresAt, undefined);
  assert.equal(selectedWhere.OR[1].invoice.is.OR[1].expiresAt.lte.toISOString(), now.toISOString());
  assert.ok(scheduledAttempts[0] instanceof Date);
  assert.equal(result.invoicesSettled, 1);
  assert.equal(result.settled[0]?.invoice.status, "EXPIRED");
  assert.equal(testHarness.expired(), 1);
});

test("mixed settlement leaves zero-threshold legacy attempts on the characterized rollback path", async () => {
  const testHarness = harness({
    current: invoice({ activationThresholdFiatMicros: "0" }),
    movements: [{
      id: "legacy-movement",
      depositAddressId: "deposit-1",
      direction: "INCOMING",
      asset: "GRAM",
      assetKind: "NATIVE",
      assetDecimals: 9,
      blockchainAt: new Date("2026-08-13T10:01:00.000Z"),
    }],
  });
  const result = await testHarness.service.settleInvoice({ invoiceId: "mixed-invoice", now });

  assert.equal(result.invoice.status, "PENDING");
  assert.deepEqual(testHarness.creditCalls, []);
  assert.equal(testHarness.expired(), 0);
});

test("mixed settlement refuses an unsupported movement identity before allocation", async () => {
  const testHarness = harness({
    movements: [{
      id: "fake-usdt",
      depositAddressId: "deposit-1",
      direction: "INCOMING",
      asset: "USDT",
      assetKind: "NATIVE",
      assetDecimals: 9,
      blockchainAt: new Date("2026-08-13T10:01:00.000Z"),
    }],
  });

  await assert.rejects(
    testHarness.service.settleInvoice({ invoiceId: "mixed-invoice", now }),
    /unsupported settlement identity/,
  );
  assert.deepEqual(testHarness.creditCalls, []);
});

test("mainnet settlement accepts only official USDT bound to the verified deposit jetton wallet", async () => {
  const verifiedWallet = `0:${"71".repeat(32)}`;
  const mainnetOwner = `0:${"51".repeat(32)}`;
  const baseMovement = {
    id: "official-usdt",
    depositAddressId: "deposit-1",
    network: "mainnet",
    direction: "INCOMING",
    asset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    toAddress: mainnetOwner,
    ownerAddress: mainnetOwner,
    jettonMasterAddress: officialMainnetUsdtMasterAddress,
    jettonWalletAddress: verifiedWallet,
    rawPayload: { officialUsdt: true },
    blockchainAt: new Date("2026-08-13T10:01:00.000Z"),
  };
  const current = invoice({
    network: "mainnet",
    address: mainnetOwner,
    addressRaw: mainnetOwner,
    walletNetworkGlobalId: -239,
  });
  const depositAddress = {
    id: "deposit-1",
    network: "mainnet",
    address: mainnetOwner,
    addressRaw: mainnetOwner,
    assetAccounts: [{
      network: "mainnet",
      asset: "USDT",
      assetKind: "JETTON",
      assetDecimals: 6,
      jettonMasterAddress: officialMainnetUsdtMasterAddress,
      assetWalletAddress: verifiedWallet,
      status: "VERIFIED",
    }],
  };
  const accepted = harness({ current, depositAddress, movements: [baseMovement] });
  await accepted.service.settleInvoice({ invoiceId: current.id, now });
  assert.deepEqual(accepted.creditCalls.map(({ movementId }) => movementId), [baseMovement.id]);

  for (const [label, override] of [
    ["fake master", { jettonMasterAddress: `0:${"62".repeat(32)}` }],
    ["wrong wallet", { jettonWalletAddress: `0:${"72".repeat(32)}` }],
    ["wrong owner", { toAddress: `0:${"53".repeat(32)}` }],
    ["wrong network", { network: "testnet" }],
    ["missing official provenance", { rawPayload: null }],
  ] as const) {
    const rejected = harness({
      current,
      depositAddress,
      movements: [{ ...baseMovement, id: `rejected-${label}`, ...override }],
    });
    await assert.rejects(
      rejected.service.settleInvoice({ invoiceId: current.id, now }),
      /inconsistent settlement ownership|verified official USDT identity/,
      label,
    );
    assert.deepEqual(rejected.creditCalls, [], label);
  }
});

test("mixed settlement worker rotates poison deposits so later invoices run on the next batch", async () => {
  const calls: Array<{ invoiceId: string; ratePendingBefore?: Date }> = [];
  const deposits = [
    { id: "deposit-a", invoiceId: "invoice-a", movements: 5, settlementNextAttemptAt: null as Date | null },
    { id: "deposit-b", invoiceId: "invoice-b", movements: 1, settlementNextAttemptAt: null as Date | null },
    { id: "deposit-c", invoiceId: "invoice-c", movements: 1, settlementNextAttemptAt: null as Date | null },
  ];
  const db = {
    tonhubDepositAddress: {
      findMany: async ({ take, where }: any) => {
        assert.equal(take, 2);
        assert.ok(where.OR[0].movements?.some);
        const dueAt = where.AND.OR[1].settlementNextAttemptAt.lte as Date;
        return deposits
          .filter(({ settlementNextAttemptAt }) =>
            settlementNextAttemptAt === null || settlementNextAttemptAt.getTime() <= dueAt.getTime())
          .sort((left, right) => {
            if (left.settlementNextAttemptAt === null || right.settlementNextAttemptAt === null) {
              if (left.settlementNextAttemptAt === right.settlementNextAttemptAt) {
                return left.id.localeCompare(right.id);
              }
              return left.settlementNextAttemptAt === null ? -1 : 1;
            }
            return left.settlementNextAttemptAt.getTime() - right.settlementNextAttemptAt.getTime() ||
              left.id.localeCompare(right.id);
          })
          .slice(0, take)
          .map((deposit) => ({
            id: deposit.id,
            invoice: { id: deposit.invoiceId },
            _count: { movements: deposit.movements },
          }));
      },
      updateMany: async ({ where, data }: any) => {
        const deposit = deposits.find(({ id }) => id === where.id);
        if (!deposit) {
          return { count: 0 };
        }
        if (where.AND) {
          const dueAt = where.AND.OR[1].settlementNextAttemptAt.lte as Date;
          if (deposit.settlementNextAttemptAt && deposit.settlementNextAttemptAt.getTime() > dueAt.getTime()) {
            return { count: 0 };
          }
        }
        if (
          where.settlementNextAttemptAt instanceof Date &&
          deposit.settlementNextAttemptAt?.getTime() !== where.settlementNextAttemptAt.getTime()
        ) {
          return { count: 0 };
        }
        deposit.settlementNextAttemptAt = data.settlementNextAttemptAt;
        return { count: 1 };
      },
    },
  };
  const settlement = {
    settleInvoice: async ({ invoiceId, ratePendingBefore }: any) => {
      calls.push({ invoiceId, ratePendingBefore });
      if (invoiceId === "invoice-a" || invoiceId === "invoice-b") {
        throw new Error("rate storage unavailable");
      }
      return { invoice: invoice(), outcomes: [], ratePending: false, deferred: false };
    },
  };
  const first = await runMixedSettlementBatch({
    now,
    limit: 2,
    db,
    settlement,
  });
  const second = await runMixedSettlementBatch({
    now: new Date("2026-08-13T10:30:15.000Z"),
    limit: 2,
    db,
    settlement,
  });

  assert.deepEqual(calls.map(({ invoiceId }) => invoiceId), ["invoice-a", "invoice-b", "invoice-c"]);
  assert.deepEqual(
    calls.map(({ ratePendingBefore }) => ratePendingBefore?.toISOString()),
    [
      "2026-08-13T10:29:00.000Z",
      "2026-08-13T10:29:00.000Z",
      "2026-08-13T10:29:15.000Z",
    ],
  );
  assert.equal(first.movementsSelected, 6);
  assert.equal(first.invoicesSelected, 2);
  assert.equal(first.invoicesSettled, 0);
  assert.deepEqual(first.errors.map(({ invoiceId }) => invoiceId), ["invoice-a", "invoice-b"]);
  assert.equal(second.movementsSelected, 1);
  assert.equal(second.invoicesSelected, 1);
  assert.equal(second.invoicesSettled, 1);
  assert.deepEqual(second.errors, []);
});

test("background settlement schedules one thousand active attempts without browser polling", async () => {
  const deposits = Array.from({ length: 1_000 }, (_, index) => ({
    id: `load-deposit-${index}`,
    invoice: { id: `load-invoice-${index}` },
    _count: { movements: 1 },
  }));
  const settledIds: string[] = [];
  const result = await runMixedSettlementBatch({
    db: {
      tonhubDepositAddress: {
        findMany: async ({ take, where }: any) => {
          assert.equal(take, 1_000);
          assert.ok(where.OR[0].movements.some);
          return deposits;
        },
        updateMany: async () => ({ count: 1 }),
      },
    } as any,
    settlement: {
      settleInvoice: async ({ invoiceId }: any) => {
        settledIds.push(invoiceId);
        return {
          invoice: invoice({ id: invoiceId, status: "PAID" }),
          outcomes: [],
          ratePending: false,
          deferred: false,
        };
      },
    },
    now,
    limit: 1_000,
  });

  assert.equal(result.invoicesSelected, 1_000);
  assert.equal(result.invoicesSettled, 1_000);
  assert.equal(result.errors.length, 0);
  assert.equal(new Set(settledIds).size, 1_000);
});
