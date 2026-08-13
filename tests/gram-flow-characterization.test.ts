import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import {
  checkTonhubPaymentInvoice,
  settleTonhubInvoice
} from "../backend/src/payments";
import type { TonhubPaymentRepository } from "../backend/src/repository";
import {
  createTonV5R1DepositAddress,
  parseTonDepositPublicKey
} from "../backend/src/ton/deposit-addresses";
import {
  findTonDepositAddressPayments,
} from "../backend/src/ton/matching";
import type {
  TonCenterTransaction,
  TonNetwork
} from "../backend/src/ton/direct-payments";
import type {
  TonhubObservedPayment,
  TonhubPaymentInvoiceRecord
} from "../backend/src/types";
import {
  sweepTonDepositAddress,
  type TonDepositSweepBlockchain,
  type TonDepositSweepConfig,
  type TonDepositSweepRecord,
  type TonDepositSweepRepository
} from "../worker/src/sweep";

process.env.TON_ALLOWED_NETWORKS = "testnet,mainnet";
process.env.TON_DEFAULT_NETWORK = "testnet";
process.env.TON_INVOICE_TTL_MINUTES = "60";
process.env.TON_PARTIAL_PAYMENT_TTL_HOURS = "24";

const depositPublicKey = parseTonDepositPublicKey(
  "0101010101010101010101010101010101010101010101010101010101010101"
);
const depositAddress = createTonV5R1DepositAddress({
  network: "testnet",
  publicKey: depositPublicKey,
  walletWorkchain: 0,
  walletContext: 2001
});

function makeInvoice(
  overrides: Partial<TonhubPaymentInvoiceRecord> = {}
): TonhubPaymentInvoiceRecord {
  const createdAt = new Date("2026-05-11T10:00:00.000Z");
  const expiresAt = new Date("2026-05-11T11:00:00.000Z");

  return {
    id: "gram-invoice-1",
    externalId: "order-characterization-1",
    network: "testnet",
    asset: "GRAM",
    fiatAmountCents: 500,
    fiatCurrency: "USD",
    address: depositAddress.address,
    addressRaw: depositAddress.addressRaw,
    addressStrategy: "unique-address",
    walletVersion: "v5r1",
    walletWorkchain: 0,
    walletContext: depositAddress.walletContext,
    walletNetworkGlobalId: depositAddress.walletNetworkGlobalId,
    walletPublicKeyHash: depositAddress.walletPublicKeyHash,
    amountNano: "2000000000",
    paidNano: "0",
    reference: "CHAR-GRAM-1",
    status: "PENDING",
    providerName: "ton-direct",
    observedTransactionHash: null,
    observedAt: null,
    partialPaymentStartedAt: null,
    partialPaymentExpiresAt: null,
    expiresAt,
    priceLockedAt: createdAt,
    priceLockedUntil: expiresAt,
    observedPayments: null,
    createdAt,
    updatedAt: createdAt,
    metadata: null,
    payload: {
      quote: {
        source: "coingecko",
        fiatAmountCents: 500,
        fiatAmount: 5,
        fiatCurrency: "USD",
        fiatPerGram: 2.5,
        fiatPerTon: 2.5,
        amountNano: "2000000000",
        amountGram: "2.00 GRAM (ex TON)",
        amountTon: "2.00 GRAM (ex TON)",
        updatedAt: "2026-05-11T09:59:00.000Z",
        fetchedAt: "2026-05-11T10:00:00.000Z"
      }
    },
    ...overrides
  };
}

function incomingTransaction(input: {
  hash: string;
  amountNano: string;
  at: string;
  aborted?: boolean;
}): TonCenterTransaction {
  return {
    hash: input.hash,
    now: Math.floor(new Date(input.at).getTime() / 1000),
    description: {
      aborted: input.aborted ?? false
    },
    in_msg: {
      value: input.amountNano
    }
  };
}

