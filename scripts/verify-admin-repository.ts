import assert from "node:assert/strict";
import { Address } from "@ton/core";
import { prisma } from "../backend/src/db";
import { createPrismaAdminRepository } from "../backend/src/admin/repository";
import { officialMainnetUsdtMasterAddress } from "../backend/src/ton/jetton-identities";

const suffix = process.env.TONHUB_ADMIN_VERIFY_SUFFIX ?? "default";
const repository = createPrismaAdminRepository(prisma as any);
const baseTime = new Date("2026-08-13T10:00:00.000Z");
const testnetOwner = Address.parseRaw(`0:${(suffix === "clean" ? "c1" : "c2").repeat(32)}`);
const mainnetOwner = Address.parseRaw(`0:${(suffix === "clean" ? "c3" : "c4").repeat(32)}`);
const jettonWallet = Address.parseRaw(`0:${(suffix === "clean" ? "c5" : "c6").repeat(32)}`);
const refundRecipient = Address.parseRaw(`0:${(suffix === "clean" ? "c7" : "c8").repeat(32)}`);

async function main() {
  const rateKey = `admin-rate-${suffix}`;
  const staleRateKeys = Array.from({ length: 125 }, (_, index) => `admin-stale-${suffix}-${index}`);
  await prisma.tonhubAdminLoginThrottle.createMany({
    data: staleRateKeys.map((id) => ({
      id,
      attempts: 1,
      windowStartedAt: new Date(baseTime.getTime() - 48 * 60 * 60 * 1000),
      updatedAt: new Date(baseTime.getTime() - 48 * 60 * 60 * 1000),
    })),
  });
  const cleanupRaceKeys = [`admin-cleanup-a-${suffix}`, `admin-cleanup-b-${suffix}`];
  await prisma.tonhubAdminLoginThrottle.createMany({
    data: cleanupRaceKeys.map((id) => ({
      id,
      attempts: 1,
      windowStartedAt: new Date(baseTime.getTime() - 48 * 60 * 60 * 1000),
      updatedAt: new Date(baseTime.getTime() - 48 * 60 * 60 * 1000),
    })),
  });
  const cleanupClaims = await Promise.all(cleanupRaceKeys.map((cleanupKey) => repository.consumeLoginAttempt({
    rateKey: cleanupKey,
    adminUsername: "merchant",
    now: baseTime,
  })));
  assert.ok(cleanupClaims.every((claim) => claim.allowed));
  await Promise.all(cleanupRaceKeys.map((cleanupKey) => repository.finishLoginAttempt({
    rateKey: cleanupKey,
    adminUsername: "merchant",
    success: true,
  })));
  const claims = await Promise.all(Array.from({ length: 8 }, () => repository.consumeLoginAttempt({
    rateKey,
    adminUsername: "merchant",
    now: baseTime,
  })));
  assert.equal(claims.filter((claim) => claim.allowed).length, 5);
  assert.equal(claims.filter((claim) => !claim.allowed).length, 3);
  assert.equal(await prisma.tonhubAdminLoginThrottle.count({ where: { id: { in: staleRateKeys } } }), 0);
  const blockedUntil = claims.find((claim) => !claim.allowed)?.retryAt;
  assert.ok(blockedUntil);
  const stillBlocked = await repository.consumeLoginAttempt({
    rateKey,
    adminUsername: "merchant",
    now: new Date(baseTime.getTime() + 60_000),
  });
  assert.equal(stillBlocked.allowed, false);
  assert.equal(stillBlocked.retryAt?.getTime(), blockedUntil.getTime());
  await repository.finishLoginAttempt({
    rateKey,
    adminUsername: "merchant",
    success: true,
  });
  assert.equal(await prisma.tonhubAdminLoginThrottle.count({ where: { id: rateKey } }), 0);

  const orderId = `admin-order-${suffix}`;
  const invoiceId = `admin-invoice-${suffix}`;
  const depositId = `admin-deposit-${suffix}`;
  const movementId = `admin-movement-${suffix}`;
  await prisma.tonhubPaymentOrder.create({
    data: {
      id: orderId,
      externalId: `admin-external-${suffix}`,
      fiatAmountMicros: "1000000",
      fiatCurrency: "USD",
    },
  });
  await prisma.tonhubPaymentInvoice.create({
    data: {
      id: invoiceId,
      orderId,
      network: "testnet",
      fiatAmountCents: 100,
      fiatAmountMicros: "1000000",
      remainingFiatMicros: "1000000",
      activationThresholdFiatMicros: "0",
      fiatCurrency: "USD",
      address: testnetOwner.toString({ testOnly: true }),
      addressRaw: testnetOwner.toRawString(),
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 960_001 : 960_002,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: `admin-key-${suffix}`,
      amountNano: "1000000000",
      amountAtomic: "1000000000",
      reference: `admin-reference-${suffix}`,
      expiresAt: new Date("2026-08-13T11:00:00.000Z"),
      priceLockedAt: baseTime,
      priceLockedUntil: new Date("2026-08-13T11:00:00.000Z"),
    },
  });
  await prisma.tonhubDepositAddress.create({
    data: {
      id: depositId,
      invoiceId,
      network: "testnet",
      address: testnetOwner.toString({ testOnly: true }),
      addressRaw: testnetOwner.toRawString(),
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 960_001 : 960_002,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: `admin-key-${suffix}`,
      status: "ACTIVE",
    },
  });
  const rate = await prisma.tonhubRateSnapshot.create({
    data: {
      asset: "GRAM",
      baseCurrency: "GRAM",
      quoteCurrency: "USD",
      price: "1",
      source: "coingecko",
      observedAt: baseTime,
      fetchedAt: baseTime,
    },
  });
  await prisma.tonhubPaymentMovement.create({
    data: {
      id: movementId,
      fingerprint: `admin-gram-in:${suffix}`,
      depositAddressId: depositId,
      network: "testnet",
      direction: "INCOMING",
      asset: "GRAM",
      assetKind: "NATIVE",
      assetDecimals: 9,
      amountAtomic: "1000000000",
      fromAddress: refundRecipient.toRawString(),
      toAddress: testnetOwner.toRawString(),
      ownerAddress: testnetOwner.toRawString(),
      transactionHash: (suffix === "clean" ? "d1" : "d2").repeat(32),
      transactionLt: "960001",
      blockchainAt: baseTime,
      status: "OBSERVED",
    },
  });
  const attached = await repository.attachMovement({
    adminUsername: "merchant",
    movementId,
    orderId,
    invoiceId,
  });
  assert.equal(attached.outcome, "credited");
  assert.equal((await prisma.tonhubPaymentOrder.findUniqueOrThrow({ where: { id: orderId } })).status, "PAID");
  assert.equal(await prisma.tonhubMovementAllocation.count({
    where: { movementId, orderId, invoiceId, allocatedBy: "admin:merchant" },
  }), 1);
  assert.equal(await prisma.tonhubAdminAuditEvent.count({
    where: { action: "MOVEMENT_ATTACHED", targetId: movementId },
  }), 1);

  const recoveryId = `admin-recovery-${suffix}`;
  await prisma.tonhubRecoveryCase.create({
    data: {
      id: recoveryId,
      movementId,
      orderId,
      invoiceId,
      reason: "ADMIN_REHEARSAL",
      title: "Admin review rehearsal",
    },
  });
  await repository.markRecoveryReviewed({ adminUsername: "merchant", recoveryId });
  const reviewed = await prisma.tonhubRecoveryCase.findUniqueOrThrow({ where: { id: recoveryId } });
  assert.equal(reviewed.status, "REVIEWED");
  assert.equal(reviewed.reviewedBy, "merchant");

  const usdtOrderId = `admin-usdt-order-${suffix}`;
  const usdtInvoiceId = `admin-usdt-invoice-${suffix}`;
  const usdtDepositId = `admin-usdt-deposit-${suffix}`;
  await prisma.tonhubPaymentOrder.create({
    data: { id: usdtOrderId, fiatAmountMicros: "5000000", fiatCurrency: "USD" },
  });
  await prisma.tonhubPaymentInvoice.create({
    data: {
      id: usdtInvoiceId,
      orderId: usdtOrderId,
      network: "mainnet",
      asset: "USDT",
      checkoutAsset: "USDT",
      assetKind: "JETTON",
      assetDecimals: 6,
      fiatAmountCents: 500,
      fiatAmountMicros: "5000000",
      fiatCurrency: "USD",
      address: mainnetOwner.toString(),
      addressRaw: mainnetOwner.toRawString(),
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 960_003 : 960_004,
      walletNetworkGlobalId: -239,
      walletPublicKeyHash: `admin-usdt-key-${suffix}`,
      amountNano: "5000000",
      amountAtomic: "5000000",
      reference: `admin-usdt-reference-${suffix}`,
    },
  });
  await prisma.tonhubDepositAddress.create({
    data: {
      id: usdtDepositId,
      invoiceId: usdtInvoiceId,
      network: "mainnet",
      address: mainnetOwner.toString(),
      addressRaw: mainnetOwner.toRawString(),
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 960_003 : 960_004,
      walletNetworkGlobalId: -239,
      walletPublicKeyHash: `admin-usdt-key-${suffix}`,
      status: "ACTIVE",
    },
  });
  await prisma.tonhubDepositAssetAccount.create({
    data: {
      depositAddressId: usdtDepositId,
      network: "mainnet",
      asset: "USDT",
      assetKind: "JETTON",
      assetDecimals: 6,
      jettonMasterAddress: officialMainnetUsdtMasterAddress,
      assetWalletAddress: jettonWallet.toRawString(),
      status: "VERIFIED",
      verifiedAt: baseTime,
    },
  });
  const queued = await repository.queueSweep({
    adminUsername: "merchant",
    depositAddressId: usdtDepositId,
    asset: "USDT",
    requestId: `request-${suffix}`,
  });
  const sweep = await prisma.tonhubAssetSweep.findUniqueOrThrow({ where: { id: queued.jobId } });
  assert.equal(sweep.status, "QUEUED");
  assert.equal(sweep.seqno, null);
  assert.equal(sweep.transactionHash, null);
  await prisma.tonhubAssetSweep.update({
    where: { id: sweep.id },
    data: {
      status: "FAILED",
      amountAtomic: "5000000",
      reserveAtomic: "0",
      recipientAddress: mainnetOwner.toRawString(),
      seqno: 7,
      queryId: "960003",
      sentAt: new Date("2026-08-13T10:04:00.000Z"),
      lastError: "rehearsal after broadcast",
    },
  });
  await repository.retrySweep({ adminUsername: "merchant", sweepId: sweep.id });
  const retriedSweep = await prisma.tonhubAssetSweep.findUniqueOrThrow({ where: { id: sweep.id } });
  assert.equal(retriedSweep.status, "SENT");
  assert.equal(retriedSweep.amountAtomic, "5000000");
  assert.equal(retriedSweep.seqno, 7);
  assert.equal(retriedSweep.queryId, "960003");
  assert.equal(retriedSweep.sentAt?.toISOString(), "2026-08-13T10:04:00.000Z");

  const refundInput = {
    adminUsername: "merchant",
    orderId,
    invoiceId,
    network: "testnet",
    asset: "GRAM",
    assetKind: "NATIVE",
    assetDecimals: 9,
    amountAtomic: "250000000",
    fromAddress: testnetOwner.toRawString(),
    toAddress: refundRecipient.toRawString(),
    transactionHash: (suffix === "clean" ? "e1" : "e2").repeat(32),
    transactionLt: "960002",
    blockchainAt: new Date("2026-08-13T10:05:00.000Z"),
  };
  const firstRefund = await repository.registerRefund(refundInput);
  const replay = await repository.registerRefund(refundInput);
  assert.equal(replay.refundId, firstRefund.refundId);
  const refund = await prisma.tonhubRegisteredRefund.findUniqueOrThrow({ where: { id: firstRefund.refundId } });
  assert.equal(refund.toAddress, refundRecipient.toRawString());
  assert.equal(await prisma.tonhubAdminAuditEvent.count({
    where: { action: "REFUND_REGISTERED", targetId: refund.id },
  }), 1);
  await assert.rejects(
    repository.registerRefund({ ...refundInput, orderId: usdtOrderId, invoiceId: usdtInvoiceId }),
  );
  await assert.rejects(
    repository.registerRefund({ ...refundInput, network: "mainnet" }),
    /order and network/i,
  );
  await assert.rejects(
    repository.registerRefund({ ...refundInput, blockchainAt: new Date(Date.now() + 60_000) }),
    /future/i,
  );
  await prisma.tonhubRegisteredRefund.createMany({
    data: Array.from({ length: 50 }, (_, index) => ({
      id: `admin-refund-page-${suffix}-${index}`,
      orderId,
      invoiceId,
      network: "testnet",
      asset: "GRAM",
      assetKind: "NATIVE",
      assetDecimals: 9,
      amountAtomic: "1",
      fromAddress: testnetOwner.toRawString(),
      toAddress: refundRecipient.toRawString(),
      transactionHash: (index + (suffix === "clean" ? 1 : 101)).toString(16).padStart(64, "0"),
      blockchainAt: new Date(baseTime.getTime() - (index + 1) * 1000),
      registeredBy: "merchant",
    })),
  });
  const movementPage = await repository.page("movements", 1);
  assert.ok(movementPage.secondaryRecords?.some((record) => record.id === refund.id));
  assert.equal(movementPage.secondaryTotal, 51);
  const secondRefundPage = await repository.page("movements", 1, 2);
  assert.equal(secondRefundPage.secondaryRecords?.length, 1);

  await assert.rejects(prisma.$executeRawUnsafe(
    `UPDATE "TonhubRegisteredRefund" SET "amountAtomic" = '1' WHERE "id" = $1`,
    refund.id,
  ));
  await assert.rejects(prisma.$executeRawUnsafe(
    `DELETE FROM "TonhubRegisteredRefund" WHERE "id" = $1`,
    refund.id,
  ));
  assert.ok(rate.id);
}

void main().finally(() => prisma.$disconnect());
