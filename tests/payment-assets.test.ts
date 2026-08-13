import assert from "node:assert/strict";
import test from "node:test";
import { getTonhubPaymentInvoice } from "../backend/src/payments";
import type { TonhubPaymentRepository } from "../backend/src/repository";
import type { TonhubPaymentInvoiceRecord } from "../backend/src/types";
import { createTonhubPaymentRoutes } from "../backend/src/routes/payments";
import {
  ceilAtomicToPaymentUnit,
  formatAssetAmount,
  formatCheckoutAssetAmount,
  listPaymentAssets,
  parseAssetAmountToAtomic,
  parsePaymentAsset,
  paymentAssets,
  paymentUnitAtomic,
} from "../shared/payment-assets";

test("the asset registry defines GRAM and USDT without enabling USDT checkout", async () => {
  assert.deepEqual(
    listPaymentAssets().map(({ symbol, kind, decimals, checkoutFractionDigits, pricingStrategy }) => ({
      symbol,
      kind,
      decimals,
      checkoutFractionDigits,
      pricingStrategy,
    })),
    [
      {
        symbol: "GRAM",
        kind: "NATIVE",
        decimals: 9,
        checkoutFractionDigits: 2,
        pricingStrategy: "MARKET",
      },
      {
        symbol: "USDT",
        kind: "JETTON",
        decimals: 6,
        checkoutFractionDigits: 2,
        pricingStrategy: "USD_PEG",
      },
    ],
  );
  assert.equal(parsePaymentAsset("ton"), paymentAssets.GRAM);
  assert.equal(parsePaymentAsset(" usdt "), paymentAssets.USDT);
  assert.throws(() => parsePaymentAsset("USD"), /Unsupported payment asset/);
  assert.ok(Object.isFrozen(paymentAssets));
  assert.ok(Object.isFrozen(paymentAssets.GRAM));

  const response = await createTonhubPaymentRoutes().request("http://localhost/api/tonhub-payments/config");
  const body = await response.json() as {
    config: {
      defaultAsset: string;
      checkoutAssets: string[];
      assets: Array<{ symbol: string }>;
    };
  };
  assert.equal(response.status, 200);
  assert.equal(body.config.defaultAsset, "GRAM");
  assert.deepEqual(body.config.checkoutAssets, ["GRAM"]);
  assert.deepEqual(body.config.assets.map((asset) => asset.symbol), ["GRAM", "USDT"]);
});

test("atomic conversion is exact for native GRAM and six-decimal USDT", () => {
  assert.equal(parseAssetAmountToAtomic("1.23456789", "GRAM"), "1234567890");
  assert.equal(parseAssetAmountToAtomic("5", "USDT"), "5000000");
  assert.equal(parseAssetAmountToAtomic("0.000001", "USDT"), "1");
  assert.equal(formatAssetAmount("1234567890", "GRAM"), "1.23456789 GRAM (ex TON)");
  assert.equal(formatAssetAmount("5000001", "USDT"), "5.000001 USDT");
  assert.equal(formatAssetAmount("0", "USDT"), "0 USDT");
  assert.equal(
    formatAssetAmount("1234567890123456789012345", "USDT"),
    "1234567890123456789.012345 USDT",
  );
});

test("checkout rounding is asset-specific and never uses floating point", () => {
  assert.equal(paymentUnitAtomic("GRAM"), BigInt("10000000"));
  assert.equal(paymentUnitAtomic("USDT"), BigInt("10000"));
  assert.equal(ceilAtomicToPaymentUnit("10000001", "GRAM"), "20000000");
  assert.equal(ceilAtomicToPaymentUnit("5000001", "USDT"), "5010000");
  assert.equal(formatCheckoutAssetAmount("5000001", "USDT"), "5.01 USDT");
  assert.equal(formatCheckoutAssetAmount("0", "GRAM"), "0.00 GRAM (ex TON)");
});

test("invalid or lossy asset amounts are rejected", () => {
  for (const value of ["", "-1", "+1", "1e3", "1.0000001", "NaN"]) {
    assert.throws(() => parseAssetAmountToAtomic(value, "USDT"), value);
  }
  assert.throws(() => formatAssetAmount("-1", "GRAM"), /non-negative integer/);
  assert.throws(
    () => formatAssetAmount("5000001", "USDT", { fixedFractionDigits: 2 }),
    /cannot be represented exactly/,
  );
});

