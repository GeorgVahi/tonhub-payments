import assert from "node:assert/strict";
import test from "node:test";
import {
  TonhubOrderTermsMismatchError,
  createPrismaTonhubPaymentRepository,
} from "../backend/src/repository";
import { createTonhubPaymentInvoice } from "../backend/src/payments";
import type { TonUniqueDepositAddress } from "../backend/src/ton/deposit-addresses";
import type { TonhubRateQuote } from "../backend/src/types";

type Row = Record<string, any>;

function matchesWhere(row: Row, where: Row | undefined) {
  if (!where) {
    return true;
  }

  return Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === "object" && "in" in expected) {
      return expected.in.includes(row[key]);
    }

    return row[key] === expected;
  });
}

function createMemoryPrisma() {
  const orders: Row[] = [];
  const invoices: Row[] = [];
  const depositAddresses: Row[] = [];
  const transactions: Row[] = [];
  let sequence = 0;
  let nextInvoiceCreateHook: ((data: Row) => never) | null = null;
  let nextInvoiceFindHook: ((row: Row | null) => Promise<Row | null>) | null = null;

  const nextId = (prefix: string) => `${prefix}-${++sequence}`;
  const hydrateInvoice = (row: Row | undefined) => row
    ? {
        ...row,
        order: row.orderId
          ? orders.find((candidate) => candidate.id === row.orderId) ?? null
          : null,
      }
    : null;
  const updateMany = (rows: Row[], input: Row) => {
    const selected = rows.filter((row) => matchesWhere(row, input.where));
    for (const row of selected) {
      for (const [key, value] of Object.entries(input.data)) {
        row[key] = value && typeof value === "object" && "increment" in value
          ? (row[key] ?? 0) + value.increment
          : value;
      }
      row.updatedAt = new Date("2026-08-13T10:01:00.000Z");
    }
    return { count: selected.length };
  };

  const db: any = {
    $transaction: async (handler: (tx: any) => Promise<unknown>) => handler(db),
    tonhubPaymentOrder: {
      findUnique: async ({ where }: Row) =>
        orders.find((row) => matchesWhere(row, where)) ?? null,
      create: async ({ data }: Row) => {
        const row = {
          id: nextId("order"),
          creditedFiatMicros: "0",
          overpaymentFiatMicros: "0",
          status: "PENDING",
          createdAt: data.createdAt ?? new Date("2026-08-13T10:00:00.000Z"),
          updatedAt: data.createdAt ?? new Date("2026-08-13T10:00:00.000Z"),
          ...data,
        };
        orders.push(row);
        return row;
      },
      upsert: async ({ where, create }: Row) => {
        const existing = orders.find((row) => matchesWhere(row, where));
        if (existing) {
          return existing;
        }
        return db.tonhubPaymentOrder.create({ data: create });
      },
      updateMany: async (input: Row) => updateMany(orders, input),
    },
    tonhubPaymentInvoice: {
      findUnique: async ({ where }: Row) => {
        const row = hydrateInvoice(invoices.find((candidate) => matchesWhere(candidate, where)));
        if (!nextInvoiceFindHook) {
          return row;
        }
        const hook = nextInvoiceFindHook;
        nextInvoiceFindHook = null;
        return hook(row ? { ...row } : null);
      },
      findFirst: async ({ where }: Row) => {
        const selected = invoices
          .filter((row) => matchesWhere(row, where))
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
        return hydrateInvoice(selected[0]);
      },
      findMany: async ({ where }: Row) => invoices
        .filter((row) => matchesWhere(row, where))
        .map((row) => hydrateInvoice(row)),
      create: async ({ data }: Row) => {
        if (nextInvoiceCreateHook) {
          const hook = nextInvoiceCreateHook;
          nextInvoiceCreateHook = null;
          return hook(data);
        }
        const row = {
          id: nextId("invoice"),
          createdAt: data.createdAt ?? new Date("2026-08-13T10:00:00.000Z"),
          updatedAt: data.createdAt ?? new Date("2026-08-13T10:00:00.000Z"),
          version: 0,
          ...data,
        };
        invoices.push(row);
        return hydrateInvoice(row);
      },
      updateMany: async (input: Row) => updateMany(invoices, input),
    },
    tonhubDepositAddress: {
      create: async ({ data }: Row) => {
        const row = { id: nextId("deposit"), ...data };
        depositAddresses.push(row);
        return row;
      },
      updateMany: async (input: Row) => updateMany(depositAddresses, input),
    },
    tonhubPaymentTransaction: {
      create: async ({ data }: Row) => {
        const row = { id: nextId("transaction"), ...data };
        transactions.push(row);
        return row;
      },
    },
  };

  return {
    db,
    orders,
    invoices,
    depositAddresses,
    transactions,
    onNextInvoiceCreate(hook: (data: Row) => never) {
      nextInvoiceCreateHook = hook;
    },
    onNextInvoiceFind(hook: (row: Row | null) => Promise<Row | null>) {
      nextInvoiceFindHook = hook;
    },
  };
}