function createRepositoryHarness(initialInvoice: TonhubPaymentInvoiceRecord) {
  let invoice = initialInvoice;
  const calls = {
    expired: 0,
    partial: 0,
    paid: 0
  };

  function update(patch: Partial<TonhubPaymentInvoiceRecord>) {
    invoice = {
      ...invoice,
      ...patch,
      updatedAt: new Date("2026-05-11T10:10:00.000Z")
    };
    return invoice;
  }

  const repository: TonhubPaymentRepository = {
    findInvoiceById: async (id) => id === invoice.id ? invoice : null,
    findReusableInvoice: async () => null,
    createPendingInvoice: async () => {
      throw new Error("createPendingInvoice is outside this characterization harness");
    },
    markInvoiceExpired: async ({ invoiceId, expiredAt }) => {
      calls.expired += 1;
      return invoiceId === invoice.id
        ? update({ status: "EXPIRED", observedAt: expiredAt })
        : null;
    },
    markInvoicePartial: async (input) => {
      calls.partial += 1;
      return input.invoiceId === invoice.id
        ? update({
            status: "PARTIAL",
            paidNano: input.paidNano,
            partialPaymentStartedAt: input.partialPaymentStartedAt,
            partialPaymentExpiresAt: input.partialPaymentExpiresAt,
            observedPayments: input.observedPayments,
            observedAt: input.observedAt
          })
        : null;
    },
    markInvoicePaid: async (input) => {
      calls.paid += 1;
      return input.invoiceId === invoice.id
        ? update({
            status: "PAID",
            paidNano: input.paidNano,
            observedTransactionHash: input.transactionId,
            observedPayments: input.observedPayments,
            observedAt: input.paidAt
          })
        : null;
    }
  };

  return {
    repository,
    calls,
    current: () => invoice
  };
}

test("unique-address GRAM matching ignores comments and filters non-positive or out-of-window values", () => {
  const transactions: TonCenterTransaction[] = [
    incomingTransaction({
      hash: "before-window",
      amountNano: "1000000000",
      at: "2026-05-11T09:59:59.000Z"
    }),
    incomingTransaction({
      hash: "exact-start",
      amountNano: "200000000",
      at: "2026-05-11T10:00:00.000Z"
    }),
    incomingTransaction({
      hash: "zero-value",
      amountNano: "0",
      at: "2026-05-11T10:00:10.000Z"
    }),
    incomingTransaction({
      hash: "negative-value",
      amountNano: "-1",
      at: "2026-05-11T10:00:11.000Z"
    }),
    {
      hash: "malformed-value",
      now: Math.floor(new Date("2026-05-11T10:00:12.000Z").getTime() / 1000),
      in_msg: {
        value: "not-an-integer"
      }
    },
    {
      hash: "missing-timestamp",
      in_msg: {
        value: "1000000000"
      }
    },
    {
      ...incomingTransaction({
        hash: "valid-without-reference",
        amountNano: "1000000000",
        at: "2026-05-11T10:00:20.000Z"
      }),
      in_msg: {
        value: "1000000000",
        message_content: {
          decoded: {
            text: "a completely unrelated comment"
          }
        }
      }
    },
    incomingTransaction({
      hash: "exact-end",
      amountNano: "300000000",
      at: "2026-05-11T11:00:00.000Z"
    }),
    incomingTransaction({
      hash: "after-window",
      amountNano: "1000000000",
      at: "2026-05-11T11:00:01.000Z"
    })
  ];

  const matches = findTonDepositAddressPayments({
    transactions,
    notBefore: new Date("2026-05-11T10:00:00.000Z"),
    notAfter: new Date("2026-05-11T11:00:00.000Z")
  });

  assert.deepEqual(
    matches.map((match) => match.transaction.hash),
    ["exact-start", "valid-without-reference", "exact-end"]
  );
  assert.equal(matches[1]?.amountNano, "1000000000");
  assert.equal(matches[1]?.comment, "a completely unrelated comment");
});

test("legacy unique-address matching exposes aborted transfers as observed for the replacement scanner to reject", () => {
  const aborted = incomingTransaction({
    hash: "legacy-aborted-transfer",
    amountNano: "1000000000",
    at: "2026-05-11T10:30:00.000Z",
    aborted: true
  });

  const matches = findTonDepositAddressPayments({
    transactions: [aborted],
    notBefore: new Date("2026-05-11T10:00:00.000Z"),
    notAfter: new Date("2026-05-11T11:00:00.000Z")
  });

  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.status, "observed");
});