test("invoice responses use neutral atomic fields for a six-decimal jetton", async () => {
  const createdAt = new Date("2026-08-13T10:00:00.000Z");
  const invoice: TonhubPaymentInvoiceRecord = {
    id: "usdt-contract-invoice",
    externalId: "usdt-contract-order",
    orderId: "usdt-contract-order-id",
    network: "mainnet",
    asset: "USDT",
    checkoutAsset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    fiatAmountCents: 500,
    fiatAmountMicros: "5000000",
    creditedFiatMicros: "1000000",
    remainingFiatMicros: "4000000",
    fiatCurrency: "USD",
    address: "EQ_USDT_CONTRACT",
    addressRaw: "0:usdt-contract",
    addressStrategy: "unique-address",
    walletVersion: "v5r1",
    walletWorkchain: 0,
    walletContext: 501,
    walletNetworkGlobalId: -239,
    walletPublicKeyHash: "usdt-contract-key",
    amountNano: "5000000",
    paidNano: "1000000",
    amountAtomic: "5000000",
    paidAmountAtomic: "1000000",
    reference: "USDT-CONTRACT",
    status: "PARTIAL",
    providerName: "ton-direct",
    observedTransactionHash: null,
    observedAt: createdAt,
    firstMovementAt: createdAt,
    partialPaymentStartedAt: createdAt,
    partialPaymentExpiresAt: new Date("2026-08-14T10:00:00.000Z"),
    expiresAt: new Date("2026-08-13T11:00:00.000Z"),
    priceLockedAt: createdAt,
    priceLockedUntil: new Date("2026-08-13T11:00:00.000Z"),
    observedPayments: [{
      transactionId: "usdt-movement-1",
      asset: "USDT",
      assetDecimals: 6,
      amountAtomic: "1000000",
      amountFormatted: "1 USDT",
      createdAt: createdAt.toISOString(),
      status: "observed",
      comment: "",
    }],
    createdAt,
    updatedAt: createdAt,
    metadata: null,
    payload: {
      quote: {
        source: "usd-peg",
        asset: "USDT",
        assetDecimals: 6,
        fiatPerAsset: 1,
        amountAtomic: "5000000",
        amountFormatted: "5.00 USDT",
        fiatAmountCents: 500,
        fiatAmount: 5,
        fiatCurrency: "USD",
        updatedAt: createdAt.toISOString(),
        fetchedAt: createdAt.toISOString(),
      },
    },
  };
  const repository: TonhubPaymentRepository = {
    findInvoiceById: async () => invoice,
    findReusableInvoice: async () => null,
    createPendingInvoice: async () => invoice,
    markInvoiceExpired: async () => invoice,
    markInvoicePartial: async () => invoice,
    markInvoicePaid: async () => invoice,
  };

  const response = await getTonhubPaymentInvoice(invoice.id, { repository });
  const serialized = response.body.invoice as Record<string, unknown>;
  assert.equal(response.status, 200);
  assert.deepEqual(
    {
      asset: serialized.asset,
      assetKind: serialized.assetKind,
      assetDecimals: serialized.assetDecimals,
      amountAtomic: serialized.amountAtomic,
      amountFormatted: serialized.amountFormatted,
      expectedAmountAtomic: serialized.expectedAmountAtomic,
      expectedAmountFormatted: serialized.expectedAmountFormatted,
      paidAmountAtomic: serialized.paidAmountAtomic,
      paidAmountFormatted: serialized.paidAmountFormatted,
      remainingAmountAtomic: serialized.remainingAmountAtomic,
      remainingAmountFormatted: serialized.remainingAmountFormatted,
      deeplink: serialized.deeplink,
    },
    {
      asset: "USDT",
      assetKind: "JETTON",
      assetDecimals: 6,
      amountAtomic: "4000000",
      amountFormatted: "4.00 USDT",
      expectedAmountAtomic: "5000000",
      expectedAmountFormatted: "5.00 USDT",
      paidAmountAtomic: "1000000",
      paidAmountFormatted: "1 USDT",
      remainingAmountAtomic: "4000000",
      remainingAmountFormatted: "4.00 USDT",
      deeplink: null,
    },
  );
  assert.equal(serialized.amountGram, null);
  assert.equal(serialized.amountTon, null);
  assert.equal(serialized.amountNano, null);
  assert.equal(serialized.expectedAmountNano, null);
  assert.equal(serialized.paidNano, null);
  assert.equal(serialized.remainingNano, null);
  assert.deepEqual(serialized.quote, {
    source: "usd-peg",
    asset: "USDT",
    assetDecimals: 6,
    fiatAmountCents: 500,
    fiatAmount: 5,
    fiatCurrency: "USD",
    fiatPerGram: null,
    fiatPerTon: null,
    fiatPerAsset: 1,
    amountAtomic: "5000000",
    amountFormatted: "5.00 USDT",
    amountNano: null,
    amountGram: null,
    amountTon: null,
    updatedAt: createdAt.toISOString(),
    fetchedAt: createdAt.toISOString(),
  });
  assert.deepEqual(serialized.observedPayments, [{
    transactionId: "usdt-movement-1",
    asset: "USDT",
    assetDecimals: 6,
    amountAtomic: "1000000",
    amountFormatted: "1 USDT",
    createdAt: createdAt.toISOString(),
    status: "observed",
    comment: "",
  }]);

  for (const [patch, message] of [
    [{ assetDecimals: 9 }, /Stored USDT decimals 9 do not match registry decimals 6/],
    [{ assetKind: "NATIVE" }, /Stored USDT kind NATIVE does not match registry kind JETTON/],
  ] as const) {
    const inconsistentRepository: TonhubPaymentRepository = {
      ...repository,
      findInvoiceById: async () => ({ ...invoice, ...patch }),
    };
    await assert.rejects(
      getTonhubPaymentInvoice(invoice.id, { repository: inconsistentRepository }),
      message,
    );
  }
});
