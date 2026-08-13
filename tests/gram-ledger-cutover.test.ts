import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import { Address } from "@ton/core";
import {
  checkTonhubPaymentInvoice,
  settleTonhubInvoiceWithConfiguredSource,
} from "../backend/src/payments";
import {
  compareGramSettlementMatches,
  createPrismaGramLedgerSettlementSource,
  parseGramSettlementMode,
  type GramSettlementComparison,
} from "../backend/src/gram-ledger-source";
import type { TonhubPaymentRepository } from "../backend/src/repository";
import type { TonCenterTransaction, TonInvoiceMatch } from "../backend/src/ton/direct-payments";
import type { TonhubPaymentInvoiceRecord } from "../backend/src/types";

const destinationRaw = `0:${"31".repeat(32)}`;
const sourceRaw = `0:${"41".repeat(32)}`;
const destination = Address.parse(destinationRaw).toString({ bounceable: true, testOnly: true });
const createdAt = new Date("2026-08-13T10:00:00.000Z");
const now = new Date("2026-08-13T10:30:00.000Z");

function invoice(overrides: Partial<TonhubPaymentInvoiceRecord> = {}): TonhubPaymentInvoiceRecord {
  return {
    id: "cutover-invoice",
    externalId: "cutover-order",
    orderId: "cutover-order-id",
    network: "testnet",
    asset: "GRAM",
    checkoutAsset: "GRAM",
    assetKind: "NATIVE",
    assetDecimals: 9,
    fiatAmountCents: 500,
    fiatAmountMicros: "5000000",
    creditedFiatMicros: "0",
    remainingFiatMicros: "5000000",
    fiatCurrency: "USD",
    address: destination,
    addressRaw: destinationRaw,
    addressStrategy: "unique-address",
    walletVersion: "v5r1",
    walletWorkchain: 0,
    walletContext: 401,
    walletNetworkGlobalId: -3,
    walletPublicKeyHash: "cutover-key",
    amountNano: "2000000000",
    paidNano: "0",
    amountAtomic: "2000000000",
    paidAmountAtomic: "0",
    reference: "CUTOVER-REFERENCE",
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

function transaction(input: {
  hash: string;
  lt: string;
  amount: string;
  aborted?: boolean;
  success?: boolean;
  at?: Date;
}): TonCenterTransaction {
  return {
    hash: input.hash,
    lt: input.lt,
    now: Math.floor((input.at ?? new Date("2026-08-13T10:10:00.000Z")).getTime() / 1000),
    description: {
      aborted: input.aborted ?? false,
      action: { success: input.success ?? true },
    },
    in_msg: {
      source: sourceRaw,
      destination: destinationRaw,
      value: input.amount,
    },
  };
}

function createLedgerSource(initialInvoice: TonhubPaymentInvoiceRecord = invoice()) {
  const movements: any[] = [];
  const depositAddress = {
    id: "cutover-deposit",
    invoiceId: initialInvoice.id,
    network: initialInvoice.network,
    address: initialInvoice.address,
    addressRaw: initialInvoice.addressRaw,
  };
  const db = {
    tonhubPaymentInvoice: {
      findUnique: async () => ({ ...initialInvoice, depositAddress }),
    },
    tonhubPaymentMovement: {
      findMany: async () => movements,
    },
  };
  const source = createPrismaGramLedgerSettlementSource(db as any, {
    recordObserved: async (draft) => {
      if (!movements.some(({ fingerprint }) => fingerprint === draft.fingerprint)) {
        movements.push({
          ...draft,
          id: `movement-${movements.length + 1}`,
          status: "OBSERVED",
        });
      }
      return movements.find(({ fingerprint }) => fingerprint === draft.fingerprint);
    },
  });
  return { source, movements, depositAddress };
}

function createRepositoryHarness(initialInvoice = invoice()) {
  let current = initialInvoice;
  let transitionCount = 0;
  const update = (patch: Partial<TonhubPaymentInvoiceRecord>) => {
    transitionCount += 1;
    current = { ...current, ...patch, updatedAt: now };
    return current;
  };
  const repository: TonhubPaymentRepository = {
    findInvoiceById: async () => current,
    findReusableInvoice: async () => current,
    createPendingInvoice: async () => {
      throw new Error("not used");
    },
    markInvoiceExpired: async ({ expiredAt }) => update({ status: "EXPIRED", observedAt: expiredAt }),
    markInvoicePartial: async (input) => update({
      status: "PARTIAL",
      paidNano: input.paidNano,
      paidAmountAtomic: input.paidNano,
      observedPayments: input.observedPayments,
      observedAt: input.observedAt,
      partialPaymentStartedAt: input.partialPaymentStartedAt,
      partialPaymentExpiresAt: input.partialPaymentExpiresAt,
    }),
    markInvoicePaid: async (input) => update({
      status: "PAID",
      paidNano: input.paidNano,
      paidAmountAtomic: input.paidNano,
      observedPayments: input.observedPayments,
      observedTransactionHash: input.transactionId,
      observedAt: input.paidAt,
    }),
  };
  return {
    repository,
    current: () => current,
    transitionCount: () => transitionCount,
  };
}

function dependencies(input: {
  repository: TonhubPaymentRepository;
  source: ReturnType<typeof createLedgerSource>["source"];
  mode: "legacy" | "compare" | "ledger";
  transactions: TonCenterTransaction[];
  comparisons?: GramSettlementComparison[];
  movementSettlementEnabled?: boolean;
  mixedSettlementInvoice?: TonhubPaymentInvoiceRecord;
  mixedSettlementError?: Error;
}) {
  return {
    repository: input.repository,
    now: () => now,
    resolveTonApiConfig: () => ({
      network: "testnet" as const,
      baseUrl: "https://example.invalid",
      address: "",
      addressEnvName: "",
    }),
    fetchTonTransactions: async () => ({ transactions: input.transactions }),
    gramLedgerSource: input.source,
    gramSettlementMode: () => input.mode,
    movementSettlementEnabled: () => input.movementSettlementEnabled ?? false,
    mixedAssetSettlement: {
      settleInvoice: async () => {
        if (input.mixedSettlementError) {
          throw input.mixedSettlementError;
        }
        const settledInvoice = input.mixedSettlementInvoice ??
          await input.repository.findInvoiceById("cutover-invoice");
        if (!settledInvoice) {
          throw new Error("mixed settlement fixture invoice is missing");
        }
        return { invoice: settledInvoice, outcomes: [], ratePending: false, deferred: false };
      },
    },
    reportGramSettlementComparison: (comparison: GramSettlementComparison) => {
      input.comparisons?.push(comparison);
    },
  };
}

test("GRAM ledger source persists only strict successful evidence and replays it as settlement matches", async () => {
  const ledger = createLedgerSource();
  const valid = transaction({ hash: "51".repeat(32), lt: "1001", amount: "1000000000" });
  const aborted = transaction({
    hash: "52".repeat(32),
    lt: "1002",
    amount: "9000000000",
    aborted: true,
  });
  const observed = await ledger.source.observeTransactions({
    invoiceId: invoice().id,
    network: "testnet",
    notBefore: createdAt,
    notAfter: now,
    transactions: [valid, aborted, structuredClone(valid)],
  });
  const matches = await ledger.source.listMatches({
    invoiceId: invoice().id,
    network: "testnet",
    notBefore: createdAt,
    notAfter: now,
  });

  assert.equal(observed.observed, 1);
  assert.deepEqual(observed.rejections.map(({ code }) => code), ["TRANSACTION_NOT_SUCCESSFUL"]);
  assert.equal(ledger.movements.length, 1);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.amountNano, "1000000000");
  assert.equal(matches[0]?.transaction.hash, "51".repeat(32));
});

test("GRAM ledger source resolves the deposit as scan owner and rejects invoice/deposit drift", async () => {
  const ledger = createLedgerSource();
  const resolved = await ledger.source.resolveTarget({
    invoiceId: invoice().id,
    network: "testnet",
  });
  assert.equal(resolved.address, destination);
  assert.equal(resolved.depositAddressId, "cutover-deposit");
  ledger.depositAddress.addressRaw = `0:${"32".repeat(32)}`;
  await assert.rejects(
    ledger.source.resolveTarget({ invoiceId: invoice().id, network: "testnet" }),
    /inconsistent address ownership/,
  );
  ledger.depositAddress.addressRaw = destinationRaw;
  ledger.depositAddress.network = "mainnet";
  await assert.rejects(
    ledger.source.resolveTarget({ invoiceId: invoice().id, network: "testnet" }),
    /inconsistent network ownership/,
  );
});

test("GRAM observation remains available for a USDT checkout attempt on the same unique deposit owner", async () => {
  const ledger = createLedgerSource(invoice({
    asset: "USDT",
    checkoutAsset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    amountAtomic: "5000000",
    paidAmountAtomic: "0",
  }));
  const resolved = await ledger.source.resolveTarget({
    invoiceId: invoice().id,
    network: "testnet",
  });
  assert.equal(resolved.address, destination);
  const observed = await ledger.source.observeTransactions({
    invoiceId: invoice().id,
    network: "testnet",
    notBefore: createdAt,
    notAfter: now,
    transactions: [transaction({ hash: "59".repeat(32), lt: "1009", amount: "1000000000" })],
  });
  assert.equal(observed.observed, 1);
});

test("GRAM ledger source rejects a persisted movement whose destination does not belong to its deposit", async () => {
  const ledger = createLedgerSource();
  await ledger.source.observeTransactions({
    invoiceId: invoice().id,
    network: "testnet",
    notBefore: createdAt,
    notAfter: now,
    transactions: [transaction({ hash: "59".repeat(32), lt: "1901", amount: "1000000000" })],
  });
  ledger.movements[0].toAddress = `0:${"39".repeat(32)}`;

  await assert.rejects(
    ledger.source.listMatches({
      invoiceId: invoice().id,
      network: "testnet",
      notBefore: createdAt,
      notAfter: now,
    }),
    /Stored GRAM movement is malformed/,
  );
});

test("ledger cutover ignores an aborted transfer that the legacy matcher would count", async () => {
  const harness = createRepositoryHarness();
  const ledger = createLedgerSource();
  const comparisons: GramSettlementComparison[] = [];
  const checked = await checkTonhubPaymentInvoice(invoice().id, dependencies({
    repository: harness.repository,
    source: ledger.source,
    mode: "ledger",
    comparisons,
    transactions: [
      transaction({ hash: "61".repeat(32), lt: "2001", amount: "1000000000" }),
      transaction({
        hash: "62".repeat(32),
        lt: "2002",
        amount: "1000000000",
        aborted: true,
      }),
    ],
  }));

  assert.equal(checked.status, 200);
  assert.equal(checked.body.finalized, false);
  assert.equal(harness.current().status, "PARTIAL");
  assert.equal(harness.current().paidAmountAtomic, "1000000000");
  assert.equal(comparisons.length, 1);
  assert.equal(comparisons[0]?.legacyAmountAtomic, "2000000000");
  assert.equal(comparisons[0]?.ledgerAmountAtomic, "1000000000");
  assert.deepEqual(comparisons[0]?.onlyLegacy, ["62".repeat(32)]);
});

test("allocation settlement remains sticky after new-attempt issuance is disabled", async () => {
  const pendingInvoice = invoice({ activationThresholdFiatMicros: "2500000" });
  const harness = createRepositoryHarness(pendingInvoice);
  const ledger = createLedgerSource(pendingInvoice);
  const paidInvoice = invoice({
    activationThresholdFiatMicros: "2500000",
    status: "PAID",
    creditedFiatMicros: "5000000",
    remainingFiatMicros: "0",
    paidNano: "0",
    paidAmountAtomic: "0",
    order: {
      id: "cutover-order-id",
      externalId: "cutover-order",
      fiatAmountMicros: "5000000",
      fiatCurrency: "USD",
      creditedFiatMicros: "5000000",
      overpaymentFiatMicros: "0",
      status: "PAID",
      paidAt: new Date("2026-08-13T10:10:00.000Z"),
      expiresAt: new Date("2026-08-13T11:00:00.000Z"),
      cancelledAt: null,
      createdAt,
      updatedAt: now,
      metadata: null,
    },
  });
  const checked = await checkTonhubPaymentInvoice(pendingInvoice.id, dependencies({
    repository: harness.repository,
    source: ledger.source,
    mode: "ledger",
    transactions: [],
    movementSettlementEnabled: false,
    mixedSettlementInvoice: paidInvoice,
  }));

  assert.equal(checked.status, 200);
  assert.equal(checked.body.finalized, true);
  assert.equal((checked.body.invoice as { status: string }).status, "PAID");
  assert.equal((checked.body.invoice as { creditedFiatMicros: string }).creditedFiatMicros, "5000000");
  assert.equal((checked.body.invoice as { remainingAmountAtomic: string }).remainingAmountAtomic, "0");
  assert.equal((checked.body.invoice as { settlementBasis: string }).settlementBasis, "fiat-ledger");
  assert.equal(harness.transitionCount(), 0);
});

test("a fiat-ledger attempt fails closed instead of falling back to legacy atomic settlement", async () => {
  const pendingInvoice = invoice({ activationThresholdFiatMicros: "2500000" });
  const harness = createRepositoryHarness(pendingInvoice);
  const ledger = createLedgerSource(pendingInvoice);
  const checked = await checkTonhubPaymentInvoice(pendingInvoice.id, dependencies({
    repository: harness.repository,
    source: ledger.source,
    mode: "legacy",
    transactions: [transaction({
      hash: "79".repeat(32),
      lt: "1950",
      amount: "2000000000",
    })],
  }));

  assert.equal(checked.status, 503);
  assert.match(String(checked.body.error), /cannot fall back to legacy atomic mutation/);
  assert.equal(harness.transitionCount(), 0);
  assert.equal(harness.current().status, "PENDING");
});

test("a fiat-ledger attempt in compare mode fails closed when observation or allocation fails", async () => {
  const pendingInvoice = invoice({ activationThresholdFiatMicros: "2500000" });
  const harness = createRepositoryHarness(pendingInvoice);
  const ledger = createLedgerSource(pendingInvoice);
  const checked = await checkTonhubPaymentInvoice(pendingInvoice.id, dependencies({
    repository: harness.repository,
    source: ledger.source,
    mode: "compare",
    transactions: [transaction({
      hash: "7a".repeat(32),
      lt: "1951",
      amount: "2000000000",
    })],
    mixedSettlementError: new Error("allocation storage unavailable"),
  }));

  assert.equal(checked.status, 503);
  assert.match(String(checked.body.error), /allocation storage unavailable/);
  assert.equal(harness.transitionCount(), 0);
  assert.equal(harness.current().status, "PENDING");
});

test("a fiat-ledger attempt with an invalid stored network cannot enter legacy settlement", async () => {
  const pendingInvoice = invoice({
    activationThresholdFiatMicros: "2500000",
    network: "invalid-network" as any,
  });
  const harness = createRepositoryHarness(pendingInvoice);
  const ledger = createLedgerSource(pendingInvoice);

  await assert.rejects(
    settleTonhubInvoiceWithConfiguredSource({
      invoice: pendingInvoice,
      dependencies: dependencies({
        repository: harness.repository,
        source: ledger.source,
        mode: "compare",
        transactions: [],
      }),
    }),
    /fiat-ledger settlement with an invalid network/,
  );
  assert.equal(harness.transitionCount(), 0);
});

test("fiat-ledger partial responses scale the locked checkout amount after wrong-asset credit", async () => {
  const pendingInvoice = invoice({ activationThresholdFiatMicros: "2500000" });
  const harness = createRepositoryHarness(pendingInvoice);
  const ledger = createLedgerSource(pendingInvoice);
  const partialInvoice = invoice({
    activationThresholdFiatMicros: "2500000",
    status: "PARTIAL",
    creditedFiatMicros: "2000000",
    remainingFiatMicros: "3000000",
    paidNano: "0",
    paidAmountAtomic: "0",
    partialPaymentStartedAt: new Date("2026-08-13T10:10:00.000Z"),
    partialPaymentExpiresAt: new Date("2026-08-14T10:10:00.000Z"),
    observedPayments: [{
      transactionId: "78".repeat(32),
      asset: "USDT",
      assetDecimals: 6,
      amountAtomic: "2000000",
      amountFormatted: "2 USDT",
      createdAt: "2026-08-13T10:10:00.000Z",
      status: "observed",
      comment: "",
    }],
  });
  const checked = await checkTonhubPaymentInvoice(pendingInvoice.id, dependencies({
    repository: harness.repository,
    source: ledger.source,
    mode: "ledger",
    transactions: [],
    movementSettlementEnabled: true,
    mixedSettlementInvoice: partialInvoice,
  }));

  assert.equal(checked.status, 200);
  assert.equal(checked.body.finalized, false);
  assert.equal((checked.body.invoice as { remainingAmountAtomic: string }).remainingAmountAtomic, "1200000000");
  assert.equal((checked.body.invoice as { amountAtomic: string }).amountAtomic, "1200000000");
  assert.equal((checked.body.invoice as { paidAmountAtomic: string }).paidAmountAtomic, "0");
});

test("compare mode reports divergence but preserves the legacy settlement response", async () => {
  const harness = createRepositoryHarness();
  const ledger = createLedgerSource();
  const comparisons: GramSettlementComparison[] = [];
  const settled = await settleTonhubInvoiceWithConfiguredSource({
    invoice: invoice(),
    dependencies: dependencies({
      repository: harness.repository,
      source: ledger.source,
      mode: "compare",
      comparisons,
      transactions: [
        transaction({ hash: "71".repeat(32), lt: "3001", amount: "1000000000" }),
        transaction({
          hash: "72".repeat(32),
          lt: "3002",
          amount: "1000000000",
          success: false,
        }),
      ],
    }),
  });

  assert.equal(settled.state, "paid");
  assert.equal(harness.current().status, "PAID");
  assert.equal(comparisons.length, 1);
  assert.equal(comparisons[0]?.equivalent, false);
  assert.deepEqual(comparisons[0]?.onlyLegacy, ["72".repeat(32)]);
});

test("compare mode preserves the legacy future-timestamp boundary while reporting strict rejection", async () => {
  const harness = createRepositoryHarness();
  const ledger = createLedgerSource();
  const comparisons: GramSettlementComparison[] = [];
  const futureHash = "73".repeat(32);
  const settled = await settleTonhubInvoiceWithConfiguredSource({
    invoice: invoice(),
    dependencies: dependencies({
      repository: harness.repository,
      source: ledger.source,
      mode: "compare",
      comparisons,
      transactions: [transaction({
        hash: futureHash,
        lt: "3301",
        amount: "2000000000",
        at: new Date(now.getTime() + 30_000),
      })],
    }),
  });

  assert.equal(settled.state, "paid");
  assert.deepEqual(comparisons[0]?.onlyLegacy, [futureHash]);
  assert.equal(comparisons[0]?.ledgerAmountAtomic, "0");
});

test("ledger cutover canonicalizes a stored base64 partial hash and never double-counts it", async () => {
  const hashHex = "75".repeat(32);
  const hashBase64Url = Buffer.from(hashHex, "hex").toString("base64url");
  const partialInvoice = invoice({
    status: "PARTIAL",
    paidNano: "1000000000",
    paidAmountAtomic: "1000000000",
    partialPaymentStartedAt: new Date("2026-08-13T10:10:00.000Z"),
    partialPaymentExpiresAt: new Date("2026-08-14T10:10:00.000Z"),
    observedPayments: [{
      transactionId: hashBase64Url,
      amountNano: "1000000000",
      createdAt: "2026-08-13T10:10:00.000Z",
      status: "observed",
      comment: "",
    }],
  });
  const harness = createRepositoryHarness(partialInvoice);
  const ledger = createLedgerSource(partialInvoice);
  const settled = await settleTonhubInvoiceWithConfiguredSource({
    invoice: partialInvoice,
    dependencies: dependencies({
      repository: harness.repository,
      source: ledger.source,
      mode: "ledger",
      transactions: [transaction({
        hash: hashBase64Url,
        lt: "3501",
        amount: "1000000000",
      })],
    }),
  });

  assert.equal(settled.state, "pending");
  assert.equal(harness.current().status, "PARTIAL");
  assert.equal(harness.current().paidAmountAtomic, "1000000000");
  assert.equal((harness.current().observedPayments as unknown[]).length, 1);
});

test("ledger cutover fails closed when a legacy stored partial has no strict movement evidence", async () => {
  const abortedHash = "76".repeat(32);
  const partialInvoice = invoice({
    status: "PARTIAL",
    paidNano: "1000000000",
    paidAmountAtomic: "1000000000",
    partialPaymentStartedAt: new Date("2026-08-13T10:10:00.000Z"),
    partialPaymentExpiresAt: new Date("2026-08-14T10:10:00.000Z"),
    observedPayments: [{
      transactionId: abortedHash,
      amountNano: "1000000000",
      createdAt: "2026-08-13T10:10:00.000Z",
      status: "observed",
      comment: "",
    }],
  });
  const harness = createRepositoryHarness(partialInvoice);
  const ledger = createLedgerSource(partialInvoice);
  const checked = await checkTonhubPaymentInvoice(partialInvoice.id, dependencies({
    repository: harness.repository,
    source: ledger.source,
    mode: "ledger",
    transactions: [transaction({
      hash: abortedHash,
      lt: "3601",
      amount: "1000000000",
      aborted: true,
    })],
  }));

  assert.equal(checked.status, 503);
  assert.match(String(checked.body.error), /cannot verify 1 stored payment/);
  assert.equal(harness.current().status, "PARTIAL");
  assert.equal(harness.current().paidAmountAtomic, "1000000000");
  assert.equal(harness.transitionCount(), 0);
});

test("ledger cutover rejects incomplete or malformed stored partial evidence before mutation", async () => {
  const evidenceHash = "77".repeat(32);
  const cases: Array<{ name: string; observedPayments: unknown }> = [
    { name: "missing", observedPayments: null },
    { name: "empty", observedPayments: [] },
    {
      name: "malformed entry",
      observedPayments: [{
        transactionId: evidenceHash,
        amountNano: "invalid",
        createdAt: "2026-08-13T10:10:00.000Z",
        status: "observed",
        comment: "",
      }],
    },
    {
      name: "sum mismatch",
      observedPayments: [{
        transactionId: evidenceHash,
        amountNano: "500000000",
        createdAt: "2026-08-13T10:10:00.000Z",
        status: "observed",
        comment: "",
      }],
    },
  ];

  for (const testCase of cases) {
    const partialInvoice = invoice({
      status: "PARTIAL",
      paidNano: "1000000000",
      paidAmountAtomic: "1000000000",
      partialPaymentStartedAt: new Date("2026-08-13T10:10:00.000Z"),
      partialPaymentExpiresAt: new Date("2026-08-14T10:10:00.000Z"),
      observedPayments: testCase.observedPayments,
    });
    const harness = createRepositoryHarness(partialInvoice);
    const ledger = createLedgerSource(partialInvoice);
    const checked = await checkTonhubPaymentInvoice(partialInvoice.id, dependencies({
      repository: harness.repository,
      source: ledger.source,
      mode: "ledger",
      transactions: [transaction({
        hash: evidenceHash,
        lt: "3701",
        amount: "1000000000",
      })],
    }));

    assert.equal(checked.status, 503, testCase.name);
    assert.equal(harness.current().status, "PARTIAL", testCase.name);
    assert.equal(harness.current().paidAmountAtomic, "1000000000", testCase.name);
    assert.equal(harness.transitionCount(), 0, testCase.name);
    assert.equal(ledger.movements.length, 0, testCase.name);
  }
});

test("compare isolates ledger outages while ledger mode fails closed without settlement mutation", async () => {
  const failingSource = {
    resolveTarget: async () => ({
      address: destination,
      addressRaw: destinationRaw,
      depositAddressId: "cutover-deposit",
    }),
    observeTransactions: async () => {
      throw new Error("ledger unavailable");
    },
    listMatches: async () => [] as TonInvoiceMatch[],
  };
  const compareHarness = createRepositoryHarness();
  const comparisons: GramSettlementComparison[] = [];
  const compare = await checkTonhubPaymentInvoice(invoice().id, dependencies({
    repository: compareHarness.repository,
    source: failingSource as any,
    mode: "compare",
    comparisons,
    transactions: [transaction({ hash: "81".repeat(32), lt: "4001", amount: "2000000000" })],
  }));
  assert.equal(compare.status, 200);
  assert.equal(compare.body.finalized, true);
  assert.equal(compareHarness.current().status, "PAID");
  assert.equal(comparisons[0]?.observationError, "ledger unavailable");

  const ledgerHarness = createRepositoryHarness();
  const ledger = await checkTonhubPaymentInvoice(invoice().id, dependencies({
    repository: ledgerHarness.repository,
    source: failingSource as any,
    mode: "ledger",
    transactions: [transaction({ hash: "82".repeat(32), lt: "4002", amount: "2000000000" })],
  }));
  assert.equal(ledger.status, 503);
  assert.equal(ledger.body.errorCode, "TON_INVOICE_CHECK_FAILED");
  assert.equal(ledgerHarness.current().status, "PENDING");
  assert.equal(ledgerHarness.transitionCount(), 0);
});

test("GRAM settlement mode defaults to ledger and rejects silent fallback values", () => {
  assert.equal(parseGramSettlementMode(), "ledger");
  assert.equal(parseGramSettlementMode(" LEGACY "), "legacy");
  assert.equal(parseGramSettlementMode("compare"), "compare");
  assert.throws(() => parseGramSettlementMode("shadow"), /legacy, compare, or ledger/);
});

test("comparison detects same transaction identity with conflicting immutable facts", () => {
  const match = (amountNano: string): TonInvoiceMatch => ({
    transaction: { hash: "91".repeat(32) },
    comment: null,
    amountNano,
    createdAt: "2026-08-13T10:10:00.000Z",
    status: "observed",
  });
  const result = compareGramSettlementMatches({
    invoiceId: invoice().id,
    legacy: [match("1")],
    ledger: [match("2")],
  });
  assert.equal(result.equivalent, false);
  assert.deepEqual(result.conflicting, ["91".repeat(32)]);
});

test("comparison reports duplicate-ID fact conflicts even when both sources contain the same conflict", () => {
  const match = (amountNano: string): TonInvoiceMatch => ({
    transaction: { hash: "93".repeat(32) },
    comment: null,
    amountNano,
    createdAt: "2026-08-13T10:10:00.000Z",
    status: "observed",
  });
  const result = compareGramSettlementMatches({
    invoiceId: invoice().id,
    legacy: [match("1"), match("2")],
    ledger: [match("1"), match("2")],
  });

  assert.equal(result.equivalent, false);
  assert.deepEqual(result.conflicting, ["93".repeat(32)]);
  assert.equal(result.legacyCount, 1);
  assert.equal(result.ledgerCount, 1);
});

test("comparison treats base64url and hex encodings of the same hash as one identity", () => {
  const hashHex = "92".repeat(32);
  const hashBase64Url = Buffer.from(hashHex, "hex").toString("base64url");
  const match = (hash: string): TonInvoiceMatch => ({
    transaction: { hash },
    comment: null,
    amountNano: "1",
    createdAt: "2026-08-13T10:10:00.000Z",
    status: "observed",
  });
  const result = compareGramSettlementMatches({
    invoiceId: invoice().id,
    legacy: [match(hashBase64Url), match(hashBase64Url)],
    ledger: [match(hashHex)],
  });
  assert.equal(result.equivalent, true);
  assert.equal(result.legacyCount, 1);
  assert.equal(result.legacyAmountAtomic, "1");
  assert.equal(result.ledgerAmountAtomic, "1");
});
