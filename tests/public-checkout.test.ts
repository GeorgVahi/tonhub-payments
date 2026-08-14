import assert from "node:assert/strict";
import test from "node:test";
import { createTonhubPaymentInvoice } from "../backend/src/payments";
import type { TonhubPaymentRepository } from "../backend/src/repository";
import type { TonhubPaymentInvoiceRecord } from "../backend/src/types";
import { officialMainnetUsdtMasterFriendlyAddress } from "../backend/src/ton/mainnet-usdt";
import { isCheckoutAssetAvailable } from "../backend/src/checkout-assets";

const createdAt = new Date("2026-08-13T12:00:00.000Z");
const depositAddress = {
  network: "mainnet" as const,
  address: "UQ_PUBLIC_USDT_DEPOSIT",
  addressRaw: "0:public-usdt-deposit",
  addressStrategy: "unique-address" as const,
  walletVersion: "v5r1" as const,
  walletWorkchain: 0,
  walletContext: 1401,
  walletNetworkGlobalId: -239,
  walletPublicKeyHash: "public-usdt-key",
};

function publicDependencies(overrides: Record<string, unknown> = {}) {
  let createdInput: any = null;
  const repository: TonhubPaymentRepository = {
    findInvoiceById: async () => null,
    findReusableInvoice: async () => null,
    createPendingInvoice: async (input) => {
      createdInput = input;
      return {
        id: "public-usdt-invoice",
        externalId: input.externalId ?? null,
        orderId: "public-usdt-order",
        network: input.network,
        asset: input.quote.asset,
        checkoutAsset: input.quote.asset,
        assetKind: input.quote.asset === "USDT" ? "JETTON" : "NATIVE",
        assetDecimals: input.quote.assetDecimals,
        fiatAmountCents: input.amountCents,
        fiatAmountMicros: "12340000",
        creditedFiatMicros: "0",
        remainingFiatMicros: "12340000",
        activationThresholdFiatMicros: input.activationThresholdFiatMicros,
        fiatCurrency: input.currency,
        address: input.depositAddress.address,
        addressRaw: input.depositAddress.addressRaw,
        addressStrategy: input.depositAddress.addressStrategy,
        walletVersion: input.depositAddress.walletVersion,
        walletWorkchain: input.depositAddress.walletWorkchain,
        walletContext: input.depositAddress.walletContext,
        walletNetworkGlobalId: input.depositAddress.walletNetworkGlobalId,
        walletPublicKeyHash: input.depositAddress.walletPublicKeyHash,
        amountNano: input.quote.amountAtomic,
        paidNano: "0",
        amountAtomic: input.quote.amountAtomic,
        paidAmountAtomic: "0",
        reference: input.reference,
        status: "PENDING",
        providerName: "ton-jetton-direct",
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
        payload: { quote: {
          ...input.quote,
          updatedAt: input.quote.updatedAt?.toISOString() ?? null,
          fetchedAt: input.quote.fetchedAt.toISOString(),
        } },
      } as TonhubPaymentInvoiceRecord;
    },
    markInvoiceExpired: async () => null,
    markInvoicePartial: async () => null,
    markInvoicePaid: async () => null,
  };
  return {
    dependencies: {
      repository,
      now: () => createdAt,
      createTonDepositAddress: () => depositAddress,
      createTonInvoiceReference: () => "PUBLIC-USDT",
      checkoutAssetAvailable: (asset: string, network: string) => asset === "USDT" && network === "mainnet",
      defaultCheckoutAsset: () => "GRAM",
      checkoutOrderPolicy: () => ({
        minimumOrderFiatMicros: "0",
        gramDiscountMaxFiatMicros: "0",
        intermediateSweepTriggerBps: 0,
        intermediateSweepMinFiatMicros: "0",
        maxAutomaticSweepsPerAsset: 0,
      }),
      movementSettlementEnabled: () => true,
      rateSnapshotMaxAgeMs: () => 300_000,
      findRateSnapshot: async ({ asset = "USDT" }: { asset?: "GRAM" | "USDT" } = {}) => ({
        id: `${asset.toLowerCase()}-usd-checkout-snapshot`,
        asset,
        baseCurrency: asset,
        quoteCurrency: "USD" as const,
        price: asset === "GRAM" ? "2.5" : "1",
        source: asset === "GRAM" ? "coingecko" as const : "usd-peg" as const,
        observedAt: createdAt,
        fetchedAt: createdAt,
        payload: { policy: "1 USDT = 1 USD" },
        createdAt,
      }),
      ...overrides,
    },
    createdInput: () => createdInput,
  };
}