const createdAt = new Date("2026-08-13T10:00:00.000Z");
const quote: TonhubRateQuote = {
  source: "coingecko",
  asset: "GRAM",
  assetDecimals: 9,
  fiatPerAsset: 2.47,
  amountAtomic: "2030000000",
  amountFormatted: "2.03 GRAM (ex TON)",
  fiatAmountCents: 500,
  fiatAmount: 5,
  fiatCurrency: "USD",
  fiatPerGram: 2.47,
  fiatPerTon: 2.47,
  amountNano: "2030000000",
  amountGram: "2.03 GRAM (ex TON)",
  amountTon: "2.03 GRAM (ex TON)",
  updatedAt: new Date("2026-08-13T09:59:00.000Z"),
  fetchedAt: createdAt,
};
const depositAddress: TonUniqueDepositAddress = {
  network: "testnet",
  address: "EQ_ORDER_ATTEMPT",
  addressRaw: "0:order-attempt",
  addressStrategy: "unique-address",
  walletVersion: "v5r1",
  walletWorkchain: 0,
  walletContext: 101,
  walletNetworkGlobalId: -3,
  walletPublicKeyHash: "order-attempt-key",
};

function pendingInput(externalId = "merchant-order-1") {
  return {
    externalId,
    amountCents: 500,
    currency: "USD",
    network: "testnet" as const,
    depositAddress,
    reference: `ORDER-${externalId}`,
    quote,
    metadata: { customerId: "customer-1" },
    createdAt,
    expiresAt: new Date("2026-08-13T11:00:00.000Z"),
    priceLockedAt: createdAt,
    priceLockedUntil: new Date("2026-08-13T11:00:00.000Z"),
    activationThresholdFiatMicros: "2500000",
  };
}

test("new invoices dual-write one order and one active attempt", async () => {
  const memory = createMemoryPrisma();
  const repository = createPrismaTonhubPaymentRepository(memory.db);

  const first = await repository.createPendingInvoice(pendingInput());
  const duplicate = await repository.createPendingInvoice({
    ...pendingInput(),
    depositAddress: { ...depositAddress, address: "EQ_UNUSED_DUPLICATE" },
    reference: "ORDER-DUPLICATE",
  });

  assert.equal(first.id, duplicate.id);
  assert.equal(first.externalId, "merchant-order-1");
  assert.equal(first.orderId, memory.orders[0]?.id);
  assert.equal(memory.orders.length, 1);
  assert.equal(memory.invoices.length, 1);
  assert.equal(memory.depositAddresses.length, 1);
  assert.equal(memory.invoices[0]?.externalId, null);
  assert.equal(memory.invoices[0]?.fiatAmountMicros, "5000000");
  assert.equal(memory.invoices[0]?.amountAtomic, quote.amountNano);
  assert.equal(memory.invoices[0]?.paidAmountAtomic, "0");
  assert.equal(memory.invoices[0]?.checkoutAsset, "GRAM");
  assert.equal(memory.invoices[0]?.activationThresholdFiatMicros, "2500000");
});

