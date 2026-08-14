import assert from "node:assert/strict";
import test from "node:test";
import { Address } from "@ton/core";
import {
  calculateActivationThresholdFiatMicros,
  calculateMovementFiatMicros,
  crossScannerSettlementHorizonMs,
  createMovementLedger,
  MovementFingerprintConflictError,
  type PaymentMovementDraft,
} from "../backend/src/movement-ledger";
import { officialMainnetUsdtMasterAddress } from "../backend/src/ton/mainnet-usdt";

function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, expected]: [string, any]) => {
    if (expected && typeof expected === "object" && "in" in expected) {
      return expected.in.includes(row[key]);
    }
    if (expected && typeof expected === "object" && "lte" in expected) {
      return row[key].getTime() <= expected.lte.getTime();
    }
    if (expected && typeof expected === "object" && "not" in expected) {
      return row[key] !== expected.not;
    }
    return row[key] === expected;
  });
}

function createMemoryLedgerDb() {
  const movements: any[] = [];
  const allocations: any[] = [];
  const adjustments: any[] = [];
  const quotes: any[] = [{
    id: "quote-gram-1",
    orderId: "order-1",
    invoiceId: "invoice-1",
    asset: "GRAM",
    fiatCurrency: "USD",
    grossFiatMicros: "5000000",
    discountFiatMicros: "1000000",
    netFiatMicros: "4000000",
  }];
  const orders: any[] = [{
    id: "order-1",
    externalId: "merchant-order-1",
    fiatAmountMicros: "5000000",
    fiatCurrency: "USD",
    creditedFiatMicros: "0",
    discountFiatMicros: "0",
    overpaymentFiatMicros: "0",
    gramDiscountMaxFiatMicros: "1000000",
    intermediateSweepTriggerBps: 9000,
    intermediateSweepMinFiatMicros: "100000000",
    maxAutomaticSweepsPerAsset: 0,
    status: "PENDING",
    paidAt: null,
    expiresAt: new Date("2026-08-13T11:00:00.000Z"),
  }];
  const invoices: any[] = [{
    id: "invoice-1",
    orderId: "order-1",
    checkoutAsset: "GRAM",
    fiatAmountMicros: "5000000",
    creditedFiatMicros: "0",
    remainingFiatMicros: "5000000",
    activationThresholdFiatMicros: "0",
    paidNano: "0",
    paidAmountAtomic: "0",
    status: "PENDING",
    paymentSelectionLockedAsset: null,
    paymentSelectionLockedAt: null,
    firstMovementAt: null,
    partialPaymentStartedAt: null,
    partialPaymentExpiresAt: null,
    expiresAt: new Date("2026-08-13T11:00:00.000Z"),
    observedAt: null,
    observedTransactionHash: null,
    observedPayments: null,
    settlementReason: null,
    version: 0,
    depositAddress: { id: "deposit-1" },
  }];
  const deposits: any[] = [{ id: "deposit-1", invoiceId: "invoice-1", status: "ACTIVE" }];
  const recoveryCases: any[] = [];
  const assetAccounts: any[] = [];
  const sweeps: any[] = [];
  const scanCursors: any[] = [];
  const rates: any[] = [
    {
      id: "rate-gram-usd",
      asset: "GRAM",
      baseCurrency: "GRAM",
      quoteCurrency: "USD",
      price: { toString: () => "2.5" },
      source: "coingecko",
      observedAt: new Date("2026-08-13T09:59:00.000Z"),
      fetchedAt: new Date("2026-08-13T09:59:10.000Z"),
      createdAt: new Date("2026-08-13T09:59:11.000Z"),
    },
    {
      id: "rate-usdt-usd",
      asset: "USDT",
      baseCurrency: "USDT",
      quoteCurrency: "USD",
      price: { toString: () => "1" },
      source: "usd-peg",
      observedAt: new Date("2026-08-13T09:59:30.000Z"),
      fetchedAt: new Date("2026-08-13T09:59:30.000Z"),
      createdAt: new Date("2026-08-13T09:59:31.000Z"),
      payload: { policy: "1 USDT = 1 USD" },
    },
  ];
  let movementSequence = 0;
  let allocationSequence = 0;
  let adjustmentSequence = 0;
  let clock = 0;
  const now = () => new Date(1_786_617_600_000 + clock++ * 1_000);
  const db: any = {
    $transaction: async (handler: (tx: any) => Promise<unknown>) => {
      const snapshot = structuredClone({
        movements,
        allocations,
        adjustments,
        orders,
        invoices,
        deposits,
        recoveryCases,
        assetAccounts,
        sweeps,
        scanCursors,
      });
      try {
        return await handler(db);
      } catch (error) {
        movements.splice(0, movements.length, ...snapshot.movements);
        allocations.splice(0, allocations.length, ...snapshot.allocations);
        adjustments.splice(0, adjustments.length, ...snapshot.adjustments);
        orders.splice(0, orders.length, ...snapshot.orders);
        invoices.splice(0, invoices.length, ...snapshot.invoices);
        deposits.splice(0, deposits.length, ...snapshot.deposits);
        recoveryCases.splice(0, recoveryCases.length, ...snapshot.recoveryCases);
        assetAccounts.splice(0, assetAccounts.length, ...snapshot.assetAccounts);
        sweeps.splice(0, sweeps.length, ...snapshot.sweeps);
        scanCursors.splice(0, scanCursors.length, ...snapshot.scanCursors);
        throw error;
      }
    },
    $queryRawUnsafe: async (query: string, ...values: unknown[]) => {
      const databaseClock = new Date("2026-08-13T10:00:05.000Z");
      if (query.includes("clock_timestamp()")) {
        return [{ now: databaseClock }];
      }
      if (!query.includes("TonhubScanCursor")) {
        return [];
      }
      if (query.includes('"leaseOwner" = $4')) {
        return scanCursors.filter((row) =>
          row.network === values[0] &&
          row.scopeKey === values[1] &&
          row.streamType === values[2] &&
          row.leaseOwner === values[3]);
      }
      return scanCursors.filter((row) =>
        row.network === "mainnet" &&
        row.scopeKey === values[0] &&
        ["GRAM_NATIVE_IN", "USDT_MAINNET_IN"].includes(row.streamType));
    },
    tonhubPaymentMovement: {
      createMany: async ({ data, skipDuplicates }: any) => {
        let count = 0;
        for (const candidate of data) {
          const existing = movements.find((row) => row.fingerprint === candidate.fingerprint);
          if (existing && skipDuplicates) {
            continue;
          }
          const createdAt = now();
          movements.push({
            id: `movement-${++movementSequence}`,
            status: "OBSERVED",
            validationCode: null,
            rateSnapshotId: null,
            fiatCreditMicros: null,
            createdAt,
            updatedAt: createdAt,
            ...candidate,
          });
          count += 1;
        }
        return { count };
      },
      findUnique: async ({ where }: any) => movements.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where }: any) => {
        const { depositAddress: depositFilter, ...movementWhere } = where ?? {};
        return movements.filter((row) => {
          if (!matches(row, movementWhere)) return false;
          const expectedOrderId = depositFilter?.invoice?.orderId;
          if (!expectedOrderId) return true;
          const invoice = invoices.find((candidate) => candidate.depositAddress?.id === row.depositAddressId);
          return invoice?.orderId === expectedOrderId;
        });
      },
      updateMany: async ({ where, data }: any) => {
        const rows = movements.filter((row) => matches(row, where));
        for (const row of rows) {
          Object.assign(row, data, { updatedAt: now() });
        }
        return { count: rows.length };
      },
    },
    tonhubMovementAllocation: {
      create: async ({ data }: any) => {
        if (
          (data.kind === "CREDIT" && allocations.some((row) =>
            row.kind === "CREDIT" && row.movementId === data.movementId)) ||
          (data.reversesAllocationId && allocations.some((row) =>
            row.reversesAllocationId === data.reversesAllocationId))
        ) {
          throw Object.assign(new Error("unique allocation"), { code: "P2002" });
        }
        const row = {
          id: `allocation-${++allocationSequence}`,
          reversesAllocationId: null,
          allocatedBy: "system",
          allocatedAt: now(),
          note: null,
          ...data,
        };
        allocations.push(row);
        return row;
      },
      findUnique: async ({ where }: any) => allocations.find((row) => matches(row, where)) ?? null,
      findFirst: async ({ where }: any) => allocations.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where, include }: any) => allocations
        .filter((row) => matches(row, where))
        .map((row) => {
          if (!include?.movement) {
            return row;
          }
          const movement = movements.find(({ id }) => id === row.movementId) ?? null;
          return {
            ...row,
            movement: movement && include.movement.include?.rateSnapshot
              ? {
                  ...movement,
                  rateSnapshot: rates.find(({ id }) => id === movement.rateSnapshotId) ?? null,
                }
              : movement,
          };
        }),
    },
    tonhubPaymentOrder: {
      findUnique: async ({ where }: any) => orders.find((row) => matches(row, where)) ?? null,
      update: async ({ where, data }: any) => {
        const row = orders.find((candidate) => matches(candidate, where));
        if (!row) {
          throw new Error("order missing");
        }
        Object.assign(row, data);
        return row;
      },
    },
    tonhubPaymentInvoice: {
      findUnique: async ({ where }: any) => invoices.find((row) => matches(row, where)) ?? null,
      findFirst: async ({ where }: any) => invoices.find((row) => matches(row, where)) ?? null,
      update: async ({ where, data }: any) => {
        const row = invoices.find((candidate) => matches(candidate, where));
        if (!row) {
          throw new Error("invoice missing");
        }
        const normalizedData = { ...data };
        if (data.version && typeof data.version.increment === "number") {
          normalizedData.version = row.version + data.version.increment;
        }
        Object.assign(row, normalizedData);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const rows = invoices.filter((row) => matches(row, where));
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      },
    },
    tonhubPaymentQuote: {
      findFirst: async ({ where }: any) => quotes.find((row) => matches(row, where)) ?? null,
    },
    tonhubOrderAdjustment: {
      findUnique: async ({ where }: any) => adjustments.find((row) => matches(row, where)) ?? null,
      findFirst: async ({ where }: any) => adjustments.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where }: any) => adjustments.filter((row) => matches(row, where)),
      create: async ({ data }: any) => {
        if (
          adjustments.some((row) => row.idempotencyKey === data.idempotencyKey) ||
          (data.reversesAdjustmentId && adjustments.some((row) =>
            row.reversesAdjustmentId === data.reversesAdjustmentId))
        ) {
          throw Object.assign(new Error("unique adjustment"), { code: "P2002" });
        }
        const row = {
          id: `adjustment-${++adjustmentSequence}`,
          kind: "PAYMENT_METHOD_DISCOUNT",
          reversesAdjustmentId: null,
          evidence: null,
          createdAt: now(),
          ...data,
        };
        adjustments.push(row);
        const order = orders.find(({ id }) => id === row.orderId);
        if (order) {
          order.discountFiatMicros = adjustments
            .filter((candidate) => candidate.orderId === row.orderId)
            .reduce((sum, candidate) => (
              candidate.kind === "PAYMENT_METHOD_DISCOUNT"
                ? sum + BigInt(candidate.fiatAmountMicros)
                : sum - BigInt(candidate.fiatAmountMicros)
            ), BigInt(0)).toString();
        }
        return row;
      },
    },
    tonhubDepositAddress: {
      findUnique: async ({ where }: any) => {
        const deposit = deposits.find((row) => matches(row, where));
        if (!deposit) {
          return null;
        }
        const invoice = invoices.find((row) => row.depositAddress?.id === deposit.id) ?? null;
        return {
          ...deposit,
          invoice,
          assetAccounts: assetAccounts.filter((row) => row.depositAddressId === deposit.id),
        };
      },
      updateMany: async ({ where, data }: any) => {
        const rows = deposits.filter((row) => matches(row, where));
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      },
    },
    tonhubDepositAssetAccount: {},
    tonhubAssetSweep: {
      createMany: async ({ data, skipDuplicates }: any) => {
        const duplicate = sweeps.some((row) =>
          row.idempotencyKey === data.idempotencyKey ||
          (
            row.depositAddressId === data.depositAddressId &&
            row.asset === data.asset &&
            row.status !== "CONFIRMED"
          ));
        if (duplicate && skipDuplicates) {
          return { count: 0 };
        }
        sweeps.push({ id: `sweep-${sweeps.length + 1}`, createdAt: now(), ...data });
        return { count: 1 };
      },
      findUnique: async ({ where }: any) => sweeps.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where }: any) => sweeps.filter((row) => matches(row, where)),
      findFirst: async ({ where }: any) => sweeps.find((row) => matches(row, where)) ?? null,
    },
    tonhubScanCursor: {
      findMany: async ({ where }: any) => scanCursors.filter((row) => matches(row, where)),
    },
    tonhubRecoveryCase: {
      findUnique: async ({ where }: any) => recoveryCases.find((row) => matches(row, where)) ?? null,
      createMany: async ({ data, skipDuplicates }: any) => {
        const duplicate = recoveryCases.some((row) => row.id === data.id || (
          row.movementId === data.movementId && row.reason === data.reason
        ));
        if (duplicate && skipDuplicates) {
          return { count: 0 };
        }
        recoveryCases.push({ id: `recovery-${recoveryCases.length + 1}`, status: "OPEN", ...data });
        return { count: 1 };
      },
      updateMany: async ({ where, data }: any) => {
        const rows = recoveryCases.filter((row) => matches(row, where));
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      },
    },
    tonhubRateSnapshot: {
      findUnique: async ({ where }: any) => rates.find((row) => matches(row, where)) ?? null,
      findFirst: async ({ where }: any) => rates
        .filter((row) => matches(row, where))
        .sort((left, right) =>
          right.observedAt.getTime() - left.observedAt.getTime() ||
          right.fetchedAt.getTime() - left.fetchedAt.getTime() ||
          right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null,
    },
  };
  return {
    db,
    movements,
    allocations,
    adjustments,
    quotes,
    orders,
    invoices,
    deposits,
    recoveryCases,
    assetAccounts,
    sweeps,
    scanCursors,
    rates,
  };
}