test("public mainnet checkout creates a USDT attempt from a fresh immutable rate snapshot", async () => {
  const fixture = publicDependencies();
  const response = await createTonhubPaymentInvoice({
    amount: "12.34",
    currency: "USD",
    network: "mainnet",
    asset: "USDT",
    externalId: "merchant-public-usdt",
  }, fixture.dependencies as any);

  assert.equal(response.status, 200);
  const invoice = response.body.invoice as Record<string, any>;
  assert.equal(invoice.asset, "USDT");
  assert.equal(invoice.assetKind, "JETTON");
  assert.equal(invoice.amountAtomic, "12340000");
  assert.equal(invoice.amountFormatted, "12.34 USD₮");
  assert.equal(invoice.quote.rateSnapshotId, "usdt-usd-checkout-snapshot");
  const deeplink = new URL(invoice.deeplink);
  assert.equal(deeplink.searchParams.get("jetton"), officialMainnetUsdtMasterFriendlyAddress);
  assert.equal(deeplink.searchParams.get("amount"), "12340000");
  assert.equal(fixture.createdInput().quote.asset, "USDT");
  assert.equal(fixture.createdInput().activationThresholdFiatMicros, "6170000");
});

test("mainnet checkout without an asset selects USD₮ and persists immutable USD₮ and GRAM offers", async () => {
  const fixture = publicDependencies({
    defaultCheckoutAsset: () => "USDT",
    checkoutOrderPolicy: () => ({
      minimumOrderFiatMicros: "10000000",
      gramDiscountMaxFiatMicros: "1000000",
      intermediateSweepTriggerBps: 9000,
      intermediateSweepMinFiatMicros: "100000000",
      maxAutomaticSweepsPerAsset: 2,
    }),
    checkoutAssetAvailable: (asset: string, network: string) => (
      network === "mainnet" && ["USDT", "GRAM"].includes(asset)
    ),
    findRateSnapshot: async ({ asset }: { asset: "GRAM" | "USDT" }) => ({
      id: `${asset.toLowerCase()}-usd-checkout-snapshot`,
      asset,
      baseCurrency: asset,
      quoteCurrency: "USD" as const,
      price: asset === "GRAM" ? "2" : "1",
      source: asset === "GRAM" ? "coingecko" as const : "usd-peg" as const,
      observedAt: createdAt,
      fetchedAt: createdAt,
      payload: { policy: "dual TON offer" },
      createdAt,
    }),
  });
  const response = await createTonhubPaymentInvoice({
    amount: "100.00",
    currency: "USD",
    network: "mainnet",
    externalId: "merchant-default-usdt",
  }, fixture.dependencies as any);

  assert.equal(response.status, 200);
  assert.equal((response.body.invoice as Record<string, unknown>).asset, "USDT");
  assert.equal(fixture.createdInput().quote.asset, "USDT");
  assert.deepEqual(
    fixture.createdInput().quotes.map((quote: Record<string, string>) => ({
      asset: quote.asset,
      grossFiatMicros: quote.grossFiatMicros,
      discountFiatMicros: quote.discountFiatMicros,
      netFiatMicros: quote.netFiatMicros,
      amountAtomic: quote.amountAtomic,
    })),
    [
      {
        asset: "USDT",
        grossFiatMicros: "100000000",
        discountFiatMicros: "0",
        netFiatMicros: "100000000",
        amountAtomic: "100000000",
      },
      {
        asset: "GRAM",
        grossFiatMicros: "100000000",
        discountFiatMicros: "1000000",
        netFiatMicros: "99000000",
        amountAtomic: "49500000000",
      },
    ],
  );
  assert.deepEqual(fixture.createdInput().orderPolicy, {
    minimumOrderFiatMicros: "10000000",
    gramDiscountMaxFiatMicros: "1000000",
    intermediateSweepTriggerBps: 9000,
    intermediateSweepMinFiatMicros: "100000000",
    maxAutomaticSweepsPerAsset: 2,
  });
});