test("an unlinked legacy invoice remains readable during rollout", async () => {
  const memory = createMemoryPrisma();
  const repository = createPrismaTonhubPaymentRepository(memory.db);
  const created = await repository.createPendingInvoice(pendingInput("legacy-readable"));
  memory.orders.splice(0);
  Object.assign(memory.invoices[0]!, {
    orderId: null,
    externalId: "legacy-readable",
    fiatAmountMicros: null,
    amountAtomic: null,
    paidAmountAtomic: null,
  });

  const byId = await repository.findInvoiceById(created.id);
  const reusable = await repository.findReusableInvoice({
    externalId: "legacy-readable",
    network: "testnet",
    amountCents: 500,
    currency: "USD",
  });

  assert.equal(byId?.externalId, "legacy-readable");
  assert.equal(byId?.order, null);
  assert.equal(byId?.fiatAmountMicros, "5000000");
  assert.equal(byId?.amountAtomic, quote.amountNano);
  assert.equal(reusable?.id, created.id);
  assert.ok(reusable?.orderId);
  assert.equal(memory.orders.length, 1);
});

test("a funded unlinked invoice creates an order without double-counting its credit", async () => {
  const memory = createMemoryPrisma();
  const repository = createPrismaTonhubPaymentRepository(memory.db);
  const created = await repository.createPendingInvoice(pendingInput("legacy-funded-no-order"));
  memory.orders.splice(0);
  Object.assign(memory.invoices[0]!, {
    orderId: null,
    externalId: "legacy-funded-no-order",
    status: "EXPIRED",
    paidNano: "500000000",
    paidAmountAtomic: null,
    creditedFiatMicros: undefined,
    observedAt: new Date("2026-08-13T10:30:00.000Z"),
  });

  await assert.rejects(
    repository.findReusableInvoice({
      externalId: "legacy-funded-no-order",
      network: "mainnet",
      amountCents: 500,
      currency: "USD",
    }),
    /cannot create a new payment attempt while it is RECOVERY/,
  );

  assert.equal(memory.orders.length, 1);
  assert.equal(memory.orders[0]?.creditedFiatMicros, "1231527");
  assert.equal(memory.invoices[0]?.orderId, memory.orders[0]?.id);
  assert.equal(memory.invoices[0]?.id, created.id);
});

test("a cross-network duplicate reuses an unlinked legacy attempt by global external id", async () => {
  const memory = createMemoryPrisma();
  const repository = createPrismaTonhubPaymentRepository(memory.db);
  const created = await repository.createPendingInvoice(pendingInput("legacy-cross-network"));
  memory.orders.splice(0);
  Object.assign(memory.invoices[0]!, {
    orderId: null,
    externalId: "legacy-cross-network",
  });

  const reusable = await repository.findReusableInvoice({
    externalId: "legacy-cross-network",
    network: "mainnet",
    amountCents: 500,
    currency: "USD",
  });

  assert.equal(reusable?.id, created.id);
  assert.equal(reusable?.network, "testnet");
  assert.ok(reusable?.orderId);
  assert.equal(memory.orders.length, 1);
});

test("orphan cancelled and failed attempts keep their order terminal", async () => {
  for (const status of ["CANCELLED", "FAILED"] as const) {
    const memory = createMemoryPrisma();
    const repository = createPrismaTonhubPaymentRepository(memory.db);
    await repository.createPendingInvoice(pendingInput(`legacy-${status.toLowerCase()}`));
    memory.orders.splice(0);
    Object.assign(memory.invoices[0]!, {
      orderId: null,
      externalId: `legacy-${status.toLowerCase()}`,
      status,
    });

    await assert.rejects(
      repository.findReusableInvoice({
        externalId: `legacy-${status.toLowerCase()}`,
        network: "testnet",
        amountCents: 500,
        currency: "USD",
      }),
      new RegExp(`while it is ${status}`),
    );
    assert.equal(memory.orders[0]?.status, status);
  }
});

