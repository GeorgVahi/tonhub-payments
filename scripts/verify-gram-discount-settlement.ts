import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { createMovementLedger } from "../backend/src/movement-ledger";

const prisma = new PrismaClient();
const observerPrisma = new PrismaClient();
const blockerPrisma = new PrismaClient();
const ledger = createMovementLedger(prisma as any);
const observerLedger = createMovementLedger(observerPrisma as any);
const suffix = process.env.TONHUB_GRAM_DISCOUNT_VERIFY_SUFFIX ?? "local";
const at = (minute: number) => new Date(`2026-08-14T12:${minute.toString().padStart(2, "0")}:00.000Z`);
const issuedAt = new Date("2026-08-14T12:01:00.700Z");
const ids = {
  order: `gram-discount-order-${suffix}`,
  invoice: `gram-discount-invoice-${suffix}`,
  deposit: `gram-discount-deposit-${suffix}`,
  rate: `gram-discount-rate-${suffix}`,
  quote: `gram-discount-quote-${suffix}`,
};

async function waitForBlockedOrderLocks(minimum: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::INTEGER AS "count"
       FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND query LIKE '%TonhubPaymentOrder%'`,
    );
    if ((rows[0]?.count ?? 0) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${minimum} order-lock waiter(s).`);
}