function movement(overrides: Partial<PaymentMovementDraft> = {}): PaymentMovementDraft {
  return {
    fingerprint: "testnet:tx-gram:incoming:0",
    depositAddressId: "deposit-1",
    network: "testnet",
    direction: "INCOMING",
    asset: "GRAM",
    assetKind: "NATIVE",
    assetDecimals: 9,
    amountAtomic: "1500000000",
    fromAddress: "EQ_SENDER",
    toAddress: "EQ_DEPOSIT",
    transactionHash: "tx-gram",
    transactionLt: "12345",
    blockchainAt: new Date("2026-08-13T10:00:00.000Z"),
    rawPayload: { eventIndex: 0 },
    ...overrides,
  };
}

test("movement valuation floors exact atomic asset value to fiat micros", () => {
  assert.equal(calculateMovementFiatMicros({
    amountAtomic: "1500000000",
    assetDecimals: 9,
    price: "2.5",
  }), "3750000");
  assert.equal(calculateMovementFiatMicros({
    amountAtomic: "1",
    assetDecimals: 6,
    price: "0.333333333333333333",
  }), "0");
  assert.throws(() => calculateMovementFiatMicros({
    amountAtomic: "-1",
    assetDecimals: 6,
    price: "1",
  }), /positive atomic integer/);
});

test("cross-scanner settlement horizon config is strict and bounded", () => {
  assert.equal(crossScannerSettlementHorizonMs({}), 60_000);
  assert.equal(crossScannerSettlementHorizonMs({
    TON_CROSS_SCANNER_SETTLEMENT_HORIZON_SECONDS: "90",
  }), 90_000);
  assert.throws(() => crossScannerSettlementHorizonMs({
    TON_CROSS_SCANNER_SETTLEMENT_HORIZON_SECONDS: "60seconds",
  }), /must be an integer/);
  assert.throws(() => crossScannerSettlementHorizonMs({
    TON_CROSS_SCANNER_SETTLEMENT_HORIZON_SECONDS: "4",
  }), /between 5 and 3600/);
  assert.throws(() => crossScannerSettlementHorizonMs({
    TON_CROSS_SCANNER_SETTLEMENT_HORIZON_SECONDS: "3601",
  }), /between 5 and 3600/);
});

test("a rejected unsupported jetton is journaled once for recovery and can never credit an order", async () => {
  const memory = createMemoryLedgerDb();
  const ledger = createMovementLedger(memory.db);
  const rejected = movement({
    fingerprint: "ton:testnet:jetton-rejected:fake-master",
    asset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    amountAtomic: "5000000",
    jettonMasterAddress: "EQ_FAKE_MASTER",
    jettonWalletAddress: "EQ_VERIFIED_DEPOSIT_WALLET",
    transactionHash: "fake-master-transaction",
    rawPayload: { untrustedJettonCandidate: true },
  });
  const rejection = {
    movement: rejected,
    validationCode: "JETTON_MASTER_NOT_ALLOWLISTED",
    reason: "UNSUPPORTED_JETTON_MASTER",
    title: "Unsupported jetton received by a deposit address",
    details: { configuredMasterAddress: "EQ_ALLOWLISTED_MASTER" },
  };

  const first = await ledger.recordRejected(rejection);
  const replay = await ledger.recordRejected(rejection);

  assert.equal(first.id, replay.id);
  assert.equal(first.status, "REJECTED");
  assert.equal(first.validationCode, "JETTON_MASTER_NOT_ALLOWLISTED");
  assert.equal(memory.movements.length, 1);
  assert.equal(memory.allocations.length, 0);
  assert.equal(memory.recoveryCases.length, 1);
  assert.equal(memory.recoveryCases[0]?.movementId, first.id);
  assert.equal(memory.recoveryCases[0]?.invoiceId, "invoice-1");
  assert.equal(memory.recoveryCases[0]?.orderId, "order-1");
  assert.equal(memory.recoveryCases[0]?.reason, "UNSUPPORTED_JETTON_MASTER");
  assert.equal(memory.invoices[0]?.paymentSelectionLockedAsset, null);
  assert.equal(memory.invoices[0]?.paymentSelectionLockedAt, null);
  await assert.rejects(
    ledger.recordObserved(rejected),
    /cannot be replayed as observed/,
  );
  assert.equal(memory.invoices[0]?.paymentSelectionLockedAsset, null);
  assert.equal(memory.invoices[0]?.paymentSelectionLockedAt, null);
  assert.equal(memory.sweeps.length, 0);
  await assert.rejects(
    ledger.recordRejected({
      ...rejection,
      details: { configuredMasterAddress: "EQ_DIFFERENT_ALLOWLIST" },
    }),
    /recovery evidence conflicts/,
  );
  await assert.rejects(
    ledger.recordRejected({
      ...rejection,
      reason: "DIFFERENT_REJECTION_REASON",
      title: "Conflicting recovery classification",
    }),
    /recovery evidence conflicts/,
  );
  assert.equal(memory.recoveryCases.length, 1);
  assert.equal(memory.recoveryCases[0]?.reason, "UNSUPPORTED_JETTON_MASTER");
  memory.recoveryCases.splice(0, memory.recoveryCases.length);
  await ledger.recordRejected(rejection);
  assert.equal(memory.recoveryCases.length, 1);
  assert.equal(memory.recoveryCases[0]?.movementId, first.id);
  await assert.rejects(
    ledger.creditMovement({
      movementId: first.id,
      orderId: "order-1",
      invoiceId: "invoice-1",
      validationCode: "JETTON_INBOUND_V1",
    }),
    /is REJECTED/,
  );
  assert.equal(memory.orders[0]?.creditedFiatMicros, "0");
  assert.equal(memory.invoices[0]?.creditedFiatMicros, "0");
});

