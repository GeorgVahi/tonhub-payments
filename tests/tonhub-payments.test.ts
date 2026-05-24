import assert from "node:assert/strict";
import {
  buildTonTransferLink,
  formatNanoTon,
  parseTonAmountToNano,
  type TonCenterTransaction
} from "../backend/src/ton/direct-payments";
import {
  createTonV5R1DepositAddress,
  parseTonDepositPublicKey
} from "../backend/src/ton/deposit-addresses";
import { findTonDepositAddressPayments } from "../backend/src/ton/matching";
import {
  checkTonhubPaymentInvoice,
  createTonhubPaymentInvoice
} from "../backend/src/payments";
import { createTonQrSvg } from "../frontend/src/createTonQrSvg";
import type {
  TonhubObservedPayment,
  TonhubPaymentInvoiceRecord
} from "../backend/src/types";
import type { TonhubPaymentRepository } from "../backend/src/repository";

process.env.TON_ALLOWED_NETWORKS = "testnet,mainnet";
process.env.TON_DEFAULT_NETWORK = "testnet";
process.env.TON_INVOICE_REFERENCE_PREFIX = "TESTPAY";

assert.equal(parseTonAmountToNano("0.01"), "10000000");
assert.equal(formatNanoTon("1234567890"), "1.23456789 TON");

const deeplink = buildTonTransferLink({
  address: "EQ_TEST_ADDRESS",
  amountNano: "10000000",
  comment: "TESTPAY-ABC123"
});
assert.equal(
  deeplink,
  "ton://transfer/EQ_TEST_ADDRESS?amount=10000000&text=TESTPAY-ABC123"
);
assert.ok(createTonQrSvg(deeplink));

const depositPublicKey = parseTonDepositPublicKey(
  "0101010101010101010101010101010101010101010101010101010101010101"
);
const depositAddress = createTonV5R1DepositAddress({
  network: "testnet",
  publicKey: depositPublicKey,
  walletWorkchain: 0,
  walletContext: 1001
});
assert.equal(depositAddress.addressStrategy, "unique-address");
assert.equal(depositAddress.walletVersion, "v5r1");

let currentInvoice: TonhubPaymentInvoiceRecord | null = null;
let currentTransactions: TonCenterTransaction[] = [];

function updateInvoice(patch: Partial<TonhubPaymentInvoiceRecord>) {
  assert.ok(currentInvoice);
  currentInvoice = {
    ...currentInvoice,
    ...patch,
    updatedAt: new Date("2026-05-11T10:01:00.000Z")
  };
  return currentInvoice;
}

const repository: TonhubPaymentRepository = {
  findInvoiceById: async (id) => currentInvoice?.id === id ? currentInvoice : null,
  findReusableInvoice: async ({ externalId, network }) => {
    const invoice = currentInvoice;
    if (!invoice) {
      return null;
    }

    return invoice.externalId === externalId &&
      invoice.network === network &&
      (invoice.status === "PENDING" || invoice.status === "PARTIAL")
        ? invoice
        : null;
  },
  createPendingInvoice: async (input) => {
    currentInvoice = {
      id: "tonhub-invoice-1",
      externalId: input.externalId || null,
      network: input.network,
      asset: "TON",
      fiatAmountCents: input.amountCents,
      fiatCurrency: input.currency,
      address: input.depositAddress.address,
      addressRaw: input.depositAddress.addressRaw,
      addressStrategy: input.depositAddress.addressStrategy,
      walletVersion: input.depositAddress.walletVersion,
      walletWorkchain: input.depositAddress.walletWorkchain,
      walletContext: input.depositAddress.walletContext,
      walletNetworkGlobalId: input.depositAddress.walletNetworkGlobalId,
      walletPublicKeyHash: input.depositAddress.walletPublicKeyHash,
      amountNano: input.quote.amountNano,
      paidNano: "0",
      reference: input.reference,
      status: "PENDING",
      providerName: "ton-direct",
      observedTransactionHash: null,
      observedAt: null,
      partialPaymentStartedAt: null,
      partialPaymentExpiresAt: null,
      expiresAt: input.expiresAt,
      priceLockedAt: input.priceLockedAt,
      priceLockedUntil: input.priceLockedUntil,
      observedPayments: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      metadata: input.metadata ?? null,
      payload: {
        quote: {
          ...input.quote,
          updatedAt: input.quote.updatedAt?.toISOString() ?? null,
          fetchedAt: input.quote.fetchedAt.toISOString()
        }
      }
    };
    return currentInvoice;
  },
  markInvoiceExpired: async ({ invoiceId, expiredAt }) =>
    currentInvoice?.id === invoiceId
      ? updateInvoice({ status: "EXPIRED", observedAt: expiredAt })
      : null,
  markInvoicePartial: async (input) =>
    currentInvoice?.id === input.invoiceId
      ? updateInvoice({
          status: "PARTIAL",
          paidNano: input.paidNano,
          partialPaymentStartedAt: input.partialPaymentStartedAt,
          partialPaymentExpiresAt: input.partialPaymentExpiresAt,
          observedAt: input.observedAt,
          observedPayments: input.observedPayments
        })
      : null,
  markInvoicePaid: async (input) =>
    currentInvoice?.id === input.invoiceId
      ? updateInvoice({
          status: "PAID",
          paidNano: input.paidNano,
          observedTransactionHash: input.transactionId,
          observedAt: input.paidAt,
          observedPayments: input.observedPayments
        })
      : null
};