try {
  await prisma.tonhubRateSnapshot.create({
    data: {
      id: ids.rate,
      asset: "GRAM",
      baseCurrency: "GRAM",
      quoteCurrency: "USD",
      price: "2.5",
      source: "coingecko",
      observedAt: at(0),
      fetchedAt: at(0),
      createdAt: at(0),
      payload: { verifier: "gram-discount-settlement" },
    },
  });
  await prisma.tonhubPaymentOrder.create({
    data: {
      id: ids.order,
      externalId: `gram-discount-external-${suffix}`,
      fiatAmountMicros: "5000000",
      fiatCurrency: "USD",
      gramDiscountMaxFiatMicros: "1000000",
      intermediateSweepTriggerBps: 9000,
      intermediateSweepMinFiatMicros: "100000000",
      maxAutomaticSweepsPerAsset: 0,
      expiresAt: at(59),
      createdAt: issuedAt,
      updatedAt: issuedAt,
    },
  });
  await prisma.tonhubPaymentInvoice.create({
    data: {
      id: ids.invoice,
      orderId: ids.order,
      network: "testnet",
      asset: "USDT",
      checkoutAsset: "USDT",
      assetKind: "JETTON",
      assetDecimals: 6,
      fiatAmountCents: 500,
      fiatAmountMicros: "5000000",
      remainingFiatMicros: "5000000",
      activationThresholdFiatMicros: "0",
      fiatCurrency: "USD",
      address: `gram-discount-address-${suffix}`,
      addressRaw: `0:gram-discount-address-${suffix}`,
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 814_101 : 814_102,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: `gram-discount-key-${suffix}`,
      amountNano: "5000000",
      amountAtomic: "5000000",
      reference: `gram-discount-reference-${suffix}`,
      expiresAt: at(59),
      priceLockedAt: issuedAt,
      priceLockedUntil: at(59),
      createdAt: issuedAt,
      updatedAt: issuedAt,
    },
  });
  await prisma.tonhubDepositAddress.create({
    data: {
      id: ids.deposit,
      invoiceId: ids.invoice,
      network: "testnet",
      address: `gram-discount-address-${suffix}`,
      addressRaw: `0:gram-discount-address-${suffix}`,
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 814_101 : 814_102,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: `gram-discount-key-${suffix}`,
      status: "ACTIVE",
      createdAt: issuedAt,
      updatedAt: issuedAt,
    },
  });
  await prisma.tonhubPaymentQuote.create({
    data: {
      id: ids.quote,
      orderId: ids.order,
      invoiceId: ids.invoice,
      network: "testnet",
      asset: "GRAM",
      assetKind: "NATIVE",
      assetDecimals: 9,
      fiatCurrency: "USD",
      grossFiatMicros: "5000000",
      discountFiatMicros: "1000000",
      netFiatMicros: "4000000",
      amountAtomic: "1600000000",
      rateSnapshotId: ids.rate,
      quotedAt: issuedAt,
      expiresAt: at(59),
      createdAt: issuedAt,
    },
  });

  const movement = await ledger.recordObserved({
    fingerprint: `testnet:gram-discount:${suffix}:incoming:0`,
    depositAddressId: ids.deposit,
    network: "testnet",
    direction: "INCOMING",
    asset: "GRAM",
    assetKind: "NATIVE",
    assetDecimals: 9,
    amountAtomic: "1600000000",
    fromAddress: `gram-discount-sender-${suffix}`,
    toAddress: `gram-discount-address-${suffix}`,
    transactionHash: `gram-discount-transaction-${suffix}`,
    transactionLt: suffix === "clean" ? "814101" : "814102",
    blockchainAt: at(1),
    rawPayload: { verifier: "gram-discount-settlement" },
  });
  const observedInvoice = await prisma.tonhubPaymentInvoice.findUniqueOrThrow({
    where: { id: ids.invoice },
  });
  assert.equal(observedInvoice.paymentSelectionLockedAsset, "USDT");
  assert.equal(observedInvoice.paymentSelectionLockedAt?.toISOString(), at(1).toISOString());
  await assert.rejects(
    prisma.tonhubPaymentInvoice.update({
      where: { id: ids.invoice },
      data: { checkoutAsset: "GRAM" },
    }),
    /immutable after its first movement|payment_selection_lock_check/,
  );
  const paid = await ledger.creditMovement({
    movementId: movement.id,
    orderId: ids.order,
    invoiceId: ids.invoice,
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });
  assert.equal(paid.order.status, "PAID");
  assert.equal(paid.order.creditedFiatMicros, "4000000");
  assert.equal(paid.order.discountFiatMicros, "1000000");
  assert.equal(paid.invoice.remainingFiatMicros, "0");
  assert.equal(paid.invoice.paymentSelectionLockedAsset, "USDT");
  assert.equal(paid.invoice.paymentSelectionLockedAt.toISOString(), at(1).toISOString());
  const discount = await prisma.tonhubOrderAdjustment.findFirstOrThrow({
    where: { orderId: ids.order, kind: "PAYMENT_METHOD_DISCOUNT" },
  });
  assert.equal(discount.quoteId, ids.quote);
  assert.equal(discount.fiatAmountMicros, "1000000");

  await assert.rejects(
    prisma.tonhubMovementAllocation.create({
      data: {
        movementId: movement.id,
        orderId: ids.order,
        invoiceId: ids.invoice,
        kind: "REVERSAL",
        reversesAllocationId: paid.allocation.id,
        fiatCreditMicros: paid.allocation.fiatCreditMicros,
        allocatedBy: "raw-verifier",
        note: "must reverse the dependent adjustment first",
      },
    }),
    /requires reversal of the active GRAM-only discount/,
  );

  const reversed = await ledger.reverseAllocation({
    allocationId: paid.allocation.id,
    allocatedBy: "verifier-admin",
    note: "invalid GRAM evidence",
  });
  assert.equal(reversed.order.status, "RECOVERY");
  assert.equal(reversed.order.creditedFiatMicros, "0");
  assert.equal(reversed.order.discountFiatMicros, "0");
  assert.equal(await prisma.tonhubOrderAdjustment.count({ where: { orderId: ids.order } }), 2);
  assert.equal(await prisma.tonhubMovementAllocation.count({ where: { orderId: ids.order } }), 2);

  const race = {
    order: `gram-discount-race-order-${suffix}`,
    invoice: `gram-discount-race-invoice-${suffix}`,
    deposit: `gram-discount-race-deposit-${suffix}`,
    previousInvoice: `gram-discount-race-previous-invoice-${suffix}`,
    previousDeposit: `gram-discount-race-previous-deposit-${suffix}`,
    quote: `gram-discount-race-quote-${suffix}`,
  };
  await prisma.tonhubPaymentOrder.create({
    data: {
      id: race.order,
      externalId: `gram-discount-race-external-${suffix}`,
      fiatAmountMicros: "5000000",
      fiatCurrency: "USD",
      gramDiscountMaxFiatMicros: "1000000",
      intermediateSweepTriggerBps: 9000,
      intermediateSweepMinFiatMicros: "100000000",
      maxAutomaticSweepsPerAsset: 0,
      expiresAt: at(59),
      createdAt: issuedAt,
      updatedAt: issuedAt,
    },
  });
  await prisma.tonhubPaymentInvoice.create({
    data: {
      id: race.invoice,
      orderId: race.order,
      network: "testnet",
      asset: "GRAM",
      checkoutAsset: "GRAM",
      assetKind: "NATIVE",
      assetDecimals: 9,
      fiatAmountCents: 500,
      fiatAmountMicros: "5000000",
      remainingFiatMicros: "5000000",
      activationThresholdFiatMicros: "0",
      fiatCurrency: "USD",
      address: `gram-discount-race-address-${suffix}`,
      addressRaw: `0:gram-discount-race-address-${suffix}`,
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 814_111 : 814_112,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: `gram-discount-race-key-${suffix}`,
      amountNano: "1600000000",
      amountAtomic: "1600000000",
      reference: `gram-discount-race-reference-${suffix}`,
      expiresAt: at(59),
      priceLockedAt: issuedAt,
      priceLockedUntil: at(59),
      createdAt: issuedAt,
      updatedAt: issuedAt,
    },
  });
  await prisma.tonhubDepositAddress.create({
    data: {
      id: race.deposit,
      invoiceId: race.invoice,
      network: "testnet",
      address: `gram-discount-race-address-${suffix}`,
      addressRaw: `0:gram-discount-race-address-${suffix}`,
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 814_111 : 814_112,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: `gram-discount-race-key-${suffix}`,
      status: "ACTIVE",
      createdAt: issuedAt,
      updatedAt: issuedAt,
    },
  });
  await prisma.tonhubPaymentInvoice.create({
    data: {
      id: race.previousInvoice,
      orderId: race.order,
      network: "testnet",
      asset: "GRAM",
      checkoutAsset: "GRAM",
      assetKind: "NATIVE",
      assetDecimals: 9,
      fiatAmountCents: 500,
      fiatAmountMicros: "5000000",
      remainingFiatMicros: "5000000",
      activationThresholdFiatMicros: "0",
      fiatCurrency: "USD",
      address: `gram-discount-race-previous-address-${suffix}`,
      addressRaw: `0:gram-discount-race-previous-address-${suffix}`,
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 814_121 : 814_122,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: `gram-discount-race-previous-key-${suffix}`,
      amountNano: "2000000000",
      amountAtomic: "2000000000",
      reference: `gram-discount-race-previous-reference-${suffix}`,
      status: "EXPIRED",
      expiresAt: at(1),
      priceLockedAt: at(0),
      priceLockedUntil: at(1),
      createdAt: at(0),
      updatedAt: at(0),
    },
  });
  await prisma.tonhubDepositAddress.create({
    data: {
      id: race.previousDeposit,
      invoiceId: race.previousInvoice,
      network: "testnet",
      address: `gram-discount-race-previous-address-${suffix}`,
      addressRaw: `0:gram-discount-race-previous-address-${suffix}`,
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 814_121 : 814_122,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: `gram-discount-race-previous-key-${suffix}`,
      status: "EXPIRED",
      createdAt: at(0),
      updatedAt: at(0),
    },
  });
  await prisma.tonhubPaymentQuote.create({
    data: {
      id: race.quote,
      orderId: race.order,
      invoiceId: race.invoice,
      network: "testnet",
      asset: "GRAM",
      assetKind: "NATIVE",
      assetDecimals: 9,
      fiatCurrency: "USD",
      grossFiatMicros: "5000000",
      discountFiatMicros: "1000000",
      netFiatMicros: "4000000",
      amountAtomic: "1600000000",
      rateSnapshotId: ids.rate,
      quotedAt: issuedAt,
      expiresAt: at(59),
      createdAt: issuedAt,
    },
  });
  const raceGram = await prisma.tonhubPaymentMovement.create({
    data: {
      fingerprint: `testnet:gram-discount-race:${suffix}:gram:0`,
      depositAddressId: race.deposit,
      network: "testnet",
      direction: "INCOMING",
      asset: "GRAM",
      assetKind: "NATIVE",
      assetDecimals: 9,
      amountAtomic: "1600000000",
      fromAddress: `gram-discount-race-sender-${suffix}`,
      toAddress: `gram-discount-race-address-${suffix}`,
      transactionHash: `gram-discount-race-gram-${suffix}`,
      transactionLt: suffix === "clean" ? "814111" : "814112",
      blockchainAt: at(2),
      rawPayload: { verifier: "gram-discount-race", preStep3Observed: true },
    },
  });

  let releaseOrderLock!: () => void;
  let orderLockReady!: () => void;
  const releasePromise = new Promise<void>((resolve) => { releaseOrderLock = resolve; });
  const readyPromise = new Promise<void>((resolve) => { orderLockReady = resolve; });
  const blocker = blockerPrisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      `SELECT "id" FROM "TonhubPaymentOrder" WHERE "id" = $1 FOR UPDATE`,
      race.order,
    );
    orderLockReady();
    await releasePromise;
  }, { timeout: 10_000 });
  await readyPromise;

  try {
    const observeUsdt = observerLedger.recordObserved({
      fingerprint: `testnet:gram-discount-race:${suffix}:usdt:0`,
      depositAddressId: race.previousDeposit,
      network: "testnet",
      direction: "INCOMING",
      asset: "USDT",
      assetKind: "JETTON",
      assetDecimals: 6,
      amountAtomic: "1000000",
      fromAddress: `gram-discount-race-usdt-sender-${suffix}`,
      toAddress: `gram-discount-race-previous-address-${suffix}`,
      ownerAddress: `gram-discount-race-previous-address-${suffix}`,
      jettonMasterAddress: `gram-discount-race-master-${suffix}`,
      jettonWalletAddress: `gram-discount-race-wallet-${suffix}`,
      transactionHash: `gram-discount-race-usdt-${suffix}`,
      transactionLt: suffix === "clean" ? "814113" : "814114",
      blockchainAt: at(1),
      rawPayload: { verifier: "gram-discount-race" },
    });
    await waitForBlockedOrderLocks(1);
    const settleGram = ledger.creditMovement({
      movementId: raceGram.id,
      orderId: race.order,
      invoiceId: race.invoice,
      validationCode: "NATIVE_INBOUND_V1",
      maxRateAgeMs: 300_000,
    });
    await waitForBlockedOrderLocks(2);
    releaseOrderLock();
    await blocker;
    await observeUsdt;
    const raceSettlement = await settleGram;
    assert.equal(raceSettlement.outcome, "blocked-earlier-movement");
    assert.equal(raceSettlement.order.status, "PENDING");
    assert.equal(raceSettlement.order.discountFiatMicros, "0");
    assert.equal(await prisma.tonhubOrderAdjustment.count({ where: { orderId: race.order } }), 0);
    const currentInvoice = await prisma.tonhubPaymentInvoice.findUniqueOrThrow({
      where: { id: race.invoice },
    });
    assert.equal(currentInvoice.paymentSelectionLockedAsset, "GRAM");
    assert.equal(currentInvoice.paymentSelectionLockedAt?.toISOString(), at(2).toISOString());
  } finally {
    releaseOrderLock();
    await blocker.catch(() => undefined);
  }
} finally {
  await Promise.all([
    prisma.$disconnect(),
    observerPrisma.$disconnect(),
    blockerPrisma.$disconnect(),
  ]);
}
