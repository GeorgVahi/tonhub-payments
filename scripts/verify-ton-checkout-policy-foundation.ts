import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const suffix = process.env.TONHUB_CHECKOUT_POLICY_VERIFY_SUFFIX ?? "local";
const at = (minute: number) => new Date(`2026-08-14T10:${minute.toString().padStart(2, "0")}:00.000Z`);

const ids = {
  order: `checkout-policy-order-${suffix}`,
  invoice: `checkout-policy-invoice-${suffix}`,
  deposit: `checkout-policy-deposit-${suffix}`,
  gramRate: `checkout-policy-gram-rate-${suffix}`,
  usdtRate: `checkout-policy-usdt-rate-${suffix}`,
  gramQuote: `checkout-policy-gram-quote-${suffix}`,
  usdtQuote: `checkout-policy-usdt-quote-${suffix}`,
  movement: `checkout-policy-movement-${suffix}`,
  allocation: `checkout-policy-allocation-${suffix}`,
  adjustment: `checkout-policy-adjustment-${suffix}`,
};

try {
  const legacyShapedOrder = await prisma.tonhubPaymentOrder.create({
    data: {
      id: `checkout-policy-defaults-${suffix}`,
      fiatAmountMicros: "1000000",
      fiatCurrency: "USD",
    },
  });
  assert.equal(legacyShapedOrder.discountFiatMicros, "0");
  assert.equal(legacyShapedOrder.minimumOrderFiatMicros, "0");
  assert.equal(legacyShapedOrder.gramDiscountMaxFiatMicros, "0");
  assert.equal(legacyShapedOrder.intermediateSweepTriggerBps, 0);
  assert.equal(legacyShapedOrder.intermediateSweepMinFiatMicros, "0");
  assert.equal(legacyShapedOrder.maxAutomaticSweepsPerAsset, 0);

  await prisma.tonhubRateSnapshot.createMany({
    data: [
      {
        id: ids.gramRate,
        asset: "GRAM",
        baseCurrency: "GRAM",
        quoteCurrency: "USD",
        price: "1",
        source: "coingecko",
        observedAt: at(0),
        fetchedAt: at(1),
        createdAt: at(1),
        payload: { verifier: "dual-ton-quote" },
      },
      {
        id: ids.usdtRate,
        asset: "USDT",
        baseCurrency: "USDT",
        quoteCurrency: "USD",
        price: "1",
        source: "usd-peg",
        observedAt: at(0),
        fetchedAt: at(1),
        createdAt: at(1),
        payload: { policy: "1 USDT = 1 USD" },
      },
    ],
  });

  const testnetInvoice = await prisma.tonhubPaymentInvoice.create({
    data: {
      id: `checkout-policy-testnet-invoice-${suffix}`,
      orderId: legacyShapedOrder.id,
      network: "testnet",
      asset: "GRAM",
      checkoutAsset: "GRAM",
      assetKind: "NATIVE",
      assetDecimals: 9,
      fiatAmountCents: 100,
      fiatAmountMicros: "1000000",
      remainingFiatMicros: "1000000",
      fiatCurrency: "USD",
      address: `checkout-policy-testnet-address-${suffix}`,
      addressRaw: `0:checkout-policy-testnet-address-${suffix}`,
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 814_031 : 814_032,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: `checkout-policy-testnet-key-${suffix}`,
      amountNano: "1000000000",
      amountAtomic: "1000000000",
      reference: `checkout-policy-testnet-reference-${suffix}`,
      expiresAt: at(59),
      priceLockedAt: at(1),
      priceLockedUntil: at(59),
      createdAt: at(1),
      updatedAt: at(1),
    },
  });
  await assert.rejects(
    prisma.tonhubPaymentQuote.create({
      data: {
        id: `checkout-policy-testnet-usdt-quote-${suffix}`,
        orderId: legacyShapedOrder.id,
        invoiceId: testnetInvoice.id,
        network: "testnet",
        asset: "USDT",
        assetKind: "JETTON",
        assetDecimals: 6,
        fiatCurrency: "USD",
        grossFiatMicros: "1000000",
        discountFiatMicros: "0",
        netFiatMicros: "1000000",
        amountAtomic: "1000000",
        rateSnapshotId: ids.usdtRate,
        quotedAt: at(2),
        expiresAt: at(59),
        createdAt: at(2),
      },
    }),
  );
  let releaseBasisRace!: () => void;
  let readyBasisRacers = 0;
  const basisRaceBarrier = new Promise<void>((resolve) => { releaseBasisRace = resolve; });
  const startBasisRace = async () => {
    readyBasisRacers += 1;
    if (readyBasisRacers === 2) {
      releaseBasisRace();
    }
    await basisRaceBarrier;
  };
  const basisRaceResults = await Promise.allSettled([
    prisma.$transaction(async (tx) => {
      await startBasisRace();
      return tx.tonhubPaymentQuote.create({
        data: {
          id: `checkout-policy-testnet-gram-quote-${suffix}`,
          orderId: legacyShapedOrder.id,
          invoiceId: testnetInvoice.id,
          network: "testnet",
          asset: "GRAM",
          assetKind: "NATIVE",
          assetDecimals: 9,
          fiatCurrency: "USD",
          grossFiatMicros: "1000000",
          discountFiatMicros: "0",
          netFiatMicros: "1000000",
          amountAtomic: "1000000000",
          rateSnapshotId: ids.gramRate,
          quotedAt: at(2),
          expiresAt: at(59),
          createdAt: at(2),
        },
      });
    }),
    prisma.$transaction(async (tx) => {
      await startBasisRace();
      return tx.tonhubPaymentInvoice.update({
        where: { id: testnetInvoice.id },
        data: { fiatCurrency: "EUR" },
      });
    }),
  ]);
  assert.equal(basisRaceResults.filter(({ status }) => status === "fulfilled").length, 1);
  const testnetGramQuote = await prisma.tonhubPaymentQuote.findFirst({
    where: { invoiceId: testnetInvoice.id, asset: "GRAM" },
  });
  assert.equal(
    (await prisma.tonhubPaymentInvoice.findUniqueOrThrow({ where: { id: testnetInvoice.id } })).fiatCurrency,
    testnetGramQuote ? "USD" : "EUR",
  );

  await prisma.tonhubPaymentOrder.create({
    data: {
      id: ids.order,
      externalId: `checkout-policy-external-${suffix}`,
      fiatAmountMicros: "100000000",
      fiatCurrency: "USD",
      minimumOrderFiatMicros: "10000000",
      gramDiscountMaxFiatMicros: "1000000",
      intermediateSweepTriggerBps: 9000,
      intermediateSweepMinFiatMicros: "100000000",
      maxAutomaticSweepsPerAsset: 2,
      expiresAt: at(59),
      createdAt: at(1),
      updatedAt: at(1),
    },
  });
  await prisma.tonhubPaymentInvoice.create({
    data: {
      id: ids.invoice,
      orderId: ids.order,
      network: "mainnet",
      asset: "GRAM",
      checkoutAsset: "GRAM",
      assetKind: "NATIVE",
      assetDecimals: 9,
      fiatAmountCents: 10_000,
      fiatAmountMicros: "100000000",
      creditedFiatMicros: "99000000",
      remainingFiatMicros: "1000000",
      activationThresholdFiatMicros: "50000000",
      fiatCurrency: "USD",
      address: `checkout-policy-address-${suffix}`,
      addressRaw: `0:checkout-policy-address-${suffix}`,
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 814_001 : 814_002,
      walletNetworkGlobalId: -239,
      walletPublicKeyHash: `checkout-policy-key-${suffix}`,
      amountNano: "99000000000",
      amountAtomic: "99000000000",
      paidNano: "99000000000",
      paidAmountAtomic: "99000000000",
      reference: `checkout-policy-reference-${suffix}`,
      status: "PARTIAL",
      firstMovementAt: at(3),
      partialPaymentStartedAt: at(3),
      partialPaymentExpiresAt: new Date("2026-08-15T10:03:00.000Z"),
      expiresAt: at(59),
      priceLockedAt: at(1),
      priceLockedUntil: at(59),
      paymentSelectionLockedAsset: "GRAM",
      paymentSelectionLockedAt: at(3),
      createdAt: at(1),
      updatedAt: at(3),
    },
  });
  await prisma.tonhubDepositAddress.create({
    data: {
      id: ids.deposit,
      invoiceId: ids.invoice,
      network: "mainnet",
      address: `checkout-policy-address-${suffix}`,
      addressRaw: `0:checkout-policy-address-${suffix}`,
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 814_001 : 814_002,
      walletNetworkGlobalId: -239,
      walletPublicKeyHash: `checkout-policy-key-${suffix}`,
      status: "ACTIVE",
      createdAt: at(1),
      updatedAt: at(1),
    },
  });

  await prisma.tonhubPaymentQuote.createMany({
    data: [
      {
        id: ids.gramQuote,
        orderId: ids.order,
        invoiceId: ids.invoice,
        network: "mainnet",
        asset: "GRAM",
        assetKind: "NATIVE",
        assetDecimals: 9,
        fiatCurrency: "USD",
        grossFiatMicros: "100000000",
        discountFiatMicros: "1000000",
        netFiatMicros: "99000000",
        amountAtomic: "99000000000",
        rateSnapshotId: ids.gramRate,
        quotedAt: at(2),
        expiresAt: at(59),
        createdAt: at(2),
      },
      {
        id: ids.usdtQuote,
        orderId: ids.order,
        invoiceId: ids.invoice,
        network: "mainnet",
        asset: "USDT",
        assetKind: "JETTON",
        assetDecimals: 6,
        fiatCurrency: "USD",
        grossFiatMicros: "100000000",
        discountFiatMicros: "0",
        netFiatMicros: "100000000",
        amountAtomic: "100000000",
        rateSnapshotId: ids.usdtRate,
        quotedAt: at(2),
        expiresAt: at(59),
        createdAt: at(2),
      },
    ],
  });
  const quotes = await prisma.tonhubPaymentQuote.findMany({
    where: { invoiceId: ids.invoice },
    orderBy: { asset: "asc" },
  });
  assert.deepEqual(
    quotes.map(({ asset, grossFiatMicros, discountFiatMicros, netFiatMicros, amountAtomic }) => ({
      asset,
      grossFiatMicros,
      discountFiatMicros,
      netFiatMicros,
      amountAtomic,
    })),
    [
      {
        asset: "GRAM",
        grossFiatMicros: "100000000",
        discountFiatMicros: "1000000",
        netFiatMicros: "99000000",
        amountAtomic: "99000000000",
      },
      {
        asset: "USDT",
        grossFiatMicros: "100000000",
        discountFiatMicros: "0",
        netFiatMicros: "100000000",
        amountAtomic: "100000000",
      },
    ],
  );
  assert.deepEqual(
    quotes.map(({ orderId, network }) => ({ orderId, network })),
    [
      { orderId: ids.order, network: "mainnet" },
      { orderId: ids.order, network: "mainnet" },
    ],
  );
  for (const data of [
    { orderId: legacyShapedOrder.id },
    { network: "testnet" },
    { fiatAmountMicros: "99000000" },
    { fiatCurrency: "EUR" },
    { createdAt: at(0) },
    { priceLockedUntil: at(58) },
    { expiresAt: at(58) },
  ]) {
    await assert.rejects(
      prisma.tonhubPaymentInvoice.update({
        where: { id: ids.invoice },
        data,
      }),
      /quote ownership and pricing basis are immutable/,
    );
  }
  await assert.rejects(
    prisma.tonhubPaymentInvoice.delete({ where: { id: ids.invoice } }),
  );
  await assert.rejects(
    prisma.tonhubPaymentOrder.delete({ where: { id: ids.order } }),
  );

  await assert.rejects(
    prisma.tonhubPaymentQuote.update({
      where: { id: ids.gramQuote },
      data: { discountFiatMicros: "0" },
    }),
    /append-only/,
  );
  await assert.rejects(
    prisma.tonhubPaymentQuote.delete({ where: { id: ids.usdtQuote } }),
    /append-only/,
  );

  await prisma.tonhubPaymentMovement.create({
    data: {
      id: ids.movement,
      fingerprint: `mainnet:checkout-policy:${suffix}:incoming:0`,
      depositAddressId: ids.deposit,
      network: "mainnet",
      direction: "INCOMING",
      asset: "GRAM",
      assetKind: "NATIVE",
      assetDecimals: 9,
      amountAtomic: "99000000000",
      fromAddress: `checkout-policy-sender-${suffix}`,
      toAddress: `checkout-policy-address-${suffix}`,
      transactionHash: "ab".repeat(32),
      transactionLt: suffix === "clean" ? "814001" : "814002",
      blockchainAt: at(3),
      status: "CREDITED",
      validationCode: "NATIVE_INBOUND_V1",
      rateSnapshotId: ids.gramRate,
      fiatCreditMicros: "99000000",
      createdAt: at(4),
      updatedAt: at(4),
    },
  });
  await prisma.tonhubMovementAllocation.create({
    data: {
      id: ids.allocation,
      movementId: ids.movement,
      orderId: ids.order,
      invoiceId: ids.invoice,
      kind: "CREDIT",
      fiatCreditMicros: "99000000",
      allocatedAt: at(4),
    },
  });

  await assert.rejects(
    prisma.tonhubOrderAdjustment.create({
      data: {
        id: `checkout-policy-wrong-shortfall-${suffix}`,
        idempotencyKey: `checkout-policy-wrong-shortfall-${suffix}`,
        orderId: ids.order,
        invoiceId: ids.invoice,
        quoteId: ids.gramQuote,
        fiatAmountMicros: "500000",
        fiatCurrency: "USD",
        reason: "GRAM_ONLY_PAYMENT",
        createdAt: at(5),
      },
    }),
    /all-GRAM shortfall/,
  );
  await assert.rejects(
    prisma.tonhubPaymentOrder.update({
      where: { id: ids.order },
      data: { discountFiatMicros: "1000000" },
    }),
    /must equal append-only adjustment evidence/,
  );

  const adjustment = await prisma.tonhubOrderAdjustment.create({
    data: {
      id: ids.adjustment,
      idempotencyKey: `checkout-policy-discount:${ids.invoice}`,
      orderId: ids.order,
      invoiceId: ids.invoice,
      quoteId: ids.gramQuote,
      fiatAmountMicros: "1000000",
      fiatCurrency: "USD",
      reason: "GRAM_ONLY_PAYMENT",
      evidence: { selectedAsset: "GRAM", observedAssets: ["GRAM"] },
      createdAt: at(5),
    },
  });
  assert.equal(adjustment.kind, "PAYMENT_METHOD_DISCOUNT");
  assert.equal(
    (await prisma.tonhubPaymentOrder.findUniqueOrThrow({ where: { id: ids.order } })).fiatAmountMicros,
    "100000000",
  );
  assert.equal(
    (await prisma.tonhubPaymentOrder.findUniqueOrThrow({ where: { id: ids.order } })).discountFiatMicros,
    "1000000",
  );

  const secondInvoiceId = `checkout-policy-second-invoice-${suffix}`;
  const secondQuoteId = `checkout-policy-second-gram-quote-${suffix}`;
  await prisma.tonhubPaymentInvoice.create({
    data: {
      id: secondInvoiceId,
      orderId: ids.order,
      network: "mainnet",
      asset: "GRAM",
      checkoutAsset: "GRAM",
      assetKind: "NATIVE",
      assetDecimals: 9,
      fiatAmountCents: 10_000,
      fiatAmountMicros: "100000000",
      creditedFiatMicros: "99000000",
      remainingFiatMicros: "1000000",
      activationThresholdFiatMicros: "50000000",
      fiatCurrency: "USD",
      address: `checkout-policy-second-address-${suffix}`,
      addressRaw: `0:checkout-policy-second-address-${suffix}`,
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 814_011 : 814_012,
      walletNetworkGlobalId: -239,
      walletPublicKeyHash: `checkout-policy-second-key-${suffix}`,
      amountNano: "99000000000",
      amountAtomic: "99000000000",
      paidNano: "99000000000",
      paidAmountAtomic: "99000000000",
      reference: `checkout-policy-second-reference-${suffix}`,
      status: "EXPIRED",
      firstMovementAt: at(3),
      partialPaymentStartedAt: at(3),
      partialPaymentExpiresAt: new Date("2026-08-15T10:03:00.000Z"),
      expiresAt: at(59),
      priceLockedAt: at(1),
      priceLockedUntil: at(59),
      paymentSelectionLockedAsset: "GRAM",
      paymentSelectionLockedAt: at(3),
      createdAt: at(1),
      updatedAt: at(5),
    },
  });
  await prisma.tonhubPaymentQuote.create({
    data: {
      id: secondQuoteId,
      orderId: ids.order,
      invoiceId: secondInvoiceId,
      network: "mainnet",
      asset: "GRAM",
      assetKind: "NATIVE",
      assetDecimals: 9,
      fiatCurrency: "USD",
      grossFiatMicros: "100000000",
      discountFiatMicros: "1000000",
      netFiatMicros: "99000000",
      amountAtomic: "99000000000",
      rateSnapshotId: ids.gramRate,
      quotedAt: at(2),
      expiresAt: at(59),
      createdAt: at(2),
    },
  });
  let releaseQuoteAdjustmentRace!: () => void;
  let readyQuoteAdjustmentRacers = 0;
  const quoteAdjustmentRaceBarrier = new Promise<void>((resolve) => {
    releaseQuoteAdjustmentRace = resolve;
  });
  const startQuoteAdjustmentRace = async () => {
    readyQuoteAdjustmentRacers += 1;
    if (readyQuoteAdjustmentRacers === 2) {
      releaseQuoteAdjustmentRace();
    }
    await quoteAdjustmentRaceBarrier;
  };
  const quoteAdjustmentRace = await Promise.allSettled([
    prisma.$transaction(async (tx) => {
      await startQuoteAdjustmentRace();
      return tx.tonhubPaymentQuote.create({
        data: {
          id: `checkout-policy-second-usdt-quote-${suffix}`,
          orderId: ids.order,
          invoiceId: secondInvoiceId,
          network: "mainnet",
          asset: "USDT",
          assetKind: "JETTON",
          assetDecimals: 6,
          fiatCurrency: "USD",
          grossFiatMicros: "100000000",
          discountFiatMicros: "0",
          netFiatMicros: "100000000",
          amountAtomic: "100000000",
          rateSnapshotId: ids.usdtRate,
          quotedAt: at(2),
          expiresAt: at(59),
          createdAt: at(2),
        },
      });
    }),
    prisma.$transaction(async (tx) => {
      await startQuoteAdjustmentRace();
      return tx.tonhubOrderAdjustment.create({
        data: {
          id: `checkout-policy-second-discount-${suffix}`,
          idempotencyKey: `checkout-policy-second-discount-${suffix}`,
          orderId: ids.order,
          invoiceId: secondInvoiceId,
          quoteId: secondQuoteId,
          fiatAmountMicros: "1000000",
          fiatCurrency: "USD",
          reason: "GRAM_ONLY_PAYMENT",
          createdAt: at(5),
        },
      });
    }),
  ]);
  assert.equal(quoteAdjustmentRace[0]?.status, "fulfilled");
  assert.equal(quoteAdjustmentRace[1]?.status, "rejected");
  assert.match(String(quoteAdjustmentRace[1]?.status === "rejected" && quoteAdjustmentRace[1].reason), /all-GRAM shortfall/);
  assert.equal(
    await prisma.tonhubOrderAdjustment.count({
      where: { orderId: ids.order, kind: "PAYMENT_METHOD_DISCOUNT" },
    }),
    1,
  );
  assert.equal(
    (await prisma.tonhubPaymentOrder.findUniqueOrThrow({ where: { id: ids.order } })).discountFiatMicros,
    "1000000",
  );

  await assert.rejects(
    prisma.tonhubOrderAdjustment.update({
      where: { id: ids.adjustment },
      data: { fiatAmountMicros: "1" },
    }),
    /append-only/,
  );
  await assert.rejects(
    prisma.tonhubOrderAdjustment.delete({ where: { id: ids.adjustment } }),
    /append-only/,
  );
  await assert.rejects(
    prisma.tonhubPaymentInvoice.update({
      where: { id: ids.invoice },
      data: { checkoutAsset: "USDT" },
    }),
    /immutable after its first movement|payment_selection_lock_check/,
  );
  await assert.rejects(
    prisma.tonhubPaymentOrder.update({
      where: { id: ids.order },
      data: { intermediateSweepTriggerBps: 8000 },
    }),
    /policy snapshots are immutable/,
  );

  const lateUsdtMovement = await prisma.tonhubPaymentMovement.create({
    data: {
      fingerprint: `mainnet:checkout-policy-late-usdt:${suffix}:incoming:0`,
      depositAddressId: ids.deposit,
      network: "mainnet",
      direction: "INCOMING",
      asset: "USDT",
      assetKind: "JETTON",
      assetDecimals: 6,
      amountAtomic: "1000000",
      toAddress: `checkout-policy-address-${suffix}`,
      transactionHash: "bc".repeat(32),
      transactionLt: suffix === "clean" ? "814003" : "814004",
      blockchainAt: at(6),
      status: "CREDITED",
      validationCode: "JETTON_INBOUND_V1",
      rateSnapshotId: ids.usdtRate,
      fiatCreditMicros: "1000000",
      createdAt: at(6),
      updatedAt: at(6),
    },
  });
  await assert.rejects(
    prisma.tonhubMovementAllocation.create({
      data: {
        id: `checkout-policy-late-usdt-allocation-${suffix}`,
        movementId: lateUsdtMovement.id,
        orderId: ids.order,
        invoiceId: ids.invoice,
        kind: "CREDIT",
        fiatCreditMicros: "1000000",
        allocatedAt: at(6),
      },
    }),
    /requires reversal of the active GRAM-only discount/,
  );

  const mixedOrderId = `checkout-policy-mixed-order-${suffix}`;
  const mixedInvoiceId = `checkout-policy-mixed-invoice-${suffix}`;
  const mixedDepositId = `checkout-policy-mixed-deposit-${suffix}`;
  const mixedAddress = `checkout-policy-mixed-address-${suffix}`;
  await prisma.tonhubPaymentOrder.create({
    data: {
      id: mixedOrderId,
      fiatAmountMicros: "100000000",
      fiatCurrency: "USD",
      minimumOrderFiatMicros: "10000000",
      gramDiscountMaxFiatMicros: "1000000",
      intermediateSweepTriggerBps: 9000,
      intermediateSweepMinFiatMicros: "100000000",
      maxAutomaticSweepsPerAsset: 2,
      createdAt: at(1),
      updatedAt: at(1),
    },
  });
  await prisma.tonhubPaymentInvoice.create({
    data: {
      id: mixedInvoiceId,
      orderId: mixedOrderId,
      network: "mainnet",
      asset: "GRAM",
      checkoutAsset: "GRAM",
      assetKind: "NATIVE",
      assetDecimals: 9,
      fiatAmountCents: 10_000,
      fiatAmountMicros: "100000000",
      creditedFiatMicros: "99000000",
      remainingFiatMicros: "1000000",
      activationThresholdFiatMicros: "50000000",
      fiatCurrency: "USD",
      address: mixedAddress,
      addressRaw: `0:${mixedAddress}`,
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 814_011 : 814_012,
      walletNetworkGlobalId: -239,
      walletPublicKeyHash: `checkout-policy-mixed-key-${suffix}`,
      amountNano: "99000000000",
      amountAtomic: "99000000000",
      paidNano: "98000000000",
      paidAmountAtomic: "98000000000",
      reference: `checkout-policy-mixed-reference-${suffix}`,
      status: "PARTIAL",
      firstMovementAt: at(3),
      expiresAt: at(59),
      priceLockedAt: at(1),
      priceLockedUntil: at(59),
      paymentSelectionLockedAsset: "GRAM",
      paymentSelectionLockedAt: at(3),
      createdAt: at(1),
      updatedAt: at(3),
    },
  });
  await prisma.tonhubDepositAddress.create({
    data: {
      id: mixedDepositId,
      invoiceId: mixedInvoiceId,
      network: "mainnet",
      address: mixedAddress,
      addressRaw: `0:${mixedAddress}`,
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 814_011 : 814_012,
      walletNetworkGlobalId: -239,
      walletPublicKeyHash: `checkout-policy-mixed-key-${suffix}`,
      status: "ACTIVE",
      createdAt: at(1),
      updatedAt: at(1),
    },
  });
  const invalidUsdtQuote = (id: string, data: Record<string, unknown>) =>
    prisma.tonhubPaymentQuote.create({
      data: {
        id: `checkout-policy-invalid-usdt-${id}-${suffix}`,
        orderId: mixedOrderId,
        invoiceId: mixedInvoiceId,
        network: "mainnet",
        asset: "USDT",
        assetKind: "JETTON",
        assetDecimals: 6,
        fiatCurrency: "USD",
        grossFiatMicros: "100000000",
        discountFiatMicros: "0",
        netFiatMicros: "100000000",
        amountAtomic: "100000000",
        rateSnapshotId: ids.usdtRate,
        quotedAt: at(2),
        expiresAt: at(59),
        createdAt: at(2),
        ...data,
      },
    });
  await assert.rejects(
    invalidUsdtQuote("discount", {
      discountFiatMicros: "1000000",
      netFiatMicros: "99000000",
      amountAtomic: "99000000",
    }),
    /discount violates/,
  );
  await assert.rejects(
    invalidUsdtQuote("chronology", { quotedAt: at(0) }),
    /invoice, order, rate, or deadline/,
  );
  await assert.rejects(
    invalidUsdtQuote("created-before-quote", { createdAt: at(1) }),
  );
  await assert.rejects(
    invalidUsdtQuote("rounding", { amountAtomic: "100000001" }),
    /rounded rate valuation/,
  );
  await assert.rejects(
    invalidUsdtQuote("gross-ownership", {
      grossFiatMicros: "99000000",
      netFiatMicros: "99000000",
      amountAtomic: "99000000",
    }),
    /invoice, order, rate, or deadline/,
  );
  await assert.rejects(
    invalidUsdtQuote("rate", { rateSnapshotId: ids.gramRate }),
    /invoice, order, rate, or deadline/,
  );
  await assert.rejects(
    invalidUsdtQuote("deadline", { expiresAt: new Date("2026-08-14T11:00:00.000Z") }),
    /invoice, order, rate, or deadline/,
  );
  const mixedQuote = await prisma.tonhubPaymentQuote.create({
    data: {
      id: `checkout-policy-mixed-gram-quote-${suffix}`,
      orderId: mixedOrderId,
      invoiceId: mixedInvoiceId,
      network: "mainnet",
      asset: "GRAM",
      assetKind: "NATIVE",
      assetDecimals: 9,
      fiatCurrency: "USD",
      grossFiatMicros: "100000000",
      discountFiatMicros: "1000000",
      netFiatMicros: "99000000",
      amountAtomic: "99000000000",
      rateSnapshotId: ids.gramRate,
      quotedAt: at(2),
      expiresAt: at(59),
      createdAt: at(2),
    },
  });
  const mixedMovements = await Promise.all([
    prisma.tonhubPaymentMovement.create({
      data: {
        fingerprint: `mainnet:checkout-policy-mixed-gram:${suffix}:incoming:0`,
        depositAddressId: mixedDepositId,
        network: "mainnet",
        direction: "INCOMING",
        asset: "GRAM",
        assetKind: "NATIVE",
        assetDecimals: 9,
        amountAtomic: "98000000000",
        toAddress: mixedAddress,
        transactionHash: "cd".repeat(32),
        transactionLt: suffix === "clean" ? "814011" : "814012",
        blockchainAt: at(3),
        status: "CREDITED",
        validationCode: "NATIVE_INBOUND_V1",
        rateSnapshotId: ids.gramRate,
        fiatCreditMicros: "98000000",
        createdAt: at(4),
        updatedAt: at(4),
      },
    }),
    prisma.tonhubPaymentMovement.create({
      data: {
        fingerprint: `mainnet:checkout-policy-mixed-usdt:${suffix}:incoming:0`,
        depositAddressId: mixedDepositId,
        network: "mainnet",
        direction: "INCOMING",
        asset: "USDT",
        assetKind: "JETTON",
        assetDecimals: 6,
        amountAtomic: "1000000",
        toAddress: mixedAddress,
        transactionHash: "ef".repeat(32),
        transactionLt: suffix === "clean" ? "814013" : "814014",
        blockchainAt: at(3),
        status: "CREDITED",
        validationCode: "JETTON_INBOUND_V1",
        rateSnapshotId: ids.usdtRate,
        fiatCreditMicros: "1000000",
        createdAt: at(4),
        updatedAt: at(4),
      },
    }),
  ]);
  await prisma.tonhubMovementAllocation.createMany({
    data: mixedMovements.map((movement, index) => ({
      id: `checkout-policy-mixed-allocation-${index}-${suffix}`,
      movementId: movement.id,
      orderId: mixedOrderId,
      invoiceId: mixedInvoiceId,
      kind: "CREDIT" as const,
      fiatCreditMicros: index === 0 ? "98000000" : "1000000",
      allocatedAt: at(4),
    })),
  });
  await assert.rejects(
    prisma.tonhubOrderAdjustment.create({
      data: {
        id: `checkout-policy-mixed-discount-${suffix}`,
        idempotencyKey: `checkout-policy-mixed-discount-${suffix}`,
        orderId: mixedOrderId,
        invoiceId: mixedInvoiceId,
        quoteId: mixedQuote.id,
        fiatAmountMicros: "1000000",
        fiatCurrency: "USD",
        reason: "GRAM_ONLY_PAYMENT",
        createdAt: at(5),
      },
    }),
    /all-GRAM shortfall/,
  );

  const raceOrderId = `checkout-policy-race-order-${suffix}`;
  const raceInvoiceId = `checkout-policy-race-invoice-${suffix}`;
  const raceDepositId = `checkout-policy-race-deposit-${suffix}`;
  const raceQuoteId = `checkout-policy-race-quote-${suffix}`;
  const raceAddress = `checkout-policy-race-address-${suffix}`;
  await prisma.tonhubPaymentOrder.create({
    data: {
      id: raceOrderId,
      fiatAmountMicros: "100000000",
      fiatCurrency: "USD",
      minimumOrderFiatMicros: "10000000",
      gramDiscountMaxFiatMicros: "1000000",
      intermediateSweepTriggerBps: 9000,
      intermediateSweepMinFiatMicros: "100000000",
      maxAutomaticSweepsPerAsset: 2,
      createdAt: at(1),
      updatedAt: at(1),
    },
  });
  await prisma.tonhubPaymentInvoice.create({
    data: {
      id: raceInvoiceId,
      orderId: raceOrderId,
      network: "mainnet",
      asset: "GRAM",
      checkoutAsset: "GRAM",
      assetKind: "NATIVE",
      assetDecimals: 9,
      fiatAmountCents: 10_000,
      fiatAmountMicros: "100000000",
      creditedFiatMicros: "99000000",
      remainingFiatMicros: "1000000",
      activationThresholdFiatMicros: "50000000",
      fiatCurrency: "USD",
      address: raceAddress,
      addressRaw: `0:${raceAddress}`,
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 814_021 : 814_022,
      walletNetworkGlobalId: -239,
      walletPublicKeyHash: `checkout-policy-race-key-${suffix}`,
      amountNano: "99000000000",
      amountAtomic: "99000000000",
      paidNano: "99000000000",
      paidAmountAtomic: "99000000000",
      reference: `checkout-policy-race-reference-${suffix}`,
      status: "PARTIAL",
      firstMovementAt: at(3),
      expiresAt: at(59),
      priceLockedAt: at(1),
      priceLockedUntil: at(59),
      paymentSelectionLockedAsset: "GRAM",
      paymentSelectionLockedAt: at(3),
      createdAt: at(1),
      updatedAt: at(3),
    },
  });
  await prisma.tonhubDepositAddress.create({
    data: {
      id: raceDepositId,
      invoiceId: raceInvoiceId,
      network: "mainnet",
      address: raceAddress,
      addressRaw: `0:${raceAddress}`,
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 814_021 : 814_022,
      walletNetworkGlobalId: -239,
      walletPublicKeyHash: `checkout-policy-race-key-${suffix}`,
      status: "ACTIVE",
      createdAt: at(1),
      updatedAt: at(1),
    },
  });
  await assert.rejects(
    prisma.tonhubPaymentQuote.create({
      data: {
        id: `checkout-policy-race-over-cap-quote-${suffix}`,
        orderId: raceOrderId,
        invoiceId: raceInvoiceId,
        network: "mainnet",
        asset: "GRAM",
        assetKind: "NATIVE",
        assetDecimals: 9,
        fiatCurrency: "USD",
        grossFiatMicros: "100000000",
        discountFiatMicros: "2000000",
        netFiatMicros: "98000000",
        amountAtomic: "98000000000",
        rateSnapshotId: ids.gramRate,
        quotedAt: at(2),
        expiresAt: at(59),
        createdAt: at(2),
      },
    }),
    /discount violates/,
  );
  await prisma.tonhubPaymentQuote.create({
    data: {
      id: raceQuoteId,
      orderId: raceOrderId,
      invoiceId: raceInvoiceId,
      network: "mainnet",
      asset: "GRAM",
      assetKind: "NATIVE",
      assetDecimals: 9,
      fiatCurrency: "USD",
      grossFiatMicros: "100000000",
      discountFiatMicros: "1000000",
      netFiatMicros: "99000000",
      amountAtomic: "99000000000",
      rateSnapshotId: ids.gramRate,
      quotedAt: at(2),
      expiresAt: at(59),
      createdAt: at(2),
    },
  });
  const raceGramMovement = await prisma.tonhubPaymentMovement.create({
    data: {
      fingerprint: `mainnet:checkout-policy-race-gram:${suffix}:incoming:0`,
      depositAddressId: raceDepositId,
      network: "mainnet",
      direction: "INCOMING",
      asset: "GRAM",
      assetKind: "NATIVE",
      assetDecimals: 9,
      amountAtomic: "99000000000",
      toAddress: raceAddress,
      transactionHash: "13".repeat(32),
      transactionLt: suffix === "clean" ? "814021" : "814022",
      blockchainAt: at(3),
      status: "CREDITED",
      validationCode: "NATIVE_INBOUND_V1",
      rateSnapshotId: ids.gramRate,
      fiatCreditMicros: "99000000",
      createdAt: at(4),
      updatedAt: at(4),
    },
  });
  const raceUsdtMovement = await prisma.tonhubPaymentMovement.create({
    data: {
      fingerprint: `mainnet:checkout-policy-race-usdt:${suffix}:incoming:0`,
      depositAddressId: raceDepositId,
      network: "mainnet",
      direction: "INCOMING",
      asset: "USDT",
      assetKind: "JETTON",
      assetDecimals: 6,
      amountAtomic: "1000000",
      toAddress: raceAddress,
      transactionHash: "14".repeat(32),
      transactionLt: suffix === "clean" ? "814023" : "814024",
      blockchainAt: at(4),
      status: "CREDITED",
      validationCode: "JETTON_INBOUND_V1",
      rateSnapshotId: ids.usdtRate,
      fiatCreditMicros: "1000000",
      createdAt: at(4),
      updatedAt: at(4),
    },
  });
  await prisma.tonhubMovementAllocation.create({
    data: {
      id: `checkout-policy-race-gram-allocation-${suffix}`,
      movementId: raceGramMovement.id,
      orderId: raceOrderId,
      invoiceId: raceInvoiceId,
      kind: "CREDIT",
      fiatCreditMicros: "99000000",
      allocatedAt: at(4),
    },
  });

  let releaseRace!: () => void;
  let readyRacers = 0;
  const raceBarrier = new Promise<void>((resolve) => { releaseRace = resolve; });
  const startRace = async () => {
    readyRacers += 1;
    if (readyRacers === 2) {
      releaseRace();
    }
    await raceBarrier;
  };
  const raceResults = await Promise.allSettled([
    prisma.$transaction(async (tx) => {
      await startRace();
      return tx.tonhubOrderAdjustment.create({
        data: {
          id: `checkout-policy-race-discount-${suffix}`,
          idempotencyKey: `checkout-policy-race-discount-${suffix}`,
          orderId: raceOrderId,
          invoiceId: raceInvoiceId,
          quoteId: raceQuoteId,
          fiatAmountMicros: "1000000",
          fiatCurrency: "USD",
          reason: "GRAM_ONLY_PAYMENT",
          createdAt: at(5),
        },
      });
    }),
    prisma.$transaction(async (tx) => {
      await startRace();
      return tx.tonhubMovementAllocation.create({
        data: {
          id: `checkout-policy-race-usdt-allocation-${suffix}`,
          movementId: raceUsdtMovement.id,
          orderId: raceOrderId,
          invoiceId: raceInvoiceId,
          kind: "CREDIT",
          fiatCreditMicros: "1000000",
          allocatedAt: at(5),
        },
      });
    }),
  ]);
  assert.equal(raceResults.filter(({ status }) => status === "fulfilled").length, 1);
  const raceDiscount = await prisma.tonhubOrderAdjustment.findFirst({
    where: { orderId: raceOrderId, kind: "PAYMENT_METHOD_DISCOUNT" },
  });
  const raceUsdtAllocation = await prisma.tonhubMovementAllocation.findFirst({
    where: { movementId: raceUsdtMovement.id, kind: "CREDIT" },
  });
  assert.notEqual(Boolean(raceDiscount), Boolean(raceUsdtAllocation));
  assert.equal(
    (await prisma.tonhubPaymentOrder.findUniqueOrThrow({ where: { id: raceOrderId } })).discountFiatMicros,
    raceDiscount ? "1000000" : "0",
  );

  const reversal = await prisma.tonhubOrderAdjustment.create({
    data: {
      id: `checkout-policy-adjustment-reversal-${suffix}`,
      idempotencyKey: `checkout-policy-adjustment-reversal:${ids.invoice}`,
      orderId: ids.order,
      invoiceId: ids.invoice,
      quoteId: ids.gramQuote,
      kind: "REVERSAL",
      reversesAdjustmentId: ids.adjustment,
      fiatAmountMicros: "1000000",
      fiatCurrency: "USD",
      reason: "RECOVERY_CORRECTION",
      createdAt: at(6),
    },
  });
  assert.equal(reversal.reversesAdjustmentId, ids.adjustment);
  assert.equal(await prisma.tonhubOrderAdjustment.count({ where: { orderId: ids.order } }), 2);
  assert.equal(
    (await prisma.tonhubPaymentOrder.findUniqueOrThrow({ where: { id: ids.order } })).discountFiatMicros,
    "0",
  );
  await prisma.tonhubMovementAllocation.create({
    data: {
      id: `checkout-policy-late-usdt-allocation-${suffix}`,
      movementId: lateUsdtMovement.id,
      orderId: ids.order,
      invoiceId: ids.invoice,
      kind: "CREDIT",
      fiatCreditMicros: "1000000",
      allocatedAt: at(7),
    },
  });
  assert.equal(await prisma.tonhubMovementAllocation.count({
    where: { movementId: lateUsdtMovement.id, kind: "CREDIT" },
  }), 1);
  await assert.rejects(
    prisma.$executeRawUnsafe(`TRUNCATE TABLE "TonhubOrderAdjustment"`),
    /append-only/,
  );
  await assert.rejects(
    prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "TonhubPaymentQuote", "TonhubOrderAdjustment"`,
    ),
    /append-only/,
  );
} finally {
  await prisma.$disconnect();
}