const dependencies = {
  repository,
  now: () => new Date("2026-05-11T10:00:00.000Z"),
  resolveTonApiConfig: () => ({
    network: "testnet" as const,
    baseUrl: "https://testnet.toncenter.com/api/v3",
    address: "",
    addressEnvName: "",
    apiKey: "test-key",
    apiKeyEnvName: "TON_TESTNET_API_KEY"
  }),
  fetchTonTransactions: async () => ({ transactions: currentTransactions }),
  fetchTonFiatRate: async () => ({
    fiatPerTon: 2.5,
    updatedAt: new Date("2026-05-11T09:59:00.000Z"),
    fetchedAt: new Date("2026-05-11T10:00:00.000Z")
  }),
  createTonDepositAddress: () => depositAddress,
  createTonInvoiceReference: () => "TESTPAY-GENERATED"
};

const created = await createTonhubPaymentInvoice(
  {
    amount: "5.00",
    currency: "USD",
    network: "testnet",
    externalId: "order-1",
    metadata: {
      orderId: "order-1"
    }
  },
  dependencies
);
assert.equal(created.status, 200);
assert.equal((created.body.invoice as { amountNano: string }).amountNano, "2000000000");
assert.equal((created.body.invoice as { fiatCurrency: string }).fiatCurrency, "USD");
assert.equal((created.body.invoice as { network: string }).network, "testnet");
assert.equal((created.body.invoice as { address: string }).address, depositAddress.address);

currentTransactions = [
  {
    hash: "partial-payment",
    now: 1_778_494_500,
    description: {
      aborted: false
    },
    in_msg: {
      value: "1000000000"
    }
  }
];
const partial = await checkTonhubPaymentInvoice("tonhub-invoice-1", dependencies);
assert.equal(partial.status, 200);
assert.equal((partial.body.invoice as { status: string }).status, "PARTIAL");
assert.equal((partial.body.invoice as { paidNano: string }).paidNano, "1000000000");
assert.equal((partial.body.invoice as { remainingNano: string }).remainingNano, "1000000000");

currentTransactions = [
  ...currentTransactions,
  {
    hash: "final-payment",
    now: 1_778_494_560,
    description: {
      aborted: false
    },
    in_msg: {
      value: "1000000000"
    }
  }
];
const paid = await checkTonhubPaymentInvoice("tonhub-invoice-1", dependencies);
assert.equal(paid.status, 200);
assert.equal((paid.body.invoice as { status: string }).status, "PAID");
assert.equal((paid.body.invoice as { paidNano: string }).paidNano, "2000000000");
assert.equal((paid.body as { finalized: boolean }).finalized, true);
const paidInvoice = currentInvoice as TonhubPaymentInvoiceRecord | null;
assert.ok(paidInvoice);
assert.equal(
  ((paidInvoice.observedPayments as TonhubObservedPayment[]) ?? []).length,
  2
);

const depositMatches = findTonDepositAddressPayments({
  transactions: currentTransactions,
  notBefore: new Date("2026-05-11T09:00:00.000Z")
});
assert.equal(depositMatches.length, 2);

console.log("ok - tonhub-payments creates unique-address TON invoices and settles partial/full payments");