test("initial partial threshold is the capped maximum of half the order and twice merchant cost", () => {
  assert.equal(calculateActivationThresholdFiatMicros({
    orderFiatMicros: "5000000",
    merchantNetworkFeeFiatMicros: "500000",
  }), "2500000");
  assert.equal(calculateActivationThresholdFiatMicros({
    orderFiatMicros: "5000000",
    merchantNetworkFeeFiatMicros: "2000000",
  }), "4000000");
  assert.equal(calculateActivationThresholdFiatMicros({
    orderFiatMicros: "5000000",
    merchantNetworkFeeFiatMicros: "3000000",
  }), "5000000");
});

test("observed movement replay is idempotent and conflicting facts are rejected", async () => {
  const memory = createMemoryLedgerDb();
  const ledger = createMovementLedger(memory.db);
  const first = await ledger.recordObserved(movement());
  const replay = await ledger.recordObserved(movement());

  assert.equal(first.id, replay.id);
  assert.equal(memory.movements.length, 1);
  assert.equal(memory.invoices[0]?.paymentSelectionLockedAsset, "GRAM");
  assert.equal(
    memory.invoices[0]?.paymentSelectionLockedAt.toISOString(),
    "2026-08-13T10:00:00.000Z",
  );
  await assert.rejects(
    ledger.recordObserved(movement({ amountAtomic: "1600000000" })),
    MovementFingerprintConflictError,
  );
  assert.equal(memory.movements.length, 1);
});