test("settlement deduplicates a repeated transaction hash and preserves overpayment", async () => {
  const harness = createRepositoryHarness(makeInvoice());
  const first = incomingTransaction({
    hash: "same-chain-transaction",
    amountNano: "1500000000",
    at: "2026-05-11T10:10:00.000Z"
  });
  const final = incomingTransaction({
    hash: "overpaying-final-transaction",
    amountNano: "750000000",
    at: "2026-05-11T10:11:00.000Z"
  });

  const settled = await settleTonhubInvoice({
    invoice: harness.current(),
    transactions: [first, first, final],
    dependencies: {
      repository: harness.repository,
      now: () => new Date("2026-05-11T10:12:00.000Z")
    }
  });

  assert.equal(settled.state, "paid");
  assert.equal(harness.current().paidNano, "2250000000");
  assert.equal(harness.calls.paid, 1);
  assert.equal(
    (harness.current().observedPayments as TonhubObservedPayment[]).length,
    2
  );
  assert.equal(harness.current().observedTransactionHash, final.hash);
});

test("settlement deduplicates a stored partial transaction when the next poll observes it again", async () => {
  const harness = createRepositoryHarness(makeInvoice());
  const first = incomingTransaction({
    hash: "stored-partial-transaction",
    amountNano: "800000000",
    at: "2026-05-11T10:10:00.000Z"
  });

  const partial = await settleTonhubInvoice({
    invoice: harness.current(),
    transactions: [first],
    dependencies: {
      repository: harness.repository,
      now: () => new Date("2026-05-11T10:11:00.000Z")
    }
  });
  assert.equal(partial.state, "pending");
  assert.equal(harness.current().paidNano, "800000000");

  const final = incomingTransaction({
    hash: "next-poll-final-transaction",
    amountNano: "1200000000",
    at: "2026-05-11T10:12:00.000Z"
  });
  const paid = await settleTonhubInvoice({
    invoice: harness.current(),
    transactions: [first, final],
    dependencies: {
      repository: harness.repository,
      now: () => new Date("2026-05-11T10:13:00.000Z")
    }
  });

  assert.equal(paid.state, "paid");
  assert.equal(harness.current().paidNano, "2000000000");
  assert.equal(
    (harness.current().observedPayments as TonhubObservedPayment[]).length,
    2
  );
  assert.equal(harness.calls.partial, 1);
  assert.equal(harness.calls.paid, 1);
});

test("a first payment inside the quote window opens a fixed 24-hour partial window", async () => {
  const harness = createRepositoryHarness(makeInvoice());
  const starter = incomingTransaction({
    hash: "partial-starter",
    amountNano: "500000000",
    at: "2026-05-11T10:45:00.000Z"
  });

  const partial = await settleTonhubInvoice({
    invoice: harness.current(),
    transactions: [starter],
    dependencies: {
      repository: harness.repository,
      now: () => new Date("2026-05-11T12:00:00.000Z")
    }
  });

  assert.equal(partial.state, "pending");
  assert.equal(harness.current().status, "PARTIAL");
  assert.equal(
    harness.current().partialPaymentStartedAt?.toISOString(),
    "2026-05-11T10:45:00.000Z"
  );
  assert.equal(
    harness.current().partialPaymentExpiresAt?.toISOString(),
    "2026-05-12T10:45:00.000Z"
  );
  assert.equal(harness.current().paidNano, "500000000");
});

test("an invoice expires without funds and a transfer after the quote deadline does not revive it", async () => {
  const harness = createRepositoryHarness(makeInvoice());
  const lateTransfer = incomingTransaction({
    hash: "late-transfer",
    amountNano: "2000000000",
    at: "2026-05-11T11:00:01.000Z"
  });

  const settled = await settleTonhubInvoice({
    invoice: harness.current(),
    transactions: [lateTransfer],
    dependencies: {
      repository: harness.repository,
      now: () => new Date("2026-05-11T11:05:00.000Z")
    }
  });

  assert.equal(settled.state, "expired");
  assert.equal(harness.current().status, "EXPIRED");
  assert.equal(harness.current().paidNano, "0");
  assert.equal(harness.calls.expired, 1);
  assert.equal(harness.calls.partial, 0);
  assert.equal(harness.calls.paid, 0);
});

