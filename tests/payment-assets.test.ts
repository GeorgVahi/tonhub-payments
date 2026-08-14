import assert from "node:assert/strict";
import test from "node:test";
import { Address } from "@ton/core";
import { getTonhubPaymentInvoice } from "../backend/src/payments";
import type { TonhubPaymentRepository } from "../backend/src/repository";
import type { TonhubPaymentInvoiceRecord } from "../backend/src/types";
import { createTonhubPaymentRoutes } from "../backend/src/routes/payments";

process.env.TON_USDT_MAINNET_CHECKOUT_ENABLED = "false";
process.env.TON_USDT_MAINNET_ADAPTER_ENABLED = "false";
process.env.TON_MOVEMENT_SETTLEMENT_ENABLED = "false";
delete process.env.TON_USDT_MAINNET_CANARY_EXTERNAL_IDS;
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
import { isCheckoutAssetAvailable, resolveCheckoutAssetPolicy } from "../backend/src/checkout-assets";
import { resolveCheckoutOrderPolicy } from "../backend/src/checkout-order-policy";
import { buildTonJettonTransferLink } from "../backend/src/ton/direct-payments";
import { officialMainnetUsdtMasterFriendlyAddress } from "../backend/src/ton/mainnet-usdt";
import { createTonQrSvg } from "../frontend/src/createTonQrSvg";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  checkoutAssetForNetwork,
  fiatPaymentProgress,
  PaymentStatusAnnouncement,
  TonhubPaymentWidget,
} from "../frontend/src/TonhubPaymentWidget";
import {
  buildTonConnectTransaction,
} from "../frontend/src/ton-connect-transaction";
import { normalizeTonConnectManifestUrl } from "../frontend/src/ton-connect-manifest";

test("the asset registry and default-off public policy keep testnet GRAM-only", async () => {
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
  assert.equal(paymentAssets.USDT.label, "USD₮");
  assert.throws(() => parsePaymentAsset("USD"), /Unsupported payment asset/);
  assert.ok(Object.isFrozen(paymentAssets));
  assert.ok(Object.isFrozen(paymentAssets.GRAM));

  const response = await createTonhubPaymentRoutes().request("http://localhost/api/tonhub-payments/config");
  const body = await response.json() as {
    config: {
      defaultAsset: string;
      checkoutAssets: string[];
      assets: Array<{ symbol: string; label: string }>;
      orderPolicyByCurrency: Record<string, { minimumOrderFiatMicros: string }>;
    };
  };
  assert.equal(response.status, 200);
  assert.equal(body.config.defaultAsset, "GRAM");
  assert.deepEqual(body.config.checkoutAssets, ["GRAM"]);
  assert.deepEqual(body.config.assets.map((asset) => asset.symbol), ["GRAM", "USDT"]);
  assert.equal(body.config.assets.find((asset) => asset.symbol === "USDT")?.label, "USD₮");
  assert.equal(body.config.orderPolicyByCurrency.USD?.minimumOrderFiatMicros, "10000000");
});