test("official mainnet USDT observation queues nothing until credited policy reaches a sweep trigger", async () => {
  const memory = createMemoryLedgerDb();
  const owner = Address.parseRaw(`0:${"11".repeat(32)}`).toRawString();
  const assetWallet = Address.parseRaw(`0:${"22".repeat(32)}`).toRawString();
  Object.assign(memory.deposits[0], {
    network: "mainnet",
    address: owner,
    addressRaw: owner,
  });
  Object.assign(memory.invoices[0], {
    network: "mainnet",
    address: owner,
    addressRaw: owner,
  });
  Object.assign(memory.orders[0], {
    maxAutomaticSweepsPerAsset: 2,
    intermediateSweepTriggerBps: 9000,
    intermediateSweepMinFiatMicros: "100000000",
  });
  memory.assetAccounts.push({
    depositAddressId: "deposit-1",
    network: "mainnet",
    asset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    jettonMasterAddress: officialMainnetUsdtMasterAddress,
    assetWalletAddress: assetWallet,
    status: "VERIFIED",
  });
  const ledger = createMovementLedger(memory.db);
  const draft = movement({
    fingerprint: `ton:mainnet:jetton-in:${"ab".repeat(32)}:9:${officialMainnetUsdtMasterAddress}`,
    network: "mainnet",
    asset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    amountAtomic: "5000000",
    toAddress: owner,
    ownerAddress: owner,
    jettonMasterAddress: officialMainnetUsdtMasterAddress,
    jettonWalletAddress: assetWallet,
    transactionHash: "ab".repeat(32),
    queryId: "9",
    rawPayload: { officialUsdt: true },
  });
  const first = await ledger.recordObserved(draft);
  await ledger.recordObserved(draft);
  assert.equal(memory.sweeps.length, 0);
  await ledger.creditMovement({
    movementId: first.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "JETTON_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });
  assert.equal(memory.sweeps.length, 1);
  assert.equal(memory.sweeps[0]?.idempotencyKey, "automatic:order-1:USDT:1");
  assert.equal(memory.sweeps[0]?.asset, "USDT");
  assert.equal(memory.sweeps[0]?.status, "QUEUED");
  assert.equal(memory.sweeps[0]?.triggerReason, "TERMINAL_PAID");
  await ledger.creditMovement({
    movementId: first.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "JETTON_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });
  assert.equal(memory.sweeps.length, 1);
});

test("uncredited and outgoing USDT observations never create sweep jobs", async () => {
  const memory = createMemoryLedgerDb();
  const owner = Address.parseRaw(`0:${"21".repeat(32)}`).toRawString();
  const assetWallet = Address.parseRaw(`0:${"22".repeat(32)}`).toRawString();
  Object.assign(memory.deposits[0], { network: "mainnet", address: owner, addressRaw: owner });
  Object.assign(memory.invoices[0], { network: "mainnet", address: owner, addressRaw: owner });
  memory.assetAccounts.push({
    depositAddressId: "deposit-1",
    network: "mainnet",
    asset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    jettonMasterAddress: officialMainnetUsdtMasterAddress,
    assetWalletAddress: assetWallet,
    status: "VERIFIED",
  });
  const ledger = createMovementLedger(memory.db);
  const official = (suffix: string, amountAtomic: string, direction: "INCOMING" | "OUTGOING") => movement({
    fingerprint: `ton:mainnet:jetton-${direction.toLowerCase()}:${suffix}`,
    network: "mainnet",
    direction,
    asset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    amountAtomic,
    toAddress: direction === "INCOMING" ? owner : Address.parseRaw(`0:${"23".repeat(32)}`).toRawString(),
    ownerAddress: owner,
    jettonMasterAddress: officialMainnetUsdtMasterAddress,
    jettonWalletAddress: assetWallet,
    transactionHash: suffix.repeat(64).slice(0, 64),
    queryId: suffix,
    rawPayload: { officialUsdt: true },
  });
  await ledger.recordObserved(official("1", "5000000", "INCOMING"));
  assert.equal(memory.sweeps.length, 0);
  await ledger.recordObserved(official("2", "10000000", "OUTGOING"));
  await ledger.recordObserved(official("3", "5000000", "INCOMING"));
  assert.equal(memory.sweeps.length, 0);
});

test("automatic official USDT sweep fails closed when credited asset-wallet ownership drifts", async () => {
  const memory = createMemoryLedgerDb();
  const owner = Address.parseRaw(`0:${"31".repeat(32)}`).toRawString();
  const observedWallet = Address.parseRaw(`0:${"32".repeat(32)}`).toRawString();
  const storedWallet = Address.parseRaw(`0:${"33".repeat(32)}`).toRawString();
  Object.assign(memory.deposits[0], { network: "mainnet", address: owner, addressRaw: owner });
  Object.assign(memory.invoices[0], { network: "mainnet", address: owner, addressRaw: owner });
  Object.assign(memory.orders[0], { maxAutomaticSweepsPerAsset: 2 });
  memory.assetAccounts.push({
    depositAddressId: "deposit-1",
    network: "mainnet",
    asset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    jettonMasterAddress: officialMainnetUsdtMasterAddress,
    assetWalletAddress: storedWallet,
    status: "VERIFIED",
  });
  const ledger = createMovementLedger(memory.db);
  const observed = await ledger.recordObserved(movement({
      fingerprint: "ton:mainnet:jetton-in:ownership-drift",
      network: "mainnet",
      asset: "USDT",
      assetKind: "JETTON",
      assetDecimals: 6,
      amountAtomic: "5000000",
      toAddress: owner,
      ownerAddress: owner,
      jettonMasterAddress: officialMainnetUsdtMasterAddress,
      jettonWalletAddress: observedWallet,
      rawPayload: { officialUsdt: true },
    }));
  await assert.rejects(
    ledger.creditMovement({
      movementId: observed.id,
      orderId: "order-1",
      invoiceId: "invoice-1",
      validationCode: "JETTON_INBOUND_V1",
      maxRateAgeMs: 300_000,
    }),
    /movement ownership evidence is inconsistent/,
  );
  assert.equal(memory.movements.length, 1);
  assert.equal(memory.movements[0]?.status, "OBSERVED");
  assert.equal(memory.allocations.length, 0);
  assert.equal(memory.sweeps.length, 0);
});

test("automatic GRAM sweeps reserve sequence two for terminal payment", async () => {
  const memory = createMemoryLedgerDb();
  const owner = Address.parseRaw(`0:${"41".repeat(32)}`).toRawString();
  Object.assign(memory.deposits[0], {
    network: "testnet",
    address: owner,
    addressRaw: owner,
  });
  Object.assign(memory.invoices[0], {
    network: "testnet",
    checkoutAsset: "USDT",
    address: owner,
    addressRaw: owner,
  });
  Object.assign(memory.orders[0], {
    maxAutomaticSweepsPerAsset: 2,
    intermediateSweepTriggerBps: 9000,
    intermediateSweepMinFiatMicros: "100000000",
  });
  const ledger = createMovementLedger(memory.db);
  const first = await ledger.recordObserved(movement({
    fingerprint: "testnet:gram:auto-sweep:1",
    amountAtomic: "1800000000",
    toAddress: owner,
    transactionHash: "auto-sweep-1",
  }));
  await ledger.creditMovement({
    movementId: first.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });
  assert.equal(memory.orders[0]?.status, "PARTIAL");
  assert.equal(memory.sweeps.length, 1);
  assert.equal(memory.sweeps[0]?.automaticSequence, 1);
  assert.equal(memory.sweeps[0]?.triggerReason, "INTERMEDIATE_RATIO");
  assert.equal(memory.sweeps[0]?.triggerFiatMicros, "4500000");
  memory.sweeps[0].status = "CONFIRMED";

  const final = await ledger.recordObserved(movement({
    fingerprint: "testnet:gram:auto-sweep:2",
    amountAtomic: "200000000",
    toAddress: owner,
    transactionHash: "auto-sweep-2",
    transactionLt: "12346",
    blockchainAt: new Date("2026-08-13T10:01:00.000Z"),
  }));
  await ledger.creditMovement({
    movementId: final.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });
  assert.equal(memory.orders[0]?.status, "PAID");
  assert.equal(memory.sweeps.length, 2);
  assert.equal(memory.sweeps[1]?.automaticSequence, 2);
  assert.equal(memory.sweeps[1]?.triggerReason, "TERMINAL_PAID");
  assert.equal(memory.sweeps[1]?.triggerFiatMicros, "500000");
});

test("automatic sweep reconciliation rejects a conflicting canonical idempotency row", async () => {
  const memory = createMemoryLedgerDb();
  const owner = Address.parseRaw(`0:${"44".repeat(32)}`).toRawString();
  Object.assign(memory.deposits[0], {
    network: "testnet",
    address: owner,
    addressRaw: owner,
  });
  Object.assign(memory.invoices[0], {
    network: "testnet",
    checkoutAsset: "USDT",
    address: owner,
    addressRaw: owner,
  });
  Object.assign(memory.orders[0], {
    maxAutomaticSweepsPerAsset: 2,
    intermediateSweepTriggerBps: 9000,
    intermediateSweepMinFiatMicros: "100000000",
  });
  memory.sweeps.push({
    id: "conflicting-automatic-row",
    idempotencyKey: "automatic:order-1:GRAM:1",
    depositAddressId: "foreign-deposit",
    orderId: "foreign-order",
    invoiceId: "foreign-invoice",
    asset: "GRAM",
    assetKind: "NATIVE",
    automaticSequence: 1,
    triggerReason: "INTERMEDIATE_RATIO",
    triggerFiatMicros: "4500000",
    triggerCreditedFiatMicros: "4500000",
    triggeredAt: new Date("2026-08-13T10:00:00.000Z"),
    status: "QUEUED",
  });
  const ledger = createMovementLedger(memory.db);
  const observed = await ledger.recordObserved(movement({
    fingerprint: "testnet:gram:auto-idempotency-conflict",
    amountAtomic: "1800000000",
    toAddress: owner,
    transactionHash: "auto-idempotency-conflict",
  }));

  await assert.rejects(ledger.creditMovement({
    movementId: observed.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
  }), /idempotency conflict/i);
  assert.equal(memory.allocations.length, 0);
  assert.equal(memory.sweeps.length, 1);
});

test("a confirmed legacy sweep is the fiat baseline for later automatic thresholds", async () => {
  const memory = createMemoryLedgerDb();
  const owner = Address.parseRaw(`0:${"42".repeat(32)}`).toRawString();
  Object.assign(memory.deposits[0], {
    network: "testnet",
    address: owner,
    addressRaw: owner,
  });
  Object.assign(memory.invoices[0], {
    network: "testnet",
    address: owner,
    addressRaw: owner,
    fiatAmountMicros: "1000000000",
    creditedFiatMicros: "150000000",
    remainingFiatMicros: "850000000",
    paidNano: "60000000000",
    paidAmountAtomic: "60000000000",
    status: "PARTIAL",
  });
  Object.assign(memory.orders[0], {
    fiatAmountMicros: "1000000000",
    creditedFiatMicros: "150000000",
    status: "PARTIAL",
    maxAutomaticSweepsPerAsset: 2,
    intermediateSweepTriggerBps: 9000,
    intermediateSweepMinFiatMicros: "100000000",
  });
  Object.assign(memory.quotes[0], {
    grossFiatMicros: "1000000000",
    discountFiatMicros: "1000000",
    netFiatMicros: "999000000",
  });
  memory.movements.push({
    id: "legacy-credit-movement",
    ...movement({
      fingerprint: "testnet:legacy-credit:incoming:0",
      amountAtomic: "60000000000",
      toAddress: owner,
      transactionHash: "legacy-credit",
      transactionLt: "12000",
      blockchainAt: new Date("2026-08-13T09:55:00.000Z"),
    }),
    status: "CREDITED",
    validationCode: "NATIVE_INBOUND_V1",
    rateSnapshotId: "rate-gram-usd",
    fiatCreditMicros: "150000000",
    createdAt: new Date("2026-08-13T09:55:01.000Z"),
    updatedAt: new Date("2026-08-13T09:55:10.000Z"),
  });
  memory.allocations.push({
    id: "legacy-credit-allocation",
    movementId: "legacy-credit-movement",
    orderId: "order-1",
    invoiceId: "invoice-1",
    kind: "CREDIT",
    fiatCreditMicros: "150000000",
    reversesAllocationId: null,
    allocatedBy: "system",
    allocatedAt: new Date("2026-08-13T09:55:10.000Z"),
  });
  memory.movements.push({
    id: "legacy-outgoing-movement",
    ...movement({
      fingerprint: "testnet:legacy-sweep:outgoing:0",
      direction: "OUTGOING",
      amountAtomic: "60000000000",
      fromAddress: owner,
      toAddress: Address.parseRaw(`0:${"43".repeat(32)}`).toRawString(),
      transactionHash: "legacy-sweep",
      transactionLt: "12001",
      blockchainAt: new Date("2026-08-13T09:56:00.000Z"),
    }),
    status: "OBSERVED",
    validationCode: null,
    rateSnapshotId: null,
    fiatCreditMicros: null,
    createdAt: new Date("2026-08-13T09:56:01.000Z"),
    updatedAt: new Date("2026-08-13T09:56:01.000Z"),
  });
  memory.sweeps.push({
    id: "legacy-confirmed-sweep",
    idempotencyKey: "legacy-confirmed-sweep",
    depositAddressId: "deposit-1",
    orderId: "order-1",
    invoiceId: "invoice-1",
    asset: "GRAM",
    assetKind: "NATIVE",
    automaticSequence: null,
    status: "CONFIRMED",
    confirmedAt: new Date("2026-08-13T09:56:00.000Z"),
    createdAt: new Date("2026-08-13T09:55:30.000Z"),
  });

  const ledger = createMovementLedger(memory.db);
  const tiny = await ledger.recordObserved(movement({
    fingerprint: "testnet:post-legacy-tiny:incoming:0",
    amountAtomic: "400000000",
    toAddress: owner,
    transactionHash: "post-legacy-tiny",
    transactionLt: "12002",
    blockchainAt: new Date("2026-08-13T10:01:00.000Z"),
  }));
  const credited = await ledger.creditMovement({
    movementId: tiny.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });

  assert.equal(credited.order.status, "PARTIAL");
  assert.equal(credited.order.creditedFiatMicros, "151000000");
  assert.deepEqual(memory.sweeps.map(({ id }) => id), ["legacy-confirmed-sweep"]);
});

test("credits aggregate exactly, retain overpayment, and remain idempotent", async () => {
  const memory = createMemoryLedgerDb();
  const ledger = createMovementLedger(memory.db);
  const gram = await ledger.recordObserved(movement());
  const first = await ledger.creditMovement({
    movementId: gram.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });

  assert.equal(first.outcome, "credited");
  assert.equal(first.movement.fiatCreditMicros, "3750000");
  assert.equal(first.order.status, "PARTIAL");
  assert.equal(first.order.creditedFiatMicros, "3750000");
  assert.equal(first.order.overpaymentFiatMicros, "0");
  const replay = await ledger.creditMovement({
    movementId: gram.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });
  assert.equal(replay.outcome, "credited");
  assert.equal(replay.allocation!.id, first.allocation?.id);
  assert.equal(memory.allocations.length, 1);

  const usdt = await ledger.recordObserved(movement({
    fingerprint: "testnet:tx-usdt:incoming:0",
    asset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    amountAtomic: "2000000",
    jettonMasterAddress: "EQ_USDT_MASTER",
    jettonWalletAddress: "EQ_DEPOSIT_USDT_WALLET",
    transactionHash: "tx-usdt",
    transactionLt: "12346",
    blockchainAt: new Date("2026-08-13T10:00:30.000Z"),
  }));
  const paid = await ledger.creditMovement({
    movementId: usdt.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "JETTON_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });

  assert.equal(paid.order.status, "PAID");
  assert.equal(paid.order.creditedFiatMicros, "5000000");
  assert.equal(paid.order.overpaymentFiatMicros, "750000");
  assert.equal(paid.order.paidAt.toISOString(), "2026-08-13T10:00:30.000Z");
  assert.equal(memory.allocations.filter(({ kind }) => kind === "CREDIT").length, 2);
  assert.equal(memory.invoices[0].status, "PAID");
  assert.equal(memory.invoices[0].creditedFiatMicros, "5000000");
  assert.equal(memory.invoices[0].remainingFiatMicros, "0");
  assert.equal(memory.invoices[0].paidAmountAtomic, "1500000000");
  assert.equal(memory.invoices[0].firstMovementAt.toISOString(), "2026-08-13T10:00:00.000Z");
  assert.deepEqual(
    memory.invoices[0].observedPayments.map(({ asset, amountAtomic }: any) => ({ asset, amountAtomic })),
    [
      { asset: "GRAM", amountAtomic: "1500000000" },
      { asset: "USDT", amountAtomic: "2000000" },
    ],
  );
});

test("an exact all-GRAM shortfall applies the immutable quote discount and closes the gross order", async () => {
  const memory = createMemoryLedgerDb();
  const ledger = createMovementLedger(memory.db);
  const gram = await ledger.recordObserved(movement({ amountAtomic: "1600000000" }));
  const paid = await ledger.creditMovement({
    movementId: gram.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });
  const replay = await ledger.creditMovement({
    movementId: gram.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });

  assert.equal(paid.order.status, "PAID");
  assert.equal(paid.order.creditedFiatMicros, "4000000");
  assert.equal(paid.order.discountFiatMicros, "1000000");
  assert.equal(memory.invoices[0].status, "PAID");
  assert.equal(memory.invoices[0].creditedFiatMicros, "4000000");
  assert.equal(memory.invoices[0].remainingFiatMicros, "0");
  assert.equal(memory.invoices[0].paymentSelectionLockedAsset, "GRAM");
  assert.equal(
    memory.invoices[0].paymentSelectionLockedAt.toISOString(),
    "2026-08-13T10:00:00.000Z",
  );
  assert.equal(memory.adjustments.length, 1);
  assert.deepEqual(
    memory.adjustments.map(({ kind, fiatAmountMicros, quoteId }: any) => ({
      kind,
      fiatAmountMicros,
      quoteId,
    })),
    [{
      kind: "PAYMENT_METHOD_DISCOUNT",
      fiatAmountMicros: "1000000",
      quoteId: "quote-gram-1",
    }],
  );
  assert.equal(replay.order.status, "PAID");
  assert.equal(memory.adjustments.length, 1);
});

test("a mixed payment or a non-GRAM selected rail never receives the GRAM-only discount", async () => {
  const mixed = createMemoryLedgerDb();
  const mixedLedger = createMovementLedger(mixed.db);
  const gram = await mixedLedger.recordObserved(movement({ amountAtomic: "1200000000" }));
  await mixedLedger.creditMovement({
    movementId: gram.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
  });
  const usdt = await mixedLedger.recordObserved(movement({
    fingerprint: "testnet:mixed-usdt:incoming:0",
    asset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    amountAtomic: "1000000",
    jettonMasterAddress: "EQ_USDT_MASTER",
    jettonWalletAddress: "EQ_DEPOSIT_USDT_WALLET",
    transactionHash: "mixed-usdt",
    transactionLt: "12346",
    blockchainAt: new Date("2026-08-13T10:00:30.000Z"),
  }));
  const mixedResult = await mixedLedger.creditMovement({
    movementId: usdt.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "JETTON_INBOUND_V1",
  });

  assert.equal(mixedResult.order.status, "PARTIAL");
  assert.equal(mixedResult.order.creditedFiatMicros, "4000000");
  assert.equal(mixedResult.order.discountFiatMicros, "0");
  assert.equal(mixed.adjustments.length, 0);

  const wrongSelection = createMemoryLedgerDb();
  wrongSelection.invoices[0].checkoutAsset = "USDT";
  const wrongSelectionLedger = createMovementLedger(wrongSelection.db);
  const wrongRailGram = await wrongSelectionLedger.recordObserved(
    movement({ amountAtomic: "1600000000" }),
  );
  const wrongSelectionResult = await wrongSelectionLedger.creditMovement({
    movementId: wrongRailGram.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
  });
  assert.equal(wrongSelectionResult.order.status, "PARTIAL");
  assert.equal(wrongSelectionResult.order.discountFiatMicros, "0");
  assert.equal(wrongSelection.invoices[0].paymentSelectionLockedAsset, "USDT");
  assert.equal(wrongSelection.adjustments.length, 0);
});

test("known later USDT evidence on another attempt prevents a transient GRAM discount", async () => {
  const memory = createMemoryLedgerDb();
  memory.invoices.push({
    ...structuredClone(memory.invoices[0]),
    id: "invoice-2",
    checkoutAsset: "USDT",
    status: "EXPIRED",
    paymentSelectionLockedAsset: null,
    paymentSelectionLockedAt: null,
    depositAddress: { id: "deposit-2" },
  });
  memory.deposits.push({ id: "deposit-2", status: "EXPIRED" });
  const ledger = createMovementLedger(memory.db);
  const gram = await ledger.recordObserved(movement({ amountAtomic: "1600000000" }));
  await ledger.recordObserved(movement({
    fingerprint: "testnet:known-later-usdt:incoming:0",
    depositAddressId: "deposit-2",
    asset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    amountAtomic: "1000000",
    toAddress: "EQ_ALTERNATE_DEPOSIT",
    jettonMasterAddress: "EQ_USDT_MASTER",
    jettonWalletAddress: "EQ_DEPOSIT_USDT_WALLET",
    transactionHash: "known-later-usdt",
    transactionLt: "12346",
    blockchainAt: new Date("2026-08-13T10:00:30.000Z"),
  }));
  const partial = await ledger.creditMovement({
    movementId: gram.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
  });

  assert.equal(partial.order.status, "PARTIAL");
  assert.equal(partial.order.discountFiatMicros, "0");
  assert.equal(memory.adjustments.length, 0);
  assert.equal(memory.recoveryCases.length, 0);
});

test("credits on multiple deposit wallets fail into recovery without consuming automatic sweep slots", async () => {
  const memory = createMemoryLedgerDb();
  memory.orders[0].maxAutomaticSweepsPerAsset = 2;
  const firstOwner = Address.parseRaw(`0:${"51".repeat(32)}`).toRawString();
  const secondOwner = Address.parseRaw(`0:${"52".repeat(32)}`).toRawString();
  Object.assign(memory.invoices[0], {
    network: "testnet",
    address: firstOwner,
    addressRaw: firstOwner,
  });
  Object.assign(memory.deposits[0], {
    network: "testnet",
    address: firstOwner,
    addressRaw: firstOwner,
  });
  const secondInvoice = {
    ...structuredClone(memory.invoices[0]),
    id: "invoice-2",
    status: "PENDING",
    paymentSelectionLockedAsset: null,
    paymentSelectionLockedAt: null,
    depositAddress: { id: "deposit-2" },
    address: secondOwner,
    addressRaw: secondOwner,
  };
  memory.invoices.push(secondInvoice);
  memory.deposits.push({
    id: "deposit-2",
    invoiceId: "invoice-2",
    network: "testnet",
    address: secondOwner,
    addressRaw: secondOwner,
    status: "ACTIVE",
  });
  const ledger = createMovementLedger(memory.db);
  const first = await ledger.recordObserved(movement({ toAddress: firstOwner }));
  await ledger.creditMovement({
    movementId: first.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });
  memory.invoices[0].status = "EXPIRED";

  const second = await ledger.recordObserved(movement({
    fingerprint: "testnet:second-funded-deposit:incoming:0",
    depositAddressId: "deposit-2",
    amountAtomic: "500000000",
    toAddress: secondOwner,
    transactionHash: "second-funded-deposit",
    transactionLt: "12346",
    blockchainAt: new Date("2026-08-13T10:01:00.000Z"),
  }));
  const recovered = await ledger.creditMovement({
    movementId: second.id,
    orderId: "order-1",
    invoiceId: "invoice-2",
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });

  assert.equal(recovered.outcome, "credited");
  assert.equal(recovered.order.status, "RECOVERY");
  assert.equal(recovered.order.creditedFiatMicros, "5000000");
  assert.equal(memory.recoveryCases.at(-1)?.reason, "MULTIPLE_FUNDED_DEPOSIT_MOVEMENT");
  assert.equal(memory.sweeps.length, 0);
});

test("a later USDT credit reverses an active GRAM-only discount before entering recovery", async () => {
  const memory = createMemoryLedgerDb();
  const ledger = createMovementLedger(memory.db);
  const gram = await ledger.recordObserved(movement({ amountAtomic: "1600000000" }));
  await ledger.creditMovement({
    movementId: gram.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
  });
  const usdt = await ledger.recordObserved(movement({
    fingerprint: "testnet:post-discount-usdt:incoming:0",
    asset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    amountAtomic: "1000000",
    jettonMasterAddress: "EQ_USDT_MASTER",
    jettonWalletAddress: "EQ_DEPOSIT_USDT_WALLET",
    transactionHash: "post-discount-usdt",
    transactionLt: "12346",
    blockchainAt: new Date("2026-08-13T10:00:30.000Z"),
  }));
  const recovered = await ledger.creditMovement({
    movementId: usdt.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "JETTON_INBOUND_V1",
  });

  assert.equal(recovered.order.status, "RECOVERY");
  assert.equal(recovered.order.creditedFiatMicros, "5000000");
  assert.equal(recovered.order.discountFiatMicros, "0");
  assert.deepEqual(
    memory.adjustments.map(({ kind, reversesAdjustmentId }: any) => ({ kind, reversesAdjustmentId })),
    [
      { kind: "PAYMENT_METHOD_DISCOUNT", reversesAdjustmentId: null },
      { kind: "REVERSAL", reversesAdjustmentId: memory.adjustments[0].id },
    ],
  );
  assert.equal(memory.recoveryCases.at(-1)?.reason, "POST_PAID_MOVEMENT");
});

test("reversing a GRAM credit first reverses its dependent payment-method discount", async () => {
  const memory = createMemoryLedgerDb();
  const ledger = createMovementLedger(memory.db);
  const gram = await ledger.recordObserved(movement({ amountAtomic: "1600000000" }));
  const paid = await ledger.creditMovement({
    movementId: gram.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
  });
  const reversed = await ledger.reverseAllocation({
    allocationId: paid.allocation!.id,
    allocatedBy: "admin",
    note: "invalid GRAM ownership evidence",
  });

  assert.equal(reversed.order.status, "RECOVERY");
  assert.equal(reversed.order.creditedFiatMicros, "0");
  assert.equal(reversed.order.discountFiatMicros, "0");
  assert.equal(memory.invoices[0].remainingFiatMicros, "5000000");
  assert.deepEqual(
    memory.adjustments.map(({ kind, reversesAdjustmentId }: any) => ({ kind, reversesAdjustmentId })),
    [
      { kind: "PAYMENT_METHOD_DISCOUNT", reversesAdjustmentId: null },
      { kind: "REVERSAL", reversesAdjustmentId: memory.adjustments[0].id },
    ],
  );
  assert.deepEqual(memory.allocations.map(({ kind }: any) => kind), ["CREDIT", "REVERSAL"]);
});

test("the selected rail locks at the first movement blockchain time even while its rate is pending", async () => {
  const memory = createMemoryLedgerDb();
  memory.rates.splice(0, memory.rates.length);
  const ledger = createMovementLedger(memory.db);
  const gram = await ledger.recordObserved(movement());
  const pending = await ledger.creditMovement({
    movementId: gram.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
  });

  assert.equal(pending.outcome, "rate-pending");
  assert.equal(memory.invoices[0].paymentSelectionLockedAsset, "GRAM");
  assert.equal(
    memory.invoices[0].paymentSelectionLockedAt.toISOString(),
    "2026-08-13T10:00:00.000Z",
  );
});

test("a legacy unlocked attempt never takes selection chronology from another attempt", async () => {
  const memory = createMemoryLedgerDb();
  memory.invoices.push({
    ...structuredClone(memory.invoices[0]),
    id: "invoice-2",
    checkoutAsset: "USDT",
    status: "EXPIRED",
    paymentSelectionLockedAsset: null,
    paymentSelectionLockedAt: null,
    depositAddress: { id: "deposit-2" },
  });
  memory.deposits.push({ id: "deposit-2", status: "EXPIRED" });
  const ledger = createMovementLedger(memory.db);
  const current = await ledger.recordObserved(movement());
  await ledger.recordObserved(movement({
    fingerprint: "testnet:legacy-selection-other-attempt:incoming:0",
    depositAddressId: "deposit-2",
    asset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    amountAtomic: "1000000",
    toAddress: "EQ_ALTERNATE_DEPOSIT",
    jettonMasterAddress: "EQ_USDT_MASTER",
    jettonWalletAddress: "EQ_DEPOSIT_USDT_WALLET",
    transactionHash: "legacy-selection-other-attempt",
    transactionLt: "12344",
    blockchainAt: new Date("2026-08-13T09:59:30.000Z"),
  }));
  memory.invoices[0].paymentSelectionLockedAsset = null;
  memory.invoices[0].paymentSelectionLockedAt = null;

  const blocked = await ledger.creditMovement({
    movementId: current.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
  });

  assert.equal(blocked.outcome, "blocked-earlier-movement");
  assert.equal(memory.invoices[0].paymentSelectionLockedAsset, "GRAM");
  assert.equal(
    memory.invoices[0].paymentSelectionLockedAt.toISOString(),
    "2026-08-13T10:00:00.000Z",
  );
});

test("the first credited GRAM rate remains locked for later GRAM partials", async () => {
  const memory = createMemoryLedgerDb();
  const ledger = createMovementLedger(memory.db);
  const first = await ledger.recordObserved(movement({ amountAtomic: "1500000000" }));
  await ledger.creditMovement({
    movementId: first.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });
  memory.rates.push({
    id: "later-rate-gram-usd",
    asset: "GRAM",
    baseCurrency: "GRAM",
    quoteCurrency: "USD",
    price: { toString: () => "5" },
    source: "coingecko",
    observedAt: new Date("2026-08-13T10:00:59.000Z"),
    fetchedAt: new Date("2026-08-13T10:01:00.000Z"),
    createdAt: new Date("2026-08-13T10:01:01.000Z"),
  });
  const second = await ledger.recordObserved(movement({
    fingerprint: "testnet:tx-gram-second:incoming:0",
    amountAtomic: "500000000",
    transactionHash: "tx-gram-second",
    transactionLt: "12347",
    blockchainAt: new Date("2026-08-13T10:02:00.000Z"),
  }));
  const paid = await ledger.creditMovement({
    movementId: second.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });

  assert.equal(paid.movement.rateSnapshotId, "rate-gram-usd");
  assert.equal(paid.movement.fiatCreditMicros, "1250000");
  assert.equal(paid.order.status, "PAID");
  assert.equal(paid.order.overpaymentFiatMicros, "0");
});

test("a later movement cannot become the first credit while earlier blockchain evidence is unresolved", async () => {
  const memory = createMemoryLedgerDb();
  const ledger = createMovementLedger(memory.db);
  const earlier = await ledger.recordObserved(movement({ amountAtomic: "1000000000" }));
  const later = await ledger.recordObserved(movement({
    fingerprint: "testnet:tx-later-usdt:incoming:0",
    asset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    amountAtomic: "3000000",
    jettonMasterAddress: "EQ_USDT_MASTER",
    jettonWalletAddress: "EQ_DEPOSIT_USDT_WALLET",
    transactionHash: "tx-later-usdt",
    transactionLt: "12346",
    blockchainAt: new Date("2026-08-13T10:00:30.000Z"),
  }));
  const blocked = await ledger.creditMovement({
    movementId: later.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "JETTON_INBOUND_V1",
  });

  assert.equal(blocked.outcome, "blocked-earlier-movement");
  assert.equal(memory.allocations.length, 0);
  await ledger.creditMovement({
    movementId: earlier.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
  });
  const paid = await ledger.creditMovement({
    movementId: later.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "JETTON_INBOUND_V1",
  });

  assert.equal(paid.outcome, "credited");
  assert.equal(paid.order.status, "PAID");
});

test("a late-discovered earlier movement is credited only into recovery and rewrites chronology from blockchain time", async () => {
  const memory = createMemoryLedgerDb();
  const ledger = createMovementLedger(memory.db);
  const later = await ledger.recordObserved(movement({
    fingerprint: "testnet:later-usdt-first:incoming:0",
    asset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    amountAtomic: "2000000",
    jettonMasterAddress: "EQ_USDT_MASTER",
    jettonWalletAddress: "EQ_DEPOSIT_USDT_WALLET",
    transactionHash: "later-usdt-first",
    transactionLt: "20002",
    blockchainAt: new Date("2026-08-13T10:04:00.000Z"),
  }));
  await ledger.creditMovement({
    movementId: later.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "JETTON_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });
  const earlier = await ledger.recordObserved(movement({
    fingerprint: "testnet:earlier-usdt-late:incoming:0",
    asset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    amountAtomic: "1000000",
    jettonMasterAddress: "EQ_USDT_MASTER",
    jettonWalletAddress: "EQ_DEPOSIT_USDT_WALLET",
    transactionHash: "earlier-usdt-late",
    transactionLt: "20001",
    blockchainAt: new Date("2026-08-13T10:01:00.000Z"),
  }));
  const recovered = await ledger.creditMovement({
    movementId: earlier.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "JETTON_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });

  assert.equal(recovered.order.status, "RECOVERY");
  assert.equal(recovered.order.creditedFiatMicros, "3000000");
  assert.equal(memory.invoices[0].status, "EXPIRED");
  assert.equal(memory.invoices[0].firstMovementAt.toISOString(), "2026-08-13T10:01:00.000Z");
  assert.equal(memory.invoices[0].partialPaymentStartedAt.toISOString(), "2026-08-13T10:01:00.000Z");
  assert.equal(memory.invoices[0].partialPaymentExpiresAt.toISOString(), "2026-08-14T10:01:00.000Z");
  assert.equal(memory.invoices[0].settlementReason, "OUT_OF_ORDER_MOVEMENT_RECOVERY");
  assert.equal(memory.recoveryCases[0]?.reason, "OUT_OF_ORDER_MOVEMENT");
});

test("an incoming movement after the blockchain payment point is accounted only in recovery", async () => {
  const memory = createMemoryLedgerDb();
  const ledger = createMovementLedger(memory.db);
  const payment = await ledger.recordObserved(movement({
    fingerprint: "testnet:paid-usdt:incoming:0",
    asset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    amountAtomic: "5000000",
    jettonMasterAddress: "EQ_USDT_MASTER",
    jettonWalletAddress: "EQ_DEPOSIT_USDT_WALLET",
    transactionHash: "paid-usdt",
    transactionLt: "30001",
  }));
  const paid = await ledger.creditMovement({
    movementId: payment.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "JETTON_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });
  assert.equal(paid.order.status, "PAID");

  const afterPaid = await ledger.recordObserved(movement({
    fingerprint: "testnet:post-paid-usdt:incoming:0",
    asset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    amountAtomic: "1000000",
    jettonMasterAddress: "EQ_USDT_MASTER",
    jettonWalletAddress: "EQ_DEPOSIT_USDT_WALLET",
    transactionHash: "post-paid-usdt",
    transactionLt: "30002",
    blockchainAt: new Date("2026-08-13T10:01:00.000Z"),
  }));
  const recovered = await ledger.creditMovement({
    movementId: afterPaid.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "JETTON_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });

  assert.equal(recovered.order.status, "RECOVERY");
  assert.equal(recovered.order.creditedFiatMicros, "5000000");
  assert.equal(recovered.order.overpaymentFiatMicros, "1000000");
  assert.equal(memory.invoices[0].status, "PAID");
  assert.equal(memory.invoices[0].observedTransactionHash, "paid-usdt");
  assert.equal(memory.invoices[0].settlementReason, "POST_PAID_MOVEMENT_RECOVERY");
  assert.equal(memory.recoveryCases[0]?.reason, "POST_PAID_MOVEMENT");
});

test("undersized partials accumulate, activate together, and then bypass the initial threshold", async () => {
  const memory = createMemoryLedgerDb();
  memory.invoices[0].activationThresholdFiatMicros = "2500000";
  const ledger = createMovementLedger(memory.db);
  const undersized = await ledger.recordObserved(movement({ amountAtomic: "500000000" }));
  const held = await ledger.creditMovement({
    movementId: undersized.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });

  assert.equal(held.outcome, "held-under-minimum");
  assert.equal(held.movement.fiatCreditMicros, "1250000");
  assert.equal(memory.allocations.length, 0);
  assert.equal(memory.orders[0].status, "PENDING");
  assert.equal(memory.invoices[0].status, "PENDING");
  assert.equal(memory.recoveryCases[0]?.reason, "INITIAL_PAYMENT_UNDER_MINIMUM");

  const qualifying = await ledger.recordObserved(movement({
    fingerprint: "testnet:tx-qualifying:incoming:0",
    amountAtomic: "1000000000",
    transactionHash: "tx-qualifying",
    transactionLt: "12348",
    blockchainAt: new Date("2026-08-13T10:01:00.000Z"),
  }));
  await ledger.creditMovement({
    movementId: qualifying.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });
  const smallFollowup = await ledger.recordObserved(movement({
    fingerprint: "testnet:tx-small-followup:incoming:0",
    amountAtomic: "100000000",
    transactionHash: "tx-small-followup",
    transactionLt: "12349",
    blockchainAt: new Date("2026-08-13T10:02:00.000Z"),
  }));
  const followed = await ledger.creditMovement({
    movementId: smallFollowup.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });

  assert.equal(followed.outcome, "credited");
  assert.equal(followed.movement.fiatCreditMicros, "250000");
  assert.equal(memory.orders[0].creditedFiatMicros, "4000000");
  assert.equal(memory.allocations.length, 3);
  assert.equal(memory.movements[0]?.status, "CREDITED");
  assert.equal(memory.recoveryCases[0]?.status, "RESOLVED");
  assert.equal(memory.invoices[0].partialPaymentStartedAt.toISOString(), "2026-08-13T10:00:00.000Z");
  assert.equal(memory.invoices[0].partialPaymentExpiresAt.toISOString(), "2026-08-14T10:00:00.000Z");
});

test("mixed held movements retain their own asset rates until cumulative activation", async () => {
  const memory = createMemoryLedgerDb();
  memory.invoices[0].activationThresholdFiatMicros = "4000000";
  const ledger = createMovementLedger(memory.db);
  const gram = await ledger.recordObserved(movement({ amountAtomic: "500000000" }));
  assert.equal((await ledger.creditMovement({
    movementId: gram.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
  })).outcome, "held-under-minimum");

  const usdt = await ledger.recordObserved(movement({
    fingerprint: "testnet:held-usdt:incoming:0",
    asset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    amountAtomic: "1000000",
    jettonMasterAddress: "EQ_USDT_MASTER",
    jettonWalletAddress: "EQ_DEPOSIT_USDT_WALLET",
    transactionHash: "held-usdt",
    transactionLt: "12346",
    blockchainAt: new Date("2026-08-13T10:01:00.000Z"),
  }));
  const heldUsdt = await ledger.creditMovement({
    movementId: usdt.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "JETTON_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });
  assert.equal(heldUsdt.outcome, "held-under-minimum");
  assert.equal(heldUsdt.movement.rateSnapshotId, "rate-usdt-usd");
  assert.equal(heldUsdt.movement.fiatCreditMicros, "1000000");
  assert.equal(memory.allocations.length, 0);

  const finalGram = await ledger.recordObserved(movement({
    fingerprint: "testnet:held-final-gram:incoming:0",
    amountAtomic: "700000000",
    transactionHash: "held-final-gram",
    transactionLt: "12347",
    blockchainAt: new Date("2026-08-13T10:02:00.000Z"),
  }));
  const activated = await ledger.creditMovement({
    movementId: finalGram.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });

  assert.equal(activated.outcome, "credited");
  assert.equal(activated.order.status, "PARTIAL");
  assert.equal(activated.order.creditedFiatMicros, "4000000");
  assert.equal(memory.allocations.length, 3);
  assert.equal(memory.movements.find(({ id }) => id === usdt.id)?.status, "CREDITED");
  assert.equal(memory.movements.find(({ id }) => id === usdt.id)?.rateSnapshotId, "rate-usdt-usd");
  assert.equal(memory.movements.find(({ id }) => id === usdt.id)?.fiatCreditMicros, "1000000");
});

test("mainnet credit waits for both scanner horizons and any active scanner lease", async () => {
  const memory = createMemoryLedgerDb();
  memory.invoices[0].network = "mainnet";
  memory.invoices[0].activationThresholdFiatMicros = "2500000";
  memory.deposits[0].network = "mainnet";
  const ledger = createMovementLedger(memory.db);
  const observed = await ledger.recordObserved(movement({ network: "mainnet" }));
  const settlementAt = new Date("2099-01-01T00:00:00.000Z");
  const credit = () => ledger.creditMovement({
    movementId: observed.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
    scannerSettlementHorizonMs: 60_000,
    settlementAt,
  });

  assert.equal((await credit()).outcome, "awaiting-scan-horizon");
  memory.scanCursors.push({
    id: "cursor-gram",
    network: "mainnet",
    streamType: "GRAM_NATIVE_IN",
    scopeKey: "deposit-1",
    scannedThroughAt: new Date("2026-08-13T10:01:00.000Z"),
    leaseOwner: null,
    leaseExpiresAt: null,
  });
  assert.equal((await credit()).outcome, "awaiting-scan-horizon");
  memory.scanCursors.push({
    id: "cursor-usdt",
    network: "mainnet",
    streamType: "USDT_MAINNET_IN",
    scopeKey: "deposit-1",
    scannedThroughAt: new Date("2026-08-13T10:00:59.999Z"),
    leaseOwner: null,
    leaseExpiresAt: null,
  });
  assert.equal((await credit()).outcome, "awaiting-scan-horizon");
  memory.scanCursors[1].scannedThroughAt = new Date("2026-08-13T10:01:00.000Z");
  memory.scanCursors[1].leaseOwner = "usdt-scanner";
  memory.scanCursors[1].leaseExpiresAt = new Date("2026-08-13T10:00:05.001Z");
  assert.equal((await credit()).outcome, "awaiting-scan-horizon");
  assert.equal(memory.allocations.length, 0);

  memory.scanCursors[1].leaseExpiresAt = new Date("2026-08-13T10:00:05.000Z");
  const credited = await credit();
  assert.equal(credited.outcome, "credited");
  assert.equal(memory.allocations.length, 1);
});

test("an expired autonomous scanner lease cannot journal another movement", async () => {
  const memory = createMemoryLedgerDb();
  memory.invoices[0].network = "mainnet";
  memory.deposits[0].network = "mainnet";
  memory.scanCursors.push({
    id: "cursor-expired",
    network: "mainnet",
    streamType: "GRAM_NATIVE_IN",
    scopeKey: "deposit-1",
    scannedThroughAt: null,
    leaseOwner: "expired-scanner",
    leaseExpiresAt: new Date("2026-08-13T10:00:05.000Z"),
  });
  const ledger = createMovementLedger(memory.db);

  await assert.rejects(ledger.recordObserved(
    movement({ network: "mainnet" }),
    {
      streamType: "GRAM_NATIVE_IN",
      leaseOwner: "expired-scanner",
      clock: () => new Date("2026-08-13T10:00:05.000Z"),
    },
  ), /scanner lease expired or was lost/);
  assert.equal(memory.movements.length, 0);
  assert.equal(memory.invoices[0].paymentSelectionLockedAsset, null);
});

test("an active autonomous scanner lease journals with the database clock fence", async () => {
  const memory = createMemoryLedgerDb();
  memory.invoices[0].network = "mainnet";
  memory.deposits[0].network = "mainnet";
  memory.scanCursors.push({
    id: "cursor-active",
    network: "mainnet",
    streamType: "GRAM_NATIVE_IN",
    scopeKey: "deposit-1",
    scannedThroughAt: null,
    leaseOwner: "active-scanner",
    leaseExpiresAt: new Date("2026-08-13T10:00:05.001Z"),
  });
  const ledger = createMovementLedger(memory.db);

  const observed = await ledger.recordObserved(
    movement({ network: "mainnet" }),
    {
      streamType: "GRAM_NATIVE_IN",
      leaseOwner: "active-scanner",
      clock: () => new Date("2026-08-13T09:00:00.000Z"),
    },
  );

  assert.equal(observed.status, "OBSERVED");
  assert.equal(memory.movements.length, 1);
  assert.equal(memory.invoices[0].paymentSelectionLockedAsset, "GRAM");
});

test("a movement after the active payment window is accounted only in recovery", async () => {
  const memory = createMemoryLedgerDb();
  memory.rates.push({
    id: "late-rate-gram-usd",
    asset: "GRAM",
    baseCurrency: "GRAM",
    quoteCurrency: "USD",
    price: { toString: () => "2.5" },
    source: "coingecko",
    observedAt: new Date("2026-08-13T10:59:59.000Z"),
    fetchedAt: new Date("2026-08-13T11:00:00.000Z"),
    createdAt: new Date("2026-08-13T11:00:00.500Z"),
  });
  const ledger = createMovementLedger(memory.db);
  const late = await ledger.recordObserved(movement({
    amountAtomic: "2500000000",
    blockchainAt: new Date("2026-08-13T11:00:01.000Z"),
  }));
  const recovered = await ledger.creditMovement({
    movementId: late.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });

  assert.equal(recovered.outcome, "credited");
  assert.equal(recovered.order.status, "RECOVERY");
  assert.equal(memory.invoices[0].status, "EXPIRED");
  assert.equal(memory.invoices[0].settlementReason, "LATE_MOVEMENT_RECOVERY");
  assert.equal(memory.recoveryCases[0]?.reason, "LATE_MOVEMENT");
});

test("a payment made before TTL remains payable when scanners discover it after TTL", async () => {
  const memory = createMemoryLedgerDb();
  memory.rates.push({
    id: "pre-expiry-rate-gram-usd",
    asset: "GRAM",
    baseCurrency: "GRAM",
    quoteCurrency: "USD",
    price: { toString: () => "2.5" },
    source: "coingecko",
    observedAt: new Date("2026-08-13T10:59:30.000Z"),
    fetchedAt: new Date("2026-08-13T10:59:31.000Z"),
    createdAt: new Date("2026-08-13T10:59:31.500Z"),
  });
  const ledger = createMovementLedger(memory.db);
  const observed = await ledger.recordObserved(movement({
    amountAtomic: "2000000000",
    blockchainAt: new Date("2026-08-13T10:59:59.000Z"),
  }));
  const paid = await ledger.creditMovement({
    movementId: observed.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
    settlementAt: new Date("2026-08-13T11:30:00.000Z"),
  });

  assert.equal(paid.outcome, "credited");
  assert.equal(paid.order.status, "PAID");
  assert.equal(memory.invoices[0].status, "PAID");
  assert.equal(memory.recoveryCases.length, 0);
});

test("rate lookup never looks ahead, parks stale evidence, and can retry", async () => {
  const memory = createMemoryLedgerDb();
  memory.rates.splice(0, memory.rates.length, {
    id: "future-rate",
    asset: "GRAM",
    baseCurrency: "GRAM",
    quoteCurrency: "USD",
    price: { toString: () => "2.5" },
    source: "coingecko",
    observedAt: new Date("2026-08-13T10:00:01.000Z"),
    fetchedAt: new Date("2026-08-13T10:00:02.000Z"),
    createdAt: new Date("2026-08-13T10:00:03.000Z"),
  }, {
    id: "stale-rate",
    asset: "GRAM",
    baseCurrency: "GRAM",
    quoteCurrency: "USD",
    price: { toString: () => "2.4" },
    source: "coingecko",
    observedAt: new Date("2026-08-13T09:50:00.000Z"),
    fetchedAt: new Date("2026-08-13T09:50:01.000Z"),
    createdAt: new Date("2026-08-13T09:50:02.000Z"),
  });
  const ledger = createMovementLedger(memory.db);
  const observed = await ledger.recordObserved(movement());
  const pending = await ledger.creditMovement({
    movementId: observed.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });

  assert.equal(pending.outcome, "rate-pending");
  assert.equal(pending.movement.status, "RATE_PENDING");
  assert.equal(memory.allocations.length, 0);
  memory.rates.push({
    id: "historical-rate",
    asset: "GRAM",
    baseCurrency: "GRAM",
    quoteCurrency: "USD",
    price: { toString: () => "2.5" },
    source: "coingecko",
    observedAt: new Date("2026-08-13T09:59:59.000Z"),
    fetchedAt: new Date("2026-08-13T09:59:59.500Z"),
    createdAt: new Date("2026-08-13T10:00:04.000Z"),
  });
  const credited = await ledger.creditMovement({
    movementId: observed.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });

  assert.equal(credited.outcome, "credited");
  assert.equal(credited.movement.rateSnapshotId, "historical-rate");
});

test("a compensating reversal is append-only, idempotent, and moves the order to recovery", async () => {
  const memory = createMemoryLedgerDb();
  const ledger = createMovementLedger(memory.db);
  const observed = await ledger.recordObserved(movement({ amountAtomic: "2500000000" }));
  const credit = await ledger.creditMovement({
    movementId: observed.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });
  assert.equal(credit.order.status, "PAID");
  assert.equal(credit.order.overpaymentFiatMicros, "1250000");

  const reversed = await ledger.reverseAllocation({
    allocationId: credit.allocation!.id,
    allocatedBy: "admin",
    note: "incorrect ownership evidence",
  });
  const replay = await ledger.reverseAllocation({
    allocationId: credit.allocation!.id,
    allocatedBy: "admin",
    note: "incorrect ownership evidence",
  });

  assert.equal(reversed.reversal.id, replay.reversal.id);
  assert.equal(reversed.order.status, "RECOVERY");
  assert.equal(reversed.order.creditedFiatMicros, "0");
  assert.equal(reversed.order.overpaymentFiatMicros, "0");
  assert.equal(memory.invoices[0].status, "FAILED");
  assert.equal(memory.invoices[0].creditedFiatMicros, "0");
  assert.equal(memory.invoices[0].settlementReason, "ALLOCATION_REVERSED_RECOVERY");
  assert.equal(memory.recoveryCases[0]?.reason, "ALLOCATION_REVERSED");
  assert.deepEqual(memory.allocations.map(({ kind }) => kind), ["CREDIT", "REVERSAL"]);
  assert.equal(memory.movements[0]?.status, "CREDITED");
  await assert.rejects(
    ledger.reverseAllocation({
      allocationId: credit.allocation!.id,
      allocatedBy: "another-admin",
      note: "different reason",
    }),
    /different audit evidence/,
  );
});

test("a late terminal-order payment is accounted in recovery and invalid peg evidence is rejected", async () => {
  const memory = createMemoryLedgerDb();
  memory.orders[0].status = "EXPIRED";
  memory.rates.push({
    id: "late-rate-usdt-usd",
    asset: "USDT",
    baseCurrency: "USDT",
    quoteCurrency: "USD",
    price: { toString: () => "0.99" },
    source: "usd-peg",
    observedAt: new Date("2026-08-13T10:59:30.000Z"),
    fetchedAt: new Date("2026-08-13T10:59:30.000Z"),
    createdAt: new Date("2026-08-13T10:59:31.000Z"),
    payload: { policy: "1 USDT = 1 USD" },
  });
  const ledger = createMovementLedger(memory.db);
  const observed = await ledger.recordObserved(movement({
    fingerprint: "testnet:late-usdt:incoming:0",
    asset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    amountAtomic: "5000000",
    jettonMasterAddress: "EQ_USDT_MASTER",
    jettonWalletAddress: "EQ_DEPOSIT_USDT_WALLET",
    transactionHash: "late-usdt",
    blockchainAt: new Date("2026-08-13T11:00:30.000Z"),
  }));
  await assert.rejects(
    ledger.creditMovement({
      movementId: observed.id,
      orderId: "order-1",
      invoiceId: "invoice-1",
      validationCode: "JETTON_INBOUND_V1",
      maxRateAgeMs: 300_000,
    }),
    /exact 1 USDT = 1 USD policy/,
  );
  assert.equal(memory.movements[0]?.status, "OBSERVED");
  memory.rates.find(({ id }) => id === "late-rate-usdt-usd").price = { toString: () => "1" };
  const recovered = await ledger.creditMovement({
    movementId: observed.id,
    orderId: "order-1",
    invoiceId: "invoice-1",
    validationCode: "JETTON_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });

  assert.equal(recovered.order.status, "RECOVERY");
  assert.equal(recovered.order.creditedFiatMicros, "5000000");
  assert.equal(recovered.order.overpaymentFiatMicros, "0");
});

test("legacy materialized credit cannot be silently overwritten without allocation backfill", async () => {
  const memory = createMemoryLedgerDb();
  memory.orders[0].creditedFiatMicros = "1250000";
  memory.orders[0].status = "PARTIAL";
  const ledger = createMovementLedger(memory.db);
  const observed = await ledger.recordObserved(movement());

  await assert.rejects(
    ledger.creditMovement({
      movementId: observed.id,
      orderId: "order-1",
      invoiceId: "invoice-1",
      validationCode: "NATIVE_INBOUND_V1",
      maxRateAgeMs: 300_000,
    }),
    /accounting is not backed by movement allocations/,
  );
  assert.equal(memory.orders[0].creditedFiatMicros, "1250000");
  assert.equal(memory.movements[0].status, "OBSERVED");
  assert.equal(memory.allocations.length, 0);
});

test("automatic credit cannot bypass deposit ownership by omitting or changing invoice", async () => {
  const memory = createMemoryLedgerDb();
  memory.invoices.push({
    id: "invoice-2",
    orderId: "other-order",
    depositAddress: { id: "deposit-1" },
  });
  const ledger = createMovementLedger(memory.db);
  const observed = await ledger.recordObserved(movement());

  await assert.rejects(
    ledger.creditMovement({
      movementId: observed.id,
      orderId: "order-1",
      invoiceId: null as any,
      validationCode: "NATIVE_INBOUND_V1",
      maxRateAgeMs: 300_000,
    }),
    /Allocation invoiceId is required/,
  );
  await assert.rejects(
    ledger.creditMovement({
      movementId: observed.id,
      orderId: "order-1",
      invoiceId: "invoice-2",
      validationCode: "NATIVE_INBOUND_V1",
      maxRateAgeMs: 300_000,
    }),
    /invoice does not belong to the order/,
  );
  assert.equal(memory.movements[0].status, "OBSERVED");
  assert.equal(memory.allocations.length, 0);
});