test("a new order below the env-snapshotted fiat minimum is rejected before rates, address, or persistence", async () => {
  let sideEffects = 0;
  const fixture = publicDependencies({
    defaultCheckoutAsset: () => "USDT",
    checkoutOrderPolicy: () => ({
      minimumOrderFiatMicros: "10000000",
      gramDiscountMaxFiatMicros: "1000000",
      intermediateSweepTriggerBps: 9000,
      intermediateSweepMinFiatMicros: "100000000",
      maxAutomaticSweepsPerAsset: 2,
    }),
    checkoutAssetAvailable: () => true,
    findRateSnapshot: async () => { sideEffects += 1; return null; },
    createTonDepositAddress: () => { sideEffects += 1; return depositAddress; },
  });
  const response = await createTonhubPaymentInvoice({
    amount: "9.99",
    currency: "USD",
    network: "mainnet",
    externalId: "merchant-below-minimum",
  }, fixture.dependencies as any);

  assert.equal(response.status, 400);
  assert.equal(response.body.errorCode, "TON_INVOICE_BELOW_MINIMUM");
  assert.equal(sideEffects, 0);
  assert.equal(fixture.createdInput(), null);
});

test("EUR issuance keeps the gross order while quoting the €1 GRAM saving and full-price USD₮", async () => {
  const fixture = publicDependencies({
    checkoutOrderPolicy: () => ({
      minimumOrderFiatMicros: "10000000",
      gramDiscountMaxFiatMicros: "1000000",
      intermediateSweepTriggerBps: 9000,
      intermediateSweepMinFiatMicros: "100000000",
      maxAutomaticSweepsPerAsset: 2,
    }),
    checkoutAssetAvailable: (asset: string, network: string) => (
      network === "mainnet" && ["GRAM", "USDT"].includes(asset)
    ),
    findRateSnapshot: async ({ asset }: { asset: "GRAM" | "USDT" }) => ({
      id: `${asset.toLowerCase()}-eur-checkout-snapshot`,
      asset,
      baseCurrency: asset,
      quoteCurrency: "EUR" as const,
      price: asset === "GRAM" ? "1.5" : "0.9",
      source: asset === "GRAM" ? "coingecko" as const : "usd-peg" as const,
      observedAt: createdAt,
      fetchedAt: createdAt,
      payload: { policy: "dual TON EUR offer" },
      createdAt,
    }),
  });
  const response = await createTonhubPaymentInvoice({
    amount: "10.00",
    currency: "EUR",
    network: "mainnet",
    asset: "GRAM",
    externalId: "merchant-eur-dual-offer",
  }, fixture.dependencies as any);

  assert.equal(response.status, 200);
  assert.equal(fixture.createdInput().amountCents, 1_000);
  assert.deepEqual(
    fixture.createdInput().quotes.map((quote: Record<string, string>) => ({
      asset: quote.asset,
      discountFiatMicros: quote.discountFiatMicros,
      netFiatMicros: quote.netFiatMicros,
      amountAtomic: quote.amountAtomic,
    })),
    [
      {
        asset: "GRAM",
        discountFiatMicros: "1000000",
        netFiatMicros: "9000000",
        amountAtomic: "6000000000",
      },
      {
        asset: "USDT",
        discountFiatMicros: "0",
        netFiatMicros: "10000000",
        amountAtomic: "11120000",
      },
    ],
  );
});

test("mainnet canary issuance passes the merchant external id into the owner policy", async () => {
  const env = {
    TON_USDT_MAINNET_CHECKOUT_ENABLED: "false",
    TON_USDT_MAINNET_ADAPTER_ENABLED: "true",
    TON_MOVEMENT_SETTLEMENT_ENABLED: "true",
    TON_GRAM_SETTLEMENT_MODE: "ledger",
    TON_USDT_MAINNET_CANARY_EXTERNAL_IDS: "merchant-canary-order",
  };
  let checkedExternalId: string | undefined;
  const fixture = publicDependencies({
    checkoutAssetAvailable: (asset: "GRAM" | "USDT", network: "testnet" | "mainnet", externalId?: string) => {
      checkedExternalId = externalId;
      return isCheckoutAssetAvailable(asset, network, env, externalId);
    },
  });
  const response = await createTonhubPaymentInvoice({
    amount: "5.00",
    currency: "USD",
    network: "mainnet",
    asset: "USDT",
    externalId: "merchant-canary-order",
  }, fixture.dependencies as any);
  assert.equal(response.status, 200);
  assert.equal(checkedExternalId, "merchant-canary-order");

  let sideEffects = 0;
  const denied = publicDependencies({
    checkoutAssetAvailable: (asset: "GRAM" | "USDT", network: "testnet" | "mainnet", externalId?: string) => (
      isCheckoutAssetAvailable(asset, network, env, externalId)
    ),
    findRateSnapshot: async () => { sideEffects += 1; return null; },
    createTonDepositAddress: () => { sideEffects += 1; return depositAddress; },
  });
  const deniedResponse = await createTonhubPaymentInvoice({
    amount: "5.00",
    currency: "USD",
    network: "mainnet",
    asset: "USDT",
    externalId: "ordinary-order",
  }, denied.dependencies as any);
  assert.equal(deniedResponse.status, 400);
  assert.equal(sideEffects, 0);
  assert.equal(denied.createdInput(), null);
});