test("a funded unlinked rollout invoice supersedes an empty active attempt and locks the order in recovery", async () => {
  const memory = createMemoryPrisma();
  const repository = createPrismaTonhubPaymentRepository(memory.db);
  const linked = await repository.createPendingInvoice(pendingInput("rollout-funded"));
  memory.invoices.push({
    ...memory.invoices[0],
    id: "legacy-funded-expired",
    orderId: null,
    externalId: "rollout-funded",
    status: "EXPIRED",
    paidNano: "500000000",
    paidAmountAtomic: null,
    creditedFiatMicros: undefined,
    observedAt: new Date("2026-08-13T10:30:00.000Z"),
    reference: "LEGACY-FUNDED-EXPIRED",
    createdAt: new Date("2026-08-13T09:59:00.000Z"),
  });

  await assert.rejects(
    repository.findReusableInvoice({
      externalId: "rollout-funded",
      network: "testnet",
      amountCents: 500,
      currency: "USD",
    }),
    /cannot create a new payment attempt while it is RECOVERY/,
  );

  assert.equal(memory.invoices.find((row) => row.id === linked.id)?.status, "CANCELLED");
  assert.equal(
    memory.depositAddresses.find((row) => row.invoiceId === linked.id)?.status,
    "CANCELLED",
  );
  assert.equal(memory.invoices.find((row) => row.id === "legacy-funded-expired")?.orderId, linked.orderId);
  assert.equal(memory.orders[0]?.status, "RECOVERY");
});

test("a funded rollout attempt adds its credit to an already-recovery order", async () => {
  const memory = createMemoryPrisma();
  const repository = createPrismaTonhubPaymentRepository(memory.db);
  const first = await repository.createPendingInvoice(pendingInput("rollout-recovery-credit"));
  const firstPaidNano = "500000000";
  await repository.markInvoicePartial({
    invoiceId: first.id,
    paidNano: firstPaidNano,
    partialPaymentStartedAt: new Date("2026-08-13T10:10:00.000Z"),
    partialPaymentExpiresAt: new Date("2026-08-14T10:10:00.000Z"),
    observedPayments: [],
    observedAt: new Date("2026-08-13T10:10:00.000Z"),
  });
  await repository.markInvoiceExpired({
    invoiceId: first.id,
    expiredAt: new Date("2026-08-14T10:11:00.000Z"),
  });
  const existingCredit = BigInt(memory.orders[0]?.creditedFiatMicros);

  memory.invoices.push({
    ...memory.invoices[0],
    id: "legacy-funded-after-recovery",
    orderId: null,
    externalId: "rollout-recovery-credit",
    status: "EXPIRED",
    paidNano: firstPaidNano,
    paidAmountAtomic: null,
    creditedFiatMicros: undefined,
    observedAt: new Date("2026-08-13T10:30:00.000Z"),
    reference: "LEGACY-FUNDED-AFTER-RECOVERY",
    createdAt: new Date("2026-08-13T09:59:00.000Z"),
  });

  await assert.rejects(
    repository.findReusableInvoice({
      externalId: "rollout-recovery-credit",
      network: "testnet",
      amountCents: 500,
      currency: "USD",
    }),
    /cannot create a new payment attempt while it is RECOVERY/,
  );

  assert.equal(
    memory.orders[0]?.creditedFiatMicros,
    (existingCredit * BigInt(2)).toString(),
  );
  assert.equal(
    memory.invoices.find((row) => row.id === "legacy-funded-after-recovery")?.orderId,
    first.orderId,
  );
});

test("a transition on an unlinked rollout invoice resolves an active-attempt collision before attaching", async () => {
  const memory = createMemoryPrisma();
  const repository = createPrismaTonhubPaymentRepository(memory.db);
  const linked = await repository.createPendingInvoice(pendingInput("rollout-transition"));
  memory.invoices.push({
    ...memory.invoices[0],
    id: "legacy-transition",
    orderId: null,
    externalId: "rollout-transition",
    status: "PENDING",
    reference: "LEGACY-TRANSITION",
    createdAt: new Date("2026-08-13T09:59:00.000Z"),
  });

  const partial = await repository.markInvoicePartial({
    invoiceId: "legacy-transition",
    paidNano: "500000000",
    partialPaymentStartedAt: new Date("2026-08-13T10:10:00.000Z"),
    partialPaymentExpiresAt: new Date("2026-08-14T10:10:00.000Z"),
    observedPayments: [],
    observedAt: new Date("2026-08-13T10:10:00.000Z"),
  });

  assert.equal(memory.invoices.find((row) => row.id === linked.id)?.status, "CANCELLED");
  assert.equal(
    memory.depositAddresses.find((row) => row.invoiceId === linked.id)?.status,
    "CANCELLED",
  );
  assert.equal(partial?.orderId, linked.orderId);
  assert.equal(partial?.status, "PARTIAL");
  assert.equal(partial?.order?.status, "PARTIAL");
});

