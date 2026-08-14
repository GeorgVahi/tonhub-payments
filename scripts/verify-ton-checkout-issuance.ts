import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { createPrismaTonhubPaymentRepository } from "../backend/src/repository";
import type { TonhubCheckoutQuote } from "../backend/src/types";

const prisma = new PrismaClient();
const repository = createPrismaTonhubPaymentRepository(prisma as any);
const suffix = process.env.TONHUB_CHECKOUT_ISSUANCE_VERIFY_SUFFIX ?? "local";
const quotedAt = new Date(`2026-08-14T${suffix === "clean" ? "13" : "14"}:00:00.000Z`);
const expiresAt = new Date(quotedAt.getTime() + 60 * 60 * 1000);
const gramRateId = `checkout-issuance-gram-rate-${suffix}`;
const usdtRateId = `checkout-issuance-usdt-rate-${suffix}`;
const externalId = `checkout-issuance-order-${suffix}`;

const commonQuote = {
  fiatAmountCents: 10_000,
  fiatAmount: 100,
  fiatCurrency: "USD" as const,
  grossFiatMicros: "100000000",
  quotedAt,
  expiresAt,
  updatedAt: quotedAt,
  fetchedAt: quotedAt,
};
const usdtQuote: TonhubCheckoutQuote = {
  ...commonQuote,
  source: "usd-peg",
  rateSnapshotId: usdtRateId,
  asset: "USDT",
  assetDecimals: 6,
  fiatPerAsset: 1,
  discountFiatMicros: "0",
  netFiatMicros: "100000000",
  amountAtomic: "100000000",
  amountFormatted: "100.00 USD₮",
};
const gramQuote: TonhubCheckoutQuote = {
  ...commonQuote,
  source: "coingecko",
  rateSnapshotId: gramRateId,
  asset: "GRAM",
  assetDecimals: 9,
  fiatPerAsset: 2,
  fiatPerGram: 2,
  fiatPerTon: 2,
  discountFiatMicros: "1000000",
  netFiatMicros: "99000000",
  amountAtomic: "49500000000",
  amountFormatted: "49.50 GRAM (ex TON)",
  amountNano: "49500000000",
  amountGram: "49.50 GRAM (ex TON)",
  amountTon: "49.50 GRAM (ex TON)",
};
const orderPolicy = {
  minimumOrderFiatMicros: "10000000",
  gramDiscountMaxFiatMicros: "1000000",
  intermediateSweepTriggerBps: 9000,
  intermediateSweepMinFiatMicros: "100000000",
  maxAutomaticSweepsPerAsset: 2,
};

try {
  await prisma.tonhubRateSnapshot.createMany({
    data: [
      {
        id: gramRateId,
        asset: "GRAM",
        baseCurrency: "GRAM",
        quoteCurrency: "USD",
        price: "2",
        source: "coingecko",
        observedAt: quotedAt,
        fetchedAt: quotedAt,
        createdAt: quotedAt,
        payload: { verifier: "checkout-issuance" },
      },
      {
        id: usdtRateId,
        asset: "USDT",
        baseCurrency: "USDT",
        quoteCurrency: "USD",
        price: "1",
        source: "usd-peg",
        observedAt: quotedAt,
        fetchedAt: quotedAt,
        createdAt: quotedAt,
        payload: { policy: "1 USDT = 1 USD" },
      },
    ],
  });

  const input = {
    externalId,
    amountCents: 10_000,
    currency: "USD",
    network: "mainnet" as const,
    depositAddress: {
      network: "mainnet" as const,
      address: `UQ_CHECKOUT_ISSUANCE_${suffix}`,
      addressRaw: `0:checkout-issuance-${suffix}`,
      addressStrategy: "unique-address" as const,
      walletVersion: "v5r1" as const,
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 814_101 : 814_102,
      walletNetworkGlobalId: -239,
      walletPublicKeyHash: `checkout-issuance-key-${suffix}`,
    },
    reference: `CHECKOUT-ISSUANCE-${suffix}`,
    quote: usdtQuote,
    quotes: [usdtQuote, gramQuote],
    orderPolicy,
    createdAt: quotedAt,
    expiresAt,
    priceLockedAt: quotedAt,
    priceLockedUntil: expiresAt,
    activationThresholdFiatMicros: "50000000",
  };
  const invoice = await repository.createPendingInvoice(input);
  const replay = await repository.createPendingInvoice({
    ...input,
    depositAddress: {
      ...input.depositAddress,
      address: `UQ_UNUSED_CHECKOUT_ISSUANCE_${suffix}`,
      addressRaw: `0:unused-checkout-issuance-${suffix}`,
      walletContext: suffix === "clean" ? 814_103 : 814_104,
    },
  });
  assert.equal(replay.id, invoice.id);
  assert.equal(invoice.checkoutAsset, "USDT");
  assert.equal(invoice.address, input.depositAddress.address);

  const storedOrder = await prisma.tonhubPaymentOrder.findUniqueOrThrow({
    where: { externalId },
  });
  assert.deepEqual({
    fiatAmountMicros: storedOrder.fiatAmountMicros,
    discountFiatMicros: storedOrder.discountFiatMicros,
    minimumOrderFiatMicros: storedOrder.minimumOrderFiatMicros,
    gramDiscountMaxFiatMicros: storedOrder.gramDiscountMaxFiatMicros,
    intermediateSweepTriggerBps: storedOrder.intermediateSweepTriggerBps,
    intermediateSweepMinFiatMicros: storedOrder.intermediateSweepMinFiatMicros,
    maxAutomaticSweepsPerAsset: storedOrder.maxAutomaticSweepsPerAsset,
  }, {
    fiatAmountMicros: "100000000",
    discountFiatMicros: "0",
    ...orderPolicy,
  });
  const storedQuotes = await prisma.tonhubPaymentQuote.findMany({
    where: { invoiceId: invoice.id },
    orderBy: { asset: "asc" },
  });
  assert.deepEqual(storedQuotes.map((quote) => ({
    asset: quote.asset,
    amountAtomic: quote.amountAtomic,
    grossFiatMicros: quote.grossFiatMicros,
    discountFiatMicros: quote.discountFiatMicros,
    netFiatMicros: quote.netFiatMicros,
    rateSnapshotId: quote.rateSnapshotId,
  })), [
    {
      asset: "GRAM",
      amountAtomic: "49500000000",
      grossFiatMicros: "100000000",
      discountFiatMicros: "1000000",
      netFiatMicros: "99000000",
      rateSnapshotId: gramRateId,
    },
    {
      asset: "USDT",
      amountAtomic: "100000000",
      grossFiatMicros: "100000000",
      discountFiatMicros: "0",
      netFiatMicros: "100000000",
      rateSnapshotId: usdtRateId,
    },
  ]);
  assert.equal(await prisma.tonhubDepositAddress.count({ where: { invoiceId: invoice.id } }), 1);
  assert.equal((await repository.findOrderByExternalId?.(externalId))?.minimumOrderFiatMicros, "10000000");

  await assert.rejects(
    repository.createPendingInvoice({
      ...input,
      orderPolicy: { ...orderPolicy, minimumOrderFiatMicros: "20000000" },
    }),
    /different snapshotted checkout policy/,
  );
} finally {
  await prisma.$disconnect();
}