test("public USDT policy requires all independent mainnet settlement flags", () => {
  const enabled = resolveCheckoutAssetPolicy({
    TON_USDT_MAINNET_CHECKOUT_ENABLED: "true",
    TON_USDT_MAINNET_ADAPTER_ENABLED: "true",
    TON_MOVEMENT_SETTLEMENT_ENABLED: "true",
    TON_GRAM_SETTLEMENT_MODE: "ledger",
  });
  assert.equal(enabled.defaultAsset, "USDT");
  assert.deepEqual(enabled.checkoutAssetsByNetwork, {
    testnet: ["GRAM"],
    mainnet: ["USDT", "GRAM"],
  });
  for (const missing of [
    "TON_USDT_MAINNET_CHECKOUT_ENABLED",
    "TON_USDT_MAINNET_ADAPTER_ENABLED",
    "TON_MOVEMENT_SETTLEMENT_ENABLED",
  ]) {
    const env: Record<string, string> = {
      TON_USDT_MAINNET_CHECKOUT_ENABLED: "true",
      TON_USDT_MAINNET_ADAPTER_ENABLED: "true",
      TON_MOVEMENT_SETTLEMENT_ENABLED: "true",
      TON_GRAM_SETTLEMENT_MODE: "ledger",
    };
    env[missing] = "false";
    assert.equal(resolveCheckoutAssetPolicy(env).usdtMainnetEnabled, false, missing);
  }
  assert.equal(resolveCheckoutAssetPolicy({
    TON_USDT_MAINNET_CHECKOUT_ENABLED: "true",
    TON_USDT_MAINNET_ADAPTER_ENABLED: "true",
    TON_MOVEMENT_SETTLEMENT_ENABLED: "true",
    TON_GRAM_SETTLEMENT_MODE: "legacy",
  }).usdtMainnetEnabled, false);
  assert.equal(resolveCheckoutAssetPolicy({
    TON_USDT_MAINNET_CHECKOUT_ENABLED: "true",
    TON_USDT_MAINNET_ADAPTER_ENABLED: "true",
    TON_MOVEMENT_SETTLEMENT_ENABLED: "true",
    TON_GRAM_SETTLEMENT_MODE: "compare",
  }).usdtMainnetEnabled, false);
});

test("fiat checkout policy snapshots strict env minimum, GRAM saving, and bounded sweep policy", () => {
  assert.deepEqual(resolveCheckoutOrderPolicy("USD", {}), {
    minimumOrderFiatMicros: "10000000",
    gramDiscountMaxFiatMicros: "1000000",
    intermediateSweepTriggerBps: 9000,
    intermediateSweepMinFiatMicros: "100000000",
    maxAutomaticSweepsPerAsset: 2,
  });
  assert.deepEqual(resolveCheckoutOrderPolicy("EUR", {
    TON_MIN_ORDER_EUR_CENTS: "2500",
    TON_GRAM_DISCOUNT_EUR_CENTS: "150",
    TON_INTERMEDIATE_SWEEP_MIN_EUR_CENTS: "12500",
    TON_INTERMEDIATE_SWEEP_TRIGGER_BPS: "9500",
    TON_MAX_AUTOMATIC_SWEEPS_PER_ASSET: "1",
  }), {
    minimumOrderFiatMicros: "25000000",
    gramDiscountMaxFiatMicros: "1500000",
    intermediateSweepTriggerBps: 9500,
    intermediateSweepMinFiatMicros: "125000000",
    maxAutomaticSweepsPerAsset: 1,
  });
  assert.throws(
    () => resolveCheckoutOrderPolicy("USD", { TON_MIN_ORDER_USD_CENTS: "1000oops" }),
    /must be an integer/,
  );
  assert.throws(
    () => resolveCheckoutOrderPolicy("USD", {
      TON_MIN_ORDER_USD_CENTS: "100",
      TON_GRAM_DISCOUNT_USD_CENTS: "100",
    }),
    /must be less/,
  );
  assert.throws(
    () => resolveCheckoutOrderPolicy("USD", { TON_MAX_AUTOMATIC_SWEEPS_PER_ASSET: "3" }),
    /between 1 and 2/,
  );
});

test("mainnet USDT canary is exact-order allowlisted without public checkout exposure", () => {
  const env = {
    TON_USDT_MAINNET_CHECKOUT_ENABLED: "false",
    TON_USDT_MAINNET_ADAPTER_ENABLED: "true",
    TON_MOVEMENT_SETTLEMENT_ENABLED: "true",
    TON_GRAM_SETTLEMENT_MODE: "ledger",
    TON_USDT_MAINNET_CANARY_EXTERNAL_IDS: "canary-order-1,canary-order-2",
  };
  const policy = resolveCheckoutAssetPolicy(env);
  assert.equal(policy.usdtMainnetEnabled, false);
  assert.equal(policy.usdtMainnetCanaryEnabled, true);
  assert.deepEqual(policy.checkoutAssetsByNetwork.mainnet, ["GRAM"]);
  assert.equal(isCheckoutAssetAvailable("USDT", "mainnet", env, "canary-order-1"), true);
  assert.equal(isCheckoutAssetAvailable("USDT", "mainnet", env, "CANARY-ORDER-1"), false);
  assert.equal(isCheckoutAssetAvailable("USDT", "mainnet", env, "not-allowlisted"), false);
  assert.equal(isCheckoutAssetAvailable("USDT", "testnet", env, "canary-order-1"), false);
  assert.equal(isCheckoutAssetAvailable("GRAM", "mainnet", env), true);
  assert.equal(isCheckoutAssetAvailable("USDT", "mainnet", {
    ...env,
    TON_GRAM_SETTLEMENT_MODE: "compare",
  }, "canary-order-1"), false);
});