test("stopping mainnet canary issuance still reuses an already issued USDT attempt", async () => {
  const fixture = publicDependencies();
  let availabilityChecks = 0;
  let rateCalls = 0;
  let addressCalls = 0;
  const issued = {
    ...(await fixture.dependencies.repository.createPendingInvoice({
      externalId: "stopped-canary-order",
      amountCents: 500,
      currency: "USD",
      network: "mainnet",
      depositAddress,
      reference: "STOPPED-CANARY",
      quote: {
        source: "usd-peg",
        rateSnapshotId: "snapshot",
        asset: "USDT",
        assetDecimals: 6,
        fiatPerAsset: 1,
        amountAtomic: "5000000",
        amountFormatted: "5.00 USD₮",
        fiatAmountCents: 500,
        fiatAmount: 5,
        fiatCurrency: "USD",
        updatedAt: createdAt,
        fetchedAt: createdAt,
      },
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 3_600_000),
      priceLockedAt: createdAt,
      priceLockedUntil: new Date(createdAt.getTime() + 3_600_000),
      activationThresholdFiatMicros: "2500000",
    })),
    status: "PAID" as const,
    paidAmountAtomic: "5000000",
    paidNano: "5000000",
  };
  const response = await createTonhubPaymentInvoice({
    amount: "5.00",
    currency: "USD",
    network: "mainnet",
    asset: "USDT",
    externalId: "stopped-canary-order",
  }, {
    ...fixture.dependencies,
    repository: { ...fixture.dependencies.repository, findReusableInvoice: async () => issued },
    checkoutAssetAvailable: () => { availabilityChecks += 1; return false; },
    findRateSnapshot: async () => { rateCalls += 1; return null; },
    createTonDepositAddress: () => { addressCalls += 1; return depositAddress; },
  } as any);
  assert.equal(response.status, 200);
  assert.equal(response.body.reused, true);
  assert.equal((response.body.invoice as any).asset, "USDT");
  assert.equal(availabilityChecks + rateCalls + addressCalls, 0);
});

test("USDT is rejected on public testnet before rates, address allocation, or persistence", async () => {
  let sideEffects = 0;
  const fixture = publicDependencies({
    checkoutAssetAvailable: () => false,
    findRateSnapshot: async () => { sideEffects += 1; return null; },
    createTonDepositAddress: () => { sideEffects += 1; return depositAddress; },
  });
  const response = await createTonhubPaymentInvoice({
    amount: "5.00",
    currency: "USD",
    network: "testnet",
    asset: "USDT",
  }, fixture.dependencies as any);
  assert.equal(response.status, 400);
  assert.equal(response.body.errorCode, "TON_INVOICE_ASSET_UNAVAILABLE");
  assert.equal(sideEffects, 0);
  assert.equal(fixture.createdInput(), null);
});

test("unsupported public asset input is a client error before repository access", async () => {
  let repositoryCalls = 0;
  const fixture = publicDependencies();
  const response = await createTonhubPaymentInvoice({
    amount: "5.00",
    currency: "USD",
    network: "mainnet",
    asset: "FAKE-USDT",
  }, {
    ...fixture.dependencies,
    repository: {
      ...fixture.dependencies.repository,
      findReusableInvoice: async () => { repositoryCalls += 1; return null; },
    },
  } as any);
  assert.equal(response.status, 400);
  assert.equal(response.body.errorCode, "INVALID_INVOICE_REQUEST");
  assert.equal(repositoryCalls, 0);
});

test("a stale or missing USDT snapshot fails closed without falling back to the peg or GRAM rate", async () => {
  let gramRateCalls = 0;
  const fixture = publicDependencies({
    findRateSnapshot: async () => null,
    fetchTonFiatRate: async () => {
      gramRateCalls += 1;
      throw new Error("GRAM rate must not be used");
    },
  });
  const response = await createTonhubPaymentInvoice({
    amount: "5.00",
    currency: "EUR",
    network: "mainnet",
    asset: "USDT",
  }, fixture.dependencies as any);
  assert.equal(response.status, 503);
  assert.equal(response.body.errorCode, "TON_INVOICE_CREATE_FAILED");
  assert.match(String(response.body.error), /No fresh USDT\/EUR rate snapshot/);
  assert.equal(gramRateCalls, 0);
  assert.equal(fixture.createdInput(), null);
});