test("a concurrent rollout reuse cannot cancel the attempt that records a partial payment", async () => {
  const memory = createMemoryPrisma();
  const repository = createPrismaTonhubPaymentRepository(memory.db);
  const linked = await repository.createPendingInvoice(pendingInput("rollout-concurrent-transition"));
  memory.invoices.push({
    ...memory.invoices[0],
    id: "legacy-concurrent-transition",
    orderId: null,
    externalId: "rollout-concurrent-transition",
    status: "PENDING",
    reference: "LEGACY-CONCURRENT-TRANSITION",
    createdAt: new Date("2026-08-13T09:59:00.000Z"),
  });

  let staleRead!: () => void;
  const staleReadPromise = new Promise<void>((resolve) => {
    staleRead = resolve;
  });
  let resumeTransition!: () => void;
  const resumeTransitionPromise = new Promise<void>((resolve) => {
    resumeTransition = resolve;
  });
  memory.onNextInvoiceFind(async (row) => {
    staleRead();
    await resumeTransitionPromise;
    return row;
  });

  const transitionPromise = repository.markInvoicePartial({
    invoiceId: "legacy-concurrent-transition",
    paidNano: "500000000",
    partialPaymentStartedAt: new Date("2026-08-13T10:10:00.000Z"),
    partialPaymentExpiresAt: new Date("2026-08-14T10:10:00.000Z"),
    observedPayments: [],
    observedAt: new Date("2026-08-13T10:10:00.000Z"),
  });
  await staleReadPromise;

  const reused = await repository.findReusableInvoice({
    externalId: "rollout-concurrent-transition",
    network: "testnet",
    amountCents: 500,
    currency: "USD",
  });
  assert.equal(reused?.id, linked.id);
  resumeTransition();
  const partial = await transitionPromise;

  assert.equal(partial?.id, "legacy-concurrent-transition");
  assert.equal(partial?.status, "PARTIAL");
  assert.equal(partial?.order?.status, "PARTIAL");
  assert.equal(memory.invoices.find((row) => row.id === linked.id)?.status, "CANCELLED");
  assert.equal(
    memory.depositAddresses.find((row) => row.invoiceId === linked.id)?.status,
    "CANCELLED",
  );
  assert.equal(
    memory.invoices.filter((row) => ["PENDING", "PARTIAL"].includes(row.status)).length,
    1,
  );
});

test("concurrent payments to linked and rollout addresses preserve both credits in recovery", async () => {
  const memory = createMemoryPrisma();
  const repository = createPrismaTonhubPaymentRepository(memory.db);
  const linked = await repository.createPendingInvoice(pendingInput("rollout-concurrent-funded"));
  memory.invoices.push({
    ...memory.invoices[0],
    id: "legacy-concurrent-funded",
    orderId: null,
    externalId: "rollout-concurrent-funded",
    status: "PENDING",
    reference: "LEGACY-CONCURRENT-FUNDED",
    createdAt: new Date("2026-08-13T09:59:00.000Z"),
  });
  memory.depositAddresses.push({
    ...memory.depositAddresses[0],
    id: "legacy-concurrent-funded-deposit",
    invoiceId: "legacy-concurrent-funded",
    address: "EQ_LEGACY_CONCURRENT_FUNDED",
    addressRaw: "0:legacy-concurrent-funded",
    walletContext: 104,
  });

  let staleRead!: () => void;
  const staleReadPromise = new Promise<void>((resolve) => {
    staleRead = resolve;
  });
  let resumeLinked!: () => void;
  const resumeLinkedPromise = new Promise<void>((resolve) => {
    resumeLinked = resolve;
  });
  memory.onNextInvoiceFind(async (row) => {
    staleRead();
    await resumeLinkedPromise;
    return row;
  });

  const linkedTransition = repository.markInvoicePartial({
    invoiceId: linked.id,
    paidNano: "500000000",
    partialPaymentStartedAt: new Date("2026-08-13T10:09:00.000Z"),
    partialPaymentExpiresAt: new Date("2026-08-14T10:09:00.000Z"),
    observedPayments: [],
    observedAt: new Date("2026-08-13T10:09:00.000Z"),
  });
  await staleReadPromise;
  const rolloutPartial = await repository.markInvoicePartial({
    invoiceId: "legacy-concurrent-funded",
    paidNano: "500000000",
    partialPaymentStartedAt: new Date("2026-08-13T10:10:00.000Z"),
    partialPaymentExpiresAt: new Date("2026-08-14T10:10:00.000Z"),
    observedPayments: [],
    observedAt: new Date("2026-08-13T10:10:00.000Z"),
  });
  resumeLinked();
  const linkedRecovered = await linkedTransition;

  assert.equal(rolloutPartial?.status, "PARTIAL");
  assert.equal(linkedRecovered?.status, "FAILED");
  assert.equal(linkedRecovered?.paidAmountAtomic, "500000000");
  assert.equal(memory.orders[0]?.status, "RECOVERY");
  assert.equal(memory.orders[0]?.creditedFiatMicros, "2463054");
  assert.equal(
    memory.depositAddresses.find((row) => row.invoiceId === linked.id)?.status,
    "FAILED",
  );
  assert.equal(
    memory.depositAddresses.find((row) => row.invoiceId === "legacy-concurrent-funded")?.status,
    "ACTIVE",
  );
});