test("mainnet USDT canary configuration fails closed on ambiguous or oversized allowlists", () => {
  const base = {
    TON_USDT_MAINNET_ADAPTER_ENABLED: "true",
    TON_MOVEMENT_SETTLEMENT_ENABLED: "true",
    TON_GRAM_SETTLEMENT_MODE: "ledger",
  };
  assert.throws(() => resolveCheckoutAssetPolicy({
    ...base,
    TON_USDT_MAINNET_CANARY_EXTERNAL_IDS: "canary-1,,canary-2",
  }), /non-empty/i);
  assert.throws(() => resolveCheckoutAssetPolicy({
    ...base,
    TON_USDT_MAINNET_CANARY_EXTERNAL_IDS: "duplicate,duplicate",
  }), /unique/i);
  assert.throws(() => resolveCheckoutAssetPolicy({
    ...base,
    TON_USDT_MAINNET_CANARY_EXTERNAL_IDS: Array.from({ length: 21 }, (_, index) => `order-${index}`).join(","),
  }), /at most 20/i);
});

test("the widget waits for server policy and applies USDT as the mainnet default", () => {
  const available = {
    testnet: ["GRAM"],
    mainnet: ["USDT", "GRAM"],
  } as const;
  const defaults = { testnet: "GRAM", mainnet: "USDT" } as const;
  assert.equal(checkoutAssetForNetwork({
    network: "mainnet",
    defaults,
    available: {
      testnet: [...available.testnet],
      mainnet: [...available.mainnet],
    },
  }), "USDT");
  assert.equal(checkoutAssetForNetwork({
    network: "mainnet",
    requested: "GRAM",
    defaults,
    available: {
      testnet: [...available.testnet],
      mainnet: [...available.mainnet],
    },
  }), "GRAM");
  assert.deepEqual(fiatPaymentProgress({
    creditedFiatFormatted: "2.75 USD",
    remainingFiatFormatted: "2.25 USD",
    fiatCurrency: "USD",
  }), {
    paid: "2.75 USD",
    remaining: "2.25 USD",
  });

  const initialMarkup = renderToStaticMarkup(createElement(TonhubPaymentWidget, {
    initialNetwork: "mainnet",
    initialAsset: "USDT",
  }));
  assert.match(initialMarkup, /Loading payment options\.\.\.<\/button>/);
  assert.match(initialMarkup, /<button[^>]*disabled=""[^>]*>Loading payment options/);

  const statusMarkup = renderToStaticMarkup(createElement(PaymentStatusAnnouncement, {
    message: "Payment successful",
  }));
  assert.match(statusMarkup, /role="status"/);
  assert.match(statusMarkup, /aria-live="polite"/);
  assert.match(statusMarkup, /aria-atomic="true"/);
});

test("official USDT deeplink carries the unique deposit owner, master, and micro-USDT amount", () => {
  const link = buildTonJettonTransferLink({
    address: "UQ_DEPOSIT_OWNER",
    amountAtomic: "12340000",
    jettonMasterAddress: officialMainnetUsdtMasterFriendlyAddress,
  });
  const url = new URL(link);
  assert.equal(url.protocol, "ton:");
  assert.equal(url.pathname, "/UQ_DEPOSIT_OWNER");
  assert.equal(url.searchParams.get("jetton"), officialMainnetUsdtMasterFriendlyAddress);
  assert.equal(url.searchParams.get("amount"), "12340000");
  assert.equal(url.searchParams.has("text"), false);
  const realisticLink = buildTonJettonTransferLink({
    address: "UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJKZ",
    amountAtomic: "12340000",
    jettonMasterAddress: officialMainnetUsdtMasterFriendlyAddress,
  });
  const qr = createTonQrSvg(realisticLink, "light-on-dark", "USDT payment QR");
  assert.ok(qr);
  assert.match(qr, /viewBox="0 0 53 53"/);
  assert.match(qr, /aria-label="USDT payment QR"/);
});