test("USDT/EUR checkout rounds the exact decimal cross up to the configured payment unit", async () => {
  const fixture = publicDependencies({
    findRateSnapshot: async () => ({
      id: "usdt-eur-checkout-snapshot",
      asset: "USDT",
      baseCurrency: "USDT",
      quoteCurrency: "EUR",
      price: "0.9",
      source: "usd-peg",
      observedAt: createdAt,
      fetchedAt: createdAt,
      payload: { derivation: "GRAM/EUR divided by GRAM/USD" },
      createdAt,
    }),
  });
  const response = await createTonhubPaymentInvoice({
    amount: "5.00",
    currency: "EUR",
    network: "mainnet",
    asset: "USDT",
  }, fixture.dependencies as any);
  assert.equal(response.status, 200);
  assert.equal((response.body.invoice as Record<string, any>).amountAtomic, "5560000");
  assert.equal((response.body.invoice as Record<string, any>).amountFormatted, "5.56 USD₮");
});

test("an existing merchant attempt keeps its original asset when a retry requests another one", async () => {
  const fixture = publicDependencies();
  const legacyGram = {
    id: "existing-gram-attempt",
    status: "PAID",
    checkoutAsset: "GRAM",
    asset: "GRAM",
    assetKind: "NATIVE",
    assetDecimals: 9,
    amountAtomic: "1000000000",
    amountNano: "1000000000",
    paidAmountAtomic: "1000000000",
    paidNano: "1000000000",
    network: "mainnet",
    externalId: "sticky-order",
    fiatAmountCents: 500,
    fiatCurrency: "USD",
    address: "UQ_EXISTING_GRAM",
    addressRaw: "0:existing-gram",
    addressStrategy: "unique-address",
    walletVersion: "v5r1",
    walletWorkchain: 0,
    walletContext: 1,
    walletNetworkGlobalId: -239,
    walletPublicKeyHash: "existing",
    reference: "EXISTING-GRAM",
    providerName: "ton-direct",
    observedTransactionHash: "aa".repeat(32),
    observedAt: createdAt,
    partialPaymentStartedAt: null,
    partialPaymentExpiresAt: null,
    expiresAt: createdAt,
    priceLockedAt: createdAt,
    priceLockedUntil: createdAt,
    observedPayments: [],
    createdAt,
    updatedAt: createdAt,
    metadata: null,
    payload: { quote: {
      source: "coingecko", asset: "GRAM", assetDecimals: 9, fiatPerAsset: 5,
      amountAtomic: "1000000000", fiatAmountCents: 500, fiatAmount: 5,
      fiatCurrency: "USD", fetchedAt: createdAt.toISOString(), updatedAt: createdAt.toISOString(),
    } },
  } as TonhubPaymentInvoiceRecord;
  const response = await createTonhubPaymentInvoice({
    amount: "5.00",
    currency: "USD",
    network: "mainnet",
    asset: "USDT",
    externalId: "sticky-order",
  }, {
    ...fixture.dependencies,
    repository: { ...fixture.dependencies.repository, findReusableInvoice: async () => legacyGram },
  } as any);
  assert.equal(response.status, 200);
  assert.equal((response.body.invoice as Record<string, unknown>).asset, "GRAM");
  assert.equal(fixture.createdInput(), null);
});

test("unique-address GRAM checkout does not ask the user to send a comment", async () => {
  const fixture = publicDependencies({
    checkoutAssetAvailable: (asset: string) => asset === "GRAM",
    fetchTonFiatRate: async () => ({
      fiatPerTon: 2.5,
      updatedAt: createdAt,
      fetchedAt: createdAt,
    }),
  });
  const response = await createTonhubPaymentInvoice({
    amount: "5.00",
    currency: "USD",
    network: "mainnet",
    asset: "GRAM",
  }, fixture.dependencies as any);
  assert.equal(response.status, 200);
  const deeplink = new URL((response.body.invoice as Record<string, any>).deeplink);
  assert.equal(deeplink.searchParams.get("amount"), "2000000000");
  assert.equal(deeplink.searchParams.has("text"), false);
});