test("an external id cannot silently change its fiat obligation", async () => {
  const memory = createMemoryPrisma();
  const repository = createPrismaTonhubPaymentRepository(memory.db);
  await repository.createPendingInvoice(pendingInput());

  await assert.rejects(
    repository.findReusableInvoice({
      externalId: "merchant-order-1",
      network: "testnet",
      amountCents: 600,
      currency: "USD",
    }),
    TonhubOrderTermsMismatchError,
  );
  assert.equal(memory.orders.length, 1);
  assert.equal(memory.invoices.length, 1);
});

test("a create loser reuses a winner that became paid before P2002 recovery", async () => {
  const memory = createMemoryPrisma();
  const repository = createPrismaTonhubPaymentRepository(memory.db);
  memory.onNextInvoiceCreate((data) => {
    const order = memory.orders.find((row) => row.id === data.orderId)!;
    order.status = "PAID";
    order.creditedFiatMicros = order.fiatAmountMicros;
    order.paidAt = new Date("2026-08-13T10:00:01.000Z");
    memory.invoices.push({
      ...data,
      id: "concurrent-paid-winner",
      status: "PAID",
      paidNano: data.amountNano,
      paidAmountAtomic: data.amountAtomic,
      creditedFiatMicros: data.fiatAmountMicros,
      remainingFiatMicros: "0",
      observedAt: order.paidAt,
      createdAt,
      updatedAt: order.paidAt,
    });
    const conflict = Object.assign(new Error("active attempt conflict"), {
      code: "P2002",
      meta: { target: ["orderId"] },
    });
    throw conflict;
  });

  const winner = await repository.createPendingInvoice(pendingInput("concurrent-order"));

  assert.equal(winner.id, "concurrent-paid-winner");
  assert.equal(winner.status, "PAID");
  assert.equal(winner.externalId, "concurrent-order");
});

test("the legacy create endpoint reports an order terms conflict without fetching a new quote", async () => {
  process.env.TON_ALLOWED_NETWORKS = "testnet,mainnet";
  const memory = createMemoryPrisma();
  const repository = createPrismaTonhubPaymentRepository(memory.db);
  await repository.createPendingInvoice(pendingInput());
  let rateFetches = 0;

  const response = await createTonhubPaymentInvoice(
    {
      amount: "6.00",
      currency: "USD",
      network: "testnet",
      externalId: "merchant-order-1",
    },
    {
      repository,
      fetchTonFiatRate: async () => {
        rateFetches += 1;
        throw new Error("the mismatch must be resolved before rate lookup");
      },
    },
  );

  assert.equal(response.status, 409);
  assert.equal(response.body.errorCode, "TON_ORDER_TERMS_MISMATCH");
  assert.equal(rateFetches, 0);
});