test("TON Connect builds exact network-bound native and official-USDT payment requests", () => {
  const now = new Date("2026-08-13T10:00:00.000Z");
  const mainnetAddress = Address.parse(`0:${"21".repeat(32)}`).toString({
    bounceable: true,
    testOnly: false,
  });
  const testnetAddress = Address.parse(`0:${"22".repeat(32)}`).toString({
    bounceable: true,
    testOnly: true,
  });
  assert.equal(
    normalizeTonConnectManifestUrl("https://merchant.example/tonconnect-manifest.json"),
    "https://merchant.example/tonconnect-manifest.json",
  );
  assert.equal(normalizeTonConnectManifestUrl("http://merchant.example/manifest.json"), null);
  assert.equal(normalizeTonConnectManifestUrl("not-a-url"), null);

  assert.deepEqual(buildTonConnectTransaction({
    network: "testnet",
    asset: "GRAM",
    assetKind: "NATIVE",
    assetDecimals: 9,
    address: testnetAddress,
    addressStrategy: "unique-address",
    amountAtomic: "1250000000",
    expiresAt: "2026-08-13T10:05:00.000Z",
    priceLockedUntil: "2026-08-13T10:05:00.000Z",
    partialPaymentExpiresAt: null,
  }, now), {
    validUntil: Math.floor(now.getTime() / 1000) + 300,
    network: "-3",
    messages: [{ address: testnetAddress, amount: "1250000000" }],
  });

  assert.deepEqual(buildTonConnectTransaction({
    network: "mainnet",
    asset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    address: mainnetAddress,
    addressStrategy: "unique-address",
    amountAtomic: "12340000",
    expiresAt: "2026-08-13T11:00:00.000Z",
    priceLockedUntil: "2026-08-13T11:00:00.000Z",
    partialPaymentExpiresAt: null,
  }, now), {
    validUntil: Math.floor(now.getTime() / 1000) + 600,
    network: "-239",
    items: [{
      type: "jetton",
      master: officialMainnetUsdtMasterFriendlyAddress,
      destination: mainnetAddress,
      amount: "12340000",
    }],
  });
  assert.throws(() => buildTonConnectTransaction({
    network: "mainnet",
    asset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    address: mainnetAddress,
    addressStrategy: "unique-address",
    amountAtomic: "12340000",
    expiresAt: "2026-08-13T09:59:59.000Z",
    priceLockedUntil: "2026-08-13T09:59:59.000Z",
    partialPaymentExpiresAt: null,
  }, now), /payment window has ended/i);
  assert.throws(() => buildTonConnectTransaction({
    network: "mainnet",
    asset: "FAKE",
    assetKind: "JETTON",
    assetDecimals: 6,
    address: mainnetAddress,
    addressStrategy: "unique-address",
    amountAtomic: "12340000",
    expiresAt: "2026-08-13T11:00:00.000Z",
    priceLockedUntil: "2026-08-13T11:00:00.000Z",
    partialPaymentExpiresAt: null,
  } as never, now), /unsupported TON payment asset/i);
  assert.throws(() => buildTonConnectTransaction({
    network: "sandbox",
    asset: "GRAM",
    assetKind: "NATIVE",
    assetDecimals: 9,
    address: mainnetAddress,
    addressStrategy: "unique-address",
    amountAtomic: "12340000",
    expiresAt: "2026-08-13T11:00:00.000Z",
    priceLockedUntil: "2026-08-13T11:00:00.000Z",
    partialPaymentExpiresAt: null,
  } as never, now), /unsupported TON payment network/i);
  assert.throws(() => buildTonConnectTransaction({
    network: "mainnet",
    asset: "USDT",
    assetKind: "NATIVE",
    assetDecimals: 9,
    address: mainnetAddress,
    addressStrategy: "unique-address",
    amountAtomic: "12340000",
    expiresAt: "2026-08-13T11:00:00.000Z",
    priceLockedUntil: "2026-08-13T11:00:00.000Z",
    partialPaymentExpiresAt: null,
  } as never, now), /asset identity does not match/i);
  assert.throws(() => buildTonConnectTransaction({
    network: "testnet",
    asset: "GRAM",
    assetKind: "NATIVE",
    assetDecimals: 9,
    address: testnetAddress,
    addressStrategy: "reference",
    amountAtomic: "1250000000",
    expiresAt: "2026-08-13T10:05:00.000Z",
    priceLockedUntil: "2026-08-13T10:05:00.000Z",
    partialPaymentExpiresAt: null,
  }, now), /unique deposit address/i);
  assert.throws(() => buildTonConnectTransaction({
    network: "testnet",
    asset: "GRAM",
    assetKind: "NATIVE",
    assetDecimals: 9,
    address: testnetAddress,
    addressStrategy: "unique-address",
    amountAtomic: "1250000000",
    expiresAt: null,
    priceLockedUntil: null,
    partialPaymentExpiresAt: null,
  }, now), /authoritative payment deadline/i);
});