test("an expiration CAS loser reports a concurrent partial winner as pending", async () => {
  for (const scenario of ["empty", "funded"] as const) {
    const harness = createRepositoryHarness(makeInvoice());
    const winner = makeInvoice({
      status: "PARTIAL",
      paidNano: "500000000",
      partialPaymentStartedAt: new Date("2026-05-11T10:30:00.000Z"),
      partialPaymentExpiresAt: new Date("2026-05-12T10:30:00.000Z")
    });
    harness.repository.markInvoiceExpired = async () => {
      harness.calls.expired += 1;
      return winner;
    };

    const settled = await settleTonhubInvoice({
      invoice: harness.current(),
      transactions: scenario === "funded"
        ? [incomingTransaction({
            hash: "stale-partial-starter",
            amountNano: "500000000",
            at: "2026-05-11T10:30:00.000Z"
          })]
        : [],
      dependencies: {
        repository: harness.repository,
        now: () => scenario === "funded"
          ? new Date("2026-05-12T10:31:00.000Z")
          : new Date("2026-05-11T11:05:00.000Z")
      }
    });

    assert.equal(settled.state, "pending", scenario);
    assert.equal(settled.invoice.status, "PARTIAL", scenario);
    assert.equal(harness.calls.expired, 1, scenario);
  }
});

test("checking a paid invoice is terminal and performs no blockchain fetch", async () => {
  const harness = createRepositoryHarness(makeInvoice({
    status: "PAID",
    paidNano: "2000000000",
    observedTransactionHash: "already-paid"
  }));
  let blockchainFetches = 0;

  const checked = await checkTonhubPaymentInvoice(harness.current().id, {
    repository: harness.repository,
    fetchTonTransactions: async () => {
      blockchainFetches += 1;
      return { transactions: [] };
    }
  });

  assert.equal(checked.status, 200);
  assert.equal((checked.body as { finalized: boolean }).finalized, true);
  assert.equal(
    (checked.body.invoice as { status: string }).status,
    "PAID"
  );
  assert.equal(blockchainFetches, 0);
  assert.deepEqual(harness.calls, {
    expired: 0,
    partial: 0,
    paid: 0
  });
});

test("checking non-payable terminal invoices returns 409 without blockchain or repository mutations", async () => {
  for (const status of ["EXPIRED", "CANCELLED", "FAILED"] as const) {
    const harness = createRepositoryHarness(makeInvoice({ status }));
    let blockchainFetches = 0;

    const checked = await checkTonhubPaymentInvoice(harness.current().id, {
      repository: harness.repository,
      fetchTonTransactions: async () => {
        blockchainFetches += 1;
        return { transactions: [] };
      }
    });

    assert.equal(checked.status, 409, status);
    assert.equal(checked.body.errorCode, "TON_INVOICE_NOT_PAYABLE", status);
    assert.equal(
      (checked.body.invoice as { status: string }).status,
      status
    );
    assert.equal(blockchainFetches, 0, status);
    assert.deepEqual(harness.calls, {
      expired: 0,
      partial: 0,
      paid: 0
    }, status);
  }
});

function makeSweepRecord(): TonDepositSweepRecord {
  return {
    id: "deposit-characterization-1",
    network: "testnet",
    address: depositAddress.address,
    addressRaw: depositAddress.addressRaw,
    walletVersion: "v5r1",
    walletWorkchain: depositAddress.walletWorkchain,
    walletContext: depositAddress.walletContext,
    walletNetworkGlobalId: depositAddress.walletNetworkGlobalId,
    walletPublicKeyHash: depositAddress.walletPublicKeyHash,
    invoiceKind: "tonhub-payment",
    invoiceId: "gram-invoice-1",
    status: "PAID",
    paidAt: new Date("2026-05-11T10:11:00.000Z"),
    sweepStatus: "NOT_STARTED",
    sweepAmountNano: null,
    sweepReserveNano: null,
    sweepRecipientAddress: null,
    sweepTransactionHash: null,
    sweepSeqno: null,
    sweepStartedAt: null,
    sweepSentAt: null,
    sweepConfirmedAt: null,
    sweepLastError: null,
    sweepAttempts: 0
  };
}

function makeSweepConfig(): TonDepositSweepConfig {
  return {
    network: "testnet" as TonNetwork,
    publicKey: depositPublicKey,
    publicKeyHash: depositAddress.walletPublicKeyHash,
    secretKey: Buffer.alloc(64),
    secretKeyEnvName: "TEST_SECRET_KEY",
    recipientAddress: depositAddress.address,
    recipientAddressRaw: depositAddress.addressRaw,
    recipientAddressEnvName: "TEST_RECIPIENT",
    reserveNano: 50_000_000n,
    minSweepNano: 1_000_000n,
    jsonRpcEndpoint: "https://testnet.toncenter.com/api/v2/jsonRPC"
  };
}