test("invoice transitions dual-write the owning order", async () => {
  const memory = createMemoryPrisma();
  const repository = createPrismaTonhubPaymentRepository(memory.db);
  const invoice = await repository.createPendingInvoice(pendingInput());

  const partial = await repository.markInvoicePartial({
    invoiceId: invoice.id,
    paidNano: "1010000000",
    partialPaymentStartedAt: new Date("2026-08-13T10:10:00.000Z"),
    partialPaymentExpiresAt: new Date("2026-08-14T10:10:00.000Z"),
    observedPayments: [],
    observedAt: new Date("2026-08-13T10:10:00.000Z"),
  });

  assert.equal(partial?.status, "PARTIAL");
  assert.equal(memory.orders[0]?.status, "PARTIAL");
  assert.equal(partial?.paidAmountAtomic, "1010000000");
  assert.equal(memory.orders[0]?.creditedFiatMicros, "2487684");

  const paid = await repository.markInvoicePaid({
    invoiceId: invoice.id,
    transactionId: "paid-transaction",
    paidNano: quote.amountAtomic,
    observedPayments: [],
    paidAt: new Date("2026-08-13T10:20:00.000Z"),
  });

  assert.equal(paid?.status, "PAID");
  assert.equal(memory.orders[0]?.status, "PAID");
  assert.equal(memory.orders[0]?.creditedFiatMicros, "5000000");
  assert.equal(memory.orders[0]?.paidAt.toISOString(), "2026-08-13T10:20:00.000Z");
  assert.equal(memory.transactions.length, 1);

  const reusable = await repository.findReusableInvoice({
    externalId: "merchant-order-1",
    network: "mainnet",
    amountCents: 500,
    currency: "USD",
  });
  assert.equal(reusable?.id, invoice.id);
  assert.equal(reusable?.status, "PAID");
});

test("a direct full payment records its blockchain time as firstMovementAt", async () => {
  const memory = createMemoryPrisma();
  const repository = createPrismaTonhubPaymentRepository(memory.db);
  const invoice = await repository.createPendingInvoice(pendingInput("direct-paid-order"));
  const paidAt = new Date("2026-08-13T10:05:00.000Z");

  const paid = await repository.markInvoicePaid({
    invoiceId: invoice.id,
    transactionId: "direct-paid-transaction",
    paidNano: quote.amountAtomic,
    observedPayments: [],
    paidAt,
  });

  assert.equal(paid?.firstMovementAt?.toISOString(), paidAt.toISOString());
});

test("an expired empty attempt can be replaced under the same order", async () => {
  const memory = createMemoryPrisma();
  const repository = createPrismaTonhubPaymentRepository(memory.db);
  const first = await repository.createPendingInvoice(pendingInput("retry-order"));
  await repository.markInvoiceExpired({
    invoiceId: first.id,
    expiredAt: new Date("2026-08-13T11:01:00.000Z"),
  });

  const second = await repository.createPendingInvoice({
    ...pendingInput("retry-order"),
    reference: "ORDER-RETRY-2",
    depositAddress: {
      ...depositAddress,
      address: "EQ_ORDER_RETRY_2",
      addressRaw: "0:order-retry-2",
      walletContext: 102,
    },
  });

  assert.notEqual(second.id, first.id);
  assert.equal(second.orderId, first.orderId);
  assert.equal(memory.orders.length, 1);
  assert.equal(memory.invoices.length, 2);
  assert.equal(memory.invoices.filter((row) => row.status === "PENDING").length, 1);
});

test("an expired partially funded order is held for recovery and cannot be reopened", async () => {
  const memory = createMemoryPrisma();
  const repository = createPrismaTonhubPaymentRepository(memory.db);
  const invoice = await repository.createPendingInvoice(pendingInput("partial-recovery-order"));
  await repository.markInvoicePartial({
    invoiceId: invoice.id,
    paidNano: "1010000000",
    partialPaymentStartedAt: new Date("2026-08-13T10:10:00.000Z"),
    partialPaymentExpiresAt: new Date("2026-08-14T10:10:00.000Z"),
    observedPayments: [],
    observedAt: new Date("2026-08-13T10:10:00.000Z"),
  });
  await repository.markInvoiceExpired({
    invoiceId: invoice.id,
    expiredAt: new Date("2026-08-14T10:11:00.000Z"),
  });

  assert.equal(memory.orders[0]?.status, "RECOVERY");
  await assert.rejects(
    repository.createPendingInvoice({
      ...pendingInput("partial-recovery-order"),
      reference: "ORDER-RECOVERY-RETRY",
    }),
    /cannot create a new payment attempt while it is RECOVERY/,
  );
  assert.equal(memory.invoices.length, 1);
});