test("atomic conversion is exact for native GRAM and six-decimal USDT", () => {
  assert.equal(parseAssetAmountToAtomic("1.23456789", "GRAM"), "1234567890");
  assert.equal(parseAssetAmountToAtomic("5", "USDT"), "5000000");
  assert.equal(parseAssetAmountToAtomic("0.000001", "USDT"), "1");
  assert.equal(formatAssetAmount("1234567890", "GRAM"), "1.23456789 GRAM (ex TON)");
  assert.equal(formatAssetAmount("5000001", "USDT"), "5.000001 USD₮");
  assert.equal(formatAssetAmount("0", "USDT"), "0 USD₮");
  assert.equal(
    formatAssetAmount("1234567890123456789012345", "USDT"),
    "1234567890123456789.012345 USD₮",
  );
});

test("checkout rounding is asset-specific and never uses floating point", () => {
  assert.equal(paymentUnitAtomic("GRAM"), BigInt("10000000"));
  assert.equal(paymentUnitAtomic("USDT"), BigInt("10000"));
  assert.equal(ceilAtomicToPaymentUnit("10000001", "GRAM"), "20000000");
  assert.equal(ceilAtomicToPaymentUnit("5000001", "USDT"), "5010000");
  assert.equal(formatCheckoutAssetAmount("5000001", "USDT"), "5.01 USD₮");
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
    quotes: [
      {
        id: "usdt-contract-quote",
        orderId: "usdt-contract-order-id",
        invoiceId: "usdt-contract-invoice",
        network: "mainnet",
        asset: "USDT",
        assetKind: "JETTON",
        assetDecimals: 6,
        fiatCurrency: "USD",
        grossFiatMicros: "5000000",
        discountFiatMicros: "0",
        netFiatMicros: "5000000",
        amountAtomic: "5000000",
        rateSnapshotId: "usdt-contract-rate",
        quotedAt: createdAt,
        expiresAt: new Date("2026-08-13T11:00:00.000Z"),
        createdAt,
        rateSnapshot: {
          price: "1",
          source: "usd-peg",
          observedAt: createdAt,
          fetchedAt: createdAt,
        },
      },
      {
        id: "gram-contract-quote",
        orderId: "usdt-contract-order-id",
        invoiceId: "usdt-contract-invoice",
        network: "mainnet",
        asset: "GRAM",
        assetKind: "NATIVE",
        assetDecimals: 9,
        fiatCurrency: "USD",
        grossFiatMicros: "5000000",
        discountFiatMicros: "1000000",
        netFiatMicros: "4000000",
        amountAtomic: "2000000000",
        rateSnapshotId: "gram-contract-rate",
        quotedAt: createdAt,
        expiresAt: new Date("2026-08-13T11:00:00.000Z"),
        createdAt,
        rateSnapshot: {
          price: "2",
          source: "coingecko",
          observedAt: createdAt,
          fetchedAt: createdAt,
        },
      },
    ],
    payload: {
      quote: {
        source: "coingecko",
        asset: "USDT",
        assetDecimals: 6,
        fiatPerAsset: 999,
        amountAtomic: "999000000",
        amountFormatted: "999 USD₮",
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
      creditedFiatFormatted: serialized.creditedFiatFormatted,
      remainingAmountAtomic: serialized.remainingAmountAtomic,
      remainingAmountFormatted: serialized.remainingAmountFormatted,
      remainingFiatFormatted: serialized.remainingFiatFormatted,
      deeplink: serialized.deeplink,
    },
    {
      asset: "USDT",
      assetKind: "JETTON",
      assetDecimals: 6,
      amountAtomic: "4000000",
      amountFormatted: "4.00 USD₮",
      expectedAmountAtomic: "5000000",
      expectedAmountFormatted: "5.00 USD₮",
      paidAmountAtomic: "1000000",
      paidAmountFormatted: "1 USD₮",
      creditedFiatFormatted: "1.00 USD",
      remainingAmountAtomic: "4000000",
      remainingAmountFormatted: "4.00 USD₮",
      remainingFiatFormatted: "4.00 USD",
      deeplink: `ton://transfer/EQ_USDT_CONTRACT?jetton=${officialMainnetUsdtMasterFriendlyAddress}&amount=4000000`,
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
    rateSnapshotId: "usdt-contract-rate",
    asset: "USDT",
    label: "USD₮",
    assetDecimals: 6,
    fiatAmountCents: 500,
    fiatAmount: 5,
    fiatCurrency: "USD",
    fiatPerGram: null,
    fiatPerTon: null,
    fiatPerAsset: 1,
    amountAtomic: "5000000",
    amountFormatted: "5.00 USD₮",
    grossFiatMicros: "5000000",
    discountFiatMicros: "0",
    netFiatMicros: "5000000",
    quotedAt: createdAt.toISOString(),
    expiresAt: new Date("2026-08-13T11:00:00.000Z").toISOString(),
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
    amountFormatted: "1 USD₮",
    createdAt: createdAt.toISOString(),
    status: "observed",
    comment: "",
  }]);
  assert.deepEqual(
    (serialized.paymentOptions as Array<Record<string, unknown>>).map((option) => ({
      asset: option.asset,
      label: option.label,
      discountFiatMicros: option.discountFiatMicros,
      amountAtomic: option.amountAtomic,
      fiatPerAsset: option.fiatPerAsset,
    })),
    [
      {
        asset: "USDT",
        label: "USD₮",
        discountFiatMicros: "0",
        amountAtomic: "5000000",
        fiatPerAsset: 1,
      },
      {
        asset: "GRAM",
        label: "GRAM (ex TON)",
        discountFiatMicros: "1000000",
        amountAtomic: "2000000000",
        fiatPerAsset: 2,
      },
    ],
  );

  const internalTestnetRepository: TonhubPaymentRepository = {
    ...repository,
    findInvoiceById: async () => ({ ...invoice, network: "testnet" }),
  };
  const internalTestnetResponse = await getTonhubPaymentInvoice(invoice.id, {
    repository: internalTestnetRepository,
  });
  assert.equal(
    (internalTestnetResponse.body.invoice as { deeplink: string | null }).deeplink,
    null,
  );
  const nonUniqueRepository: TonhubPaymentRepository = {
    ...repository,
    findInvoiceById: async () => ({ ...invoice, addressStrategy: "comment" }),
  };
  const nonUniqueResponse = await getTonhubPaymentInvoice(invoice.id, {
    repository: nonUniqueRepository,
  });
  assert.equal(
    (nonUniqueResponse.body.invoice as { deeplink: string | null }).deeplink,
    null,
  );

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