function createSweepRepositoryHarness(record: TonDepositSweepRecord) {
  let sent: Parameters<TonDepositSweepRepository["markSweepSent"]>[0] | null = null;
  let failed: Parameters<TonDepositSweepRepository["markSweepFailed"]>[0] | null = null;

  const repository: TonDepositSweepRepository = {
    listSweepCandidates: async () => [record],
    claimSweepCandidate: async ({ id, now }) => id === record.id
      ? {
          ...record,
          sweepStatus: "SWEEPING",
          sweepStartedAt: now,
          sweepAttempts: record.sweepAttempts + 1
        }
      : null,
    markSweepSent: async (input) => {
      sent = input;
    },
    markSweepFailed: async (input) => {
      failed = input;
    }
  };

  return {
    repository,
    sent: () => sent,
    failed: () => failed
  };
}

test("native GRAM sweep sends balance minus reserve and persists the broadcast metadata", async () => {
  const record = makeSweepRecord();
  const repository = createSweepRepositoryHarness(record);
  const transferAmounts: bigint[] = [];
  const blockchain: TonDepositSweepBlockchain = {
    getBalance: async () => 1_000_000_000n,
    sendSweepTransfer: async (input) => {
      transferAmounts.push(input.amountNano);
      return { seqno: 7 };
    }
  };

  const outcome = await sweepTonDepositAddress({
    record,
    config: makeSweepConfig(),
    repository: repository.repository,
    blockchain,
    now: () => new Date("2026-05-11T10:15:00.000Z")
  });

  assert.equal(outcome.status, "sent");
  assert.equal(outcome.amountNano, "950000000");
  assert.deepEqual(transferAmounts, [950_000_000n]);
  assert.equal(repository.sent()?.amountNano, "950000000");
  assert.equal(repository.sent()?.reserveNano, "50000000");
  assert.equal(repository.sent()?.seqno, 7);
  assert.equal(repository.failed(), null);
});

test("native GRAM sweep below reserve is retained and recorded as a retryable failure", async () => {
  const record = makeSweepRecord();
  const repository = createSweepRepositoryHarness(record);
  let broadcasts = 0;
  const blockchain: TonDepositSweepBlockchain = {
    getBalance: async () => 50_500_000n,
    sendSweepTransfer: async () => {
      broadcasts += 1;
      return { seqno: 1 };
    }
  };

  const outcome = await sweepTonDepositAddress({
    record,
    config: makeSweepConfig(),
    repository: repository.repository,
    blockchain,
    now: () => new Date("2026-05-11T10:15:00.000Z")
  });

  assert.equal(outcome.status, "insufficient-balance");
  assert.equal(broadcasts, 0);
  assert.equal(repository.sent(), null);
  assert.match(repository.failed()?.error ?? "", /does not exceed sweep reserve/);
});

test("native GRAM sweep makes no blockchain call when another worker already claimed the address", async () => {
  const record = makeSweepRecord();
  let blockchainCalls = 0;
  const repository: TonDepositSweepRepository = {
    listSweepCandidates: async () => [record],
    claimSweepCandidate: async () => null,
    markSweepSent: async () => {
      assert.fail("an unclaimed sweep must not be marked sent");
    },
    markSweepFailed: async () => {
      assert.fail("an unclaimed sweep must not be marked failed");
    }
  };
  const blockchain: TonDepositSweepBlockchain = {
    getBalance: async () => {
      blockchainCalls += 1;
      return 1_000_000_000n;
    },
    sendSweepTransfer: async () => {
      blockchainCalls += 1;
      return { seqno: 1 };
    }
  };

  const outcome = await sweepTonDepositAddress({
    record,
    config: makeSweepConfig(),
    repository,
    blockchain
  });

  assert.equal(outcome.status, "claimed-by-other");
  assert.equal(blockchainCalls, 0);
});

test("native GRAM sweep persists a broadcast failure for retry", async () => {
  const record = makeSweepRecord();
  const repository = createSweepRepositoryHarness(record);
  const blockchain: TonDepositSweepBlockchain = {
    getBalance: async () => 1_000_000_000n,
    sendSweepTransfer: async () => {
      throw new Error("simulated broadcast failure");
    }
  };

  const outcome = await sweepTonDepositAddress({
    record,
    config: makeSweepConfig(),
    repository: repository.repository,
    blockchain,
    now: () => new Date("2026-05-11T10:15:00.000Z")
  });

  assert.equal(outcome.status, "failed");
  assert.equal(repository.sent(), null);
  assert.equal(repository.failed()?.error, "simulated broadcast failure");
});
