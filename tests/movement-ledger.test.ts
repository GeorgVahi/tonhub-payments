import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateActivationThresholdFiatMicros,
  calculateMovementFiatMicros,
  createMovementLedger,
  MovementFingerprintConflictError,
  type PaymentMovementDraft,
} from "../backend/src/movement-ledger";

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
  const orders: any[] = [{
    id: "order-1",
    externalId: "merchant-order-1",
    fiatAmountMicros: "5000000",
    fiatCurrency: "USD",
    creditedFiatMicros: "0",
    overpaymentFiatMicros: "0",
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
  const deposits: any[] = [{ id: "deposit-1", status: "ACTIVE" }];
  const recoveryCases: any[] = [];
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
  let clock = 0;
  const now = () => new Date(1_786_617_600_000 + clock++ * 1_000);
  const db: any = {
    $transaction: async (handler: (tx: any) => Promise<unknown>) => {
      const snapshot = structuredClone({ movements, allocations, orders, invoices, deposits, recoveryCases });
      try {
        return await handler(db);
      } catch (error) {
        movements.splice(0, movements.length, ...snapshot.movements);
        allocations.splice(0, allocations.length, ...snapshot.allocations);
        orders.splice(0, orders.length, ...snapshot.orders);
        invoices.splice(0, invoices.length, ...snapshot.invoices);
        deposits.splice(0, deposits.length, ...snapshot.deposits);
        recoveryCases.splice(0, recoveryCases.length, ...snapshot.recoveryCases);
        throw error;
      }
    },
    $queryRawUnsafe: async () => [],
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
      findMany: async ({ where }: any) => movements.filter((row) => matches(row, where)),
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
    },
    tonhubDepositAddress: {
      updateMany: async ({ where, data }: any) => {
        const rows = deposits.filter((row) => matches(row, where));
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      },
    },
    tonhubRecoveryCase: {
      createMany: async ({ data, skipDuplicates }: any) => {
        const duplicate = recoveryCases.some((row) =>
          row.movementId === data.movementId && row.reason === data.reason);
        if (duplicate && skipDuplicates) {
          return { count: 0 };
        }
        recoveryCases.push({ id: `recovery-${recoveryCases.length + 1}`, status: "OPEN", ...data });
        return { count: 1 };
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
  return { db, movements, allocations, orders, invoices, deposits, recoveryCases, rates };
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
  await assert.rejects(
    ledger.recordObserved(movement({ amountAtomic: "1600000000" })),
    MovementFingerprintConflictError,
  );
  assert.equal(memory.movements.length, 1);
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

test("an undersized first partial is held for recovery while later partials bypass the initial threshold", async () => {
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
  assert.equal(memory.orders[0].creditedFiatMicros, "2750000");
  assert.equal(memory.invoices[0].partialPaymentStartedAt.toISOString(), "2026-08-13T10:01:00.000Z");
  assert.equal(memory.invoices[0].partialPaymentExpiresAt.toISOString(), "2026-08-14T10:01:00.000Z");
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
