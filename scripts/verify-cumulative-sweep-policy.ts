import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { Address } from "@ton/core";
import { createMovementLedger } from "../backend/src/movement-ledger";
import { createPrismaAdminRepository } from "../backend/src/admin/repository";
import { prismaTonDepositSweepRepository } from "../worker/src/sweep";

const prisma = new PrismaClient();
const db = prisma as any;
const ledger = createMovementLedger(db);
const suffix = process.env.TONHUB_CUMULATIVE_SWEEP_VERIFY_SUFFIX ?? "default";
const owner = Address.parseRaw(`0:${suffix === "clean" ? "71" : "72"}`.padEnd(66, suffix === "clean" ? "1" : "2"));
const ownerRaw = owner.toRawString();
const ids = {
  order: `cumulative-sweep-order-${suffix}`,
  invoice: `cumulative-sweep-invoice-${suffix}`,
  deposit: `cumulative-sweep-deposit-${suffix}`,
  rate: `cumulative-sweep-rate-${suffix}`,
};

function movement(sequence: number, amountAtomic: string, blockchainAt: Date) {
  return {
    fingerprint: `ton:testnet:native-in:cumulative-${suffix}-${sequence}`,
    depositAddressId: ids.deposit,
    network: "testnet" as const,
    direction: "INCOMING" as const,
    asset: "GRAM" as const,
    assetKind: "NATIVE" as const,
    assetDecimals: 9,
    amountAtomic,
    fromAddress: Address.parseRaw(`0:${"73".repeat(32)}`).toRawString(),
    toAddress: ownerRaw,
    transactionHash: `cumulative-${suffix}-${sequence}`,
    transactionLt: String(10_000 + sequence),
    blockchainAt,
    rawPayload: { verifier: "cumulative-sweep-policy", sequence },
  };
}

try {
  await db.tonhubPaymentOrder.create({
    data: {
      id: ids.order,
      externalId: `cumulative-sweep-external-${suffix}`,
      fiatAmountMicros: "10000000",
      fiatCurrency: "USD",
      minimumOrderFiatMicros: "10000000",
      gramDiscountMaxFiatMicros: "1000000",
      intermediateSweepTriggerBps: 9000,
      intermediateSweepMinFiatMicros: "100000000",
      maxAutomaticSweepsPerAsset: 2,
      expiresAt: new Date("2026-08-13T11:00:00.000Z"),
      createdAt: new Date("2026-08-13T10:00:00.000Z"),
      updatedAt: new Date("2026-08-13T10:00:00.000Z"),
    },
  });
  await db.tonhubPaymentInvoice.create({
    data: {
      id: ids.invoice,
      orderId: ids.order,
      network: "testnet",
      asset: "USDT",
      checkoutAsset: "USDT",
      assetKind: "JETTON",
      assetDecimals: 6,
      fiatAmountCents: 1000,
      fiatAmountMicros: "10000000",
      remainingFiatMicros: "10000000",
      activationThresholdFiatMicros: "5000000",
      fiatCurrency: "USD",
      address: owner.toString({ testOnly: true, bounceable: false }),
      addressRaw: ownerRaw,
      addressStrategy: "unique-address",
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 910_001 : 910_002,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: `cumulative-key-${suffix}`,
      amountNano: "10000000",
      amountAtomic: "10000000",
      reference: `cumulative-reference-${suffix}`,
      expiresAt: new Date("2026-08-13T11:00:00.000Z"),
      priceLockedAt: new Date("2026-08-13T10:00:00.000Z"),
      priceLockedUntil: new Date("2026-08-13T11:00:00.000Z"),
      createdAt: new Date("2026-08-13T10:00:00.000Z"),
      updatedAt: new Date("2026-08-13T10:00:00.000Z"),
    },
  });
  await db.tonhubDepositAddress.create({
    data: {
      id: ids.deposit,
      invoiceId: ids.invoice,
      network: "testnet",
      address: owner.toString({ testOnly: true, bounceable: false }),
      addressRaw: ownerRaw,
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 910_001 : 910_002,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: `cumulative-key-${suffix}`,
      status: "ACTIVE",
      assignedAt: new Date("2026-08-13T10:00:00.000Z"),
    },
  });
  await db.tonhubRateSnapshot.createMany({
    data: [{
      id: ids.rate,
      asset: "GRAM",
      baseCurrency: "GRAM",
      quoteCurrency: "USD",
      price: "2.5",
      source: "coingecko",
      observedAt: new Date("2026-08-13T09:59:00.000Z"),
      fetchedAt: new Date("2026-08-13T09:59:05.000Z"),
      payload: { verifier: "cumulative-sweep-policy" },
    }],
    skipDuplicates: true,
  });

  const first = await ledger.recordObserved(movement(
    1,
    "1000000000",
    new Date("2026-08-13T10:00:10.000Z"),
  ));
  const held = await ledger.creditMovement({
    movementId: first.id,
    orderId: ids.order,
    invoiceId: ids.invoice,
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
    settlementAt: new Date("2026-08-13T10:00:20.000Z"),
  });
  assert.equal(held.outcome, "held-under-minimum");
  assert.equal(await db.tonhubMovementAllocation.count({ where: { orderId: ids.order } }), 0);

  const second = await ledger.recordObserved(movement(
    2,
    "2600000000",
    new Date("2026-08-13T10:01:00.000Z"),
  ));
  await ledger.creditMovement({
    movementId: second.id,
    orderId: ids.order,
    invoiceId: ids.invoice,
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
    settlementAt: new Date("2026-08-13T10:01:10.000Z"),
  });
  const firstSweep = await db.tonhubAssetSweep.findUnique({
    where: { idempotencyKey: `automatic:${ids.order}:GRAM:1` },
  });
  assert.equal(firstSweep?.triggerReason, "INTERMEDIATE_RATIO");
  assert.equal(firstSweep?.triggerFiatMicros, "9000000");
  assert.equal(await db.tonhubMovementAllocation.count({ where: { orderId: ids.order } }), 2);
  assert.equal((await db.tonhubPaymentMovement.findUnique({ where: { id: first.id } }))?.status, "CREDITED");
  assert.equal((await db.tonhubRecoveryCase.findFirst({
    where: { movementId: first.id, reason: "INITIAL_PAYMENT_UNDER_MINIMUM" },
  }))?.status, "RESOLVED");

  const intermediateOwner = `cumulative-sweep-intermediate-${suffix}`;
  assert.equal((await prismaTonDepositSweepRepository.claimSweepCandidate({
    id: ids.deposit,
    assetSweepId: firstSweep.id,
    leaseOwner: intermediateOwner,
    now: new Date("2026-08-13T10:01:20.000Z"),
  }))?.assetSweepStatus, "READY");
  await prismaTonDepositSweepRepository.markSweepReady?.({
    id: ids.deposit,
    assetSweepId: firstSweep.id,
    leaseOwner: intermediateOwner,
    amountNano: "3550000000",
    reserveNano: "50000000",
    recipientAddress: ownerRaw,
    seqno: 1,
    startedAt: new Date("2026-08-13T10:01:20.000Z"),
  });
  await prismaTonDepositSweepRepository.markSweepSent({
    id: ids.deposit,
    assetSweepId: firstSweep.id,
    leaseOwner: intermediateOwner,
    amountNano: "3550000000",
    reserveNano: "50000000",
    recipientAddress: ownerRaw,
    seqno: 1,
    sentAt: new Date("2026-08-13T10:01:30.000Z"),
  });
  await prismaTonDepositSweepRepository.markSweepConfirmed?.({
    id: ids.deposit,
    assetSweepId: firstSweep.id,
    leaseOwner: intermediateOwner,
    confirmedAt: new Date("2026-08-13T10:02:00.000Z"),
    confirmation: {
      transactionHash: "a7".repeat(32),
      transactionLt: "20001",
      blockchainAt: new Date("2026-08-13T10:01:40.000Z"),
    },
  });
  const third = await ledger.recordObserved(movement(
    3,
    "400000000",
    new Date("2026-08-13T10:03:00.000Z"),
  ));
  await ledger.creditMovement({
    movementId: third.id,
    orderId: ids.order,
    invoiceId: ids.invoice,
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
    settlementAt: new Date("2026-08-13T10:03:10.000Z"),
  });
  const secondSweep = await db.tonhubAssetSweep.findUnique({
    where: { idempotencyKey: `automatic:${ids.order}:GRAM:2` },
  });
  assert.equal(secondSweep?.triggerReason, "TERMINAL_PAID");
  assert.equal(secondSweep?.triggerFiatMicros, "1000000");
  assert.equal((await db.tonhubPaymentOrder.findUnique({ where: { id: ids.order } }))?.status, "PAID");

  const firstOwner = `cumulative-sweep-first-${suffix}`;
  const firstClaim = await prismaTonDepositSweepRepository.claimSweepCandidate({
    id: ids.deposit,
    assetSweepId: secondSweep.id,
    leaseOwner: firstOwner,
    now: new Date("2026-08-13T10:04:00.000Z"),
  });
  assert.equal(firstClaim?.assetSweepStatus, "READY");
  await prismaTonDepositSweepRepository.markSweepReady?.({
    id: ids.deposit,
    assetSweepId: secondSweep.id,
    leaseOwner: firstOwner,
    amountNano: "400000000",
    reserveNano: "50000000",
    recipientAddress: ownerRaw,
    seqno: 2,
    startedAt: new Date("2026-08-13T10:04:00.000Z"),
  });
  await prismaTonDepositSweepRepository.markSweepFailed({
    id: ids.deposit,
    assetSweepId: secondSweep.id,
    leaseOwner: firstOwner,
    error: "simulated native broadcast failure",
    failedAt: new Date("2026-08-13T10:04:10.000Z"),
  });
  assert.equal((await db.tonhubRecoveryCase.findUnique({
    where: { id: `asset-sweep:${secondSweep.id}` },
  }))?.status, "OPEN");

  await createPrismaAdminRepository(db).retrySweep({
    adminUsername: "merchant",
    sweepId: secondSweep.id,
  });
  const retried = await db.tonhubAssetSweep.findUnique({ where: { id: secondSweep.id } });
  assert.equal(retried?.status, "READY");
  assert.equal(retried?.amountAtomic, "400000000");
  assert.equal(retried?.reserveAtomic, "50000000");
  assert.equal(retried?.recipientAddress, ownerRaw);
  assert.equal(retried?.seqno, 2);

  const retryOwner = `cumulative-sweep-retry-${suffix}`;
  const retryClaim = await prismaTonDepositSweepRepository.claimSweepCandidate({
    id: ids.deposit,
    assetSweepId: secondSweep.id,
    leaseOwner: retryOwner,
    now: new Date("2026-08-15T10:05:00.000Z"),
  });
  assert.equal(retryClaim?.assetSweepStatus, "READY");
  await prismaTonDepositSweepRepository.markSweepSent({
    id: ids.deposit,
    assetSweepId: secondSweep.id,
    leaseOwner: retryOwner,
    amountNano: "400000000",
    reserveNano: "50000000",
    recipientAddress: ownerRaw,
    seqno: 2,
    sentAt: new Date("2026-08-15T10:05:10.000Z"),
  });
  await prismaTonDepositSweepRepository.markSweepConfirmed?.({
    id: ids.deposit,
    assetSweepId: secondSweep.id,
    leaseOwner: retryOwner,
    confirmedAt: new Date("2026-08-15T10:05:20.000Z"),
    confirmation: {
      transactionHash: "a8".repeat(32),
      transactionLt: "20002",
      blockchainAt: new Date("2026-08-15T10:05:15.000Z"),
    },
  });
  assert.equal((await db.tonhubRecoveryCase.findUnique({
    where: { id: `asset-sweep:${secondSweep.id}` },
  }))?.status, "RESOLVED");

  await assert.rejects(
    db.tonhubAssetSweep.update({
      where: { id: secondSweep.id },
      data: { transactionHash: "f9".repeat(32) },
    }),
    /transaction hash is immutable/i,
  );
  await assert.rejects(
    db.tonhubAssetSweep.create({
      data: {
        idempotencyKey: `forged-automatic-key-${suffix}`,
        depositAddressId: ids.deposit,
        orderId: ids.order,
        invoiceId: ids.invoice,
        asset: "GRAM",
        assetKind: "NATIVE",
        automaticSequence: 1,
        triggerReason: "INTERMEDIATE_RATIO",
        triggerFiatMicros: "9000000",
        triggerCreditedFiatMicros: "9000000",
        triggeredAt: new Date("2026-08-15T10:06:00.000Z"),
        status: "QUEUED",
      },
    }),
    /idempotency key/i,
  );
  await assert.rejects(
    db.tonhubAssetSweep.create({
      data: {
        idempotencyKey: `automatic:${ids.order}:GRAM:1`,
        depositAddressId: ids.deposit,
        orderId: ids.order,
        invoiceId: ids.invoice,
        asset: "GRAM",
        assetKind: "NATIVE",
        automaticSequence: 1,
        triggerReason: "INTERMEDIATE_RATIO",
        triggerFiatMicros: "9000000",
        triggerCreditedFiatMicros: "9000000",
        triggeredAt: new Date("2026-08-15T10:06:00.000Z"),
        status: "QUEUED",
        amountAtomic: "1",
        reserveAtomic: "0",
        recipientAddress: ownerRaw,
        seqno: 99,
      },
    }),
    /unplanned QUEUED job/i,
  );
  await assert.rejects(
    db.tonhubAssetSweep.create({
      data: {
        idempotencyKey: `automatic:${ids.order}:USDT:1`,
        depositAddressId: ids.deposit,
        orderId: ids.order,
        invoiceId: ids.invoice,
        asset: "USDT",
        assetKind: "JETTON",
        automaticSequence: 1,
        triggerReason: "TERMINAL_PAID",
        triggerFiatMicros: "1000000",
        triggerCreditedFiatMicros: "1000000",
        triggeredAt: new Date("2026-08-15T10:06:00.000Z"),
        status: "QUEUED",
      },
    }),
    /official mainnet ownership evidence/i,
  );

  await assert.rejects(
    db.tonhubAssetSweep.update({
      where: { id: secondSweep.id },
      data: { triggerFiatMicros: "1" },
    }),
    /immutable/i,
  );
  await assert.rejects(
    db.tonhubAssetSweep.delete({ where: { id: secondSweep.id } }),
    /append-only/i,
  );
  await assert.rejects(
    db.$executeRawUnsafe(`TRUNCATE TABLE "TonhubAssetSweep" CASCADE`),
    /cannot be truncated/i,
  );

  console.log(`cumulative held and automatic sweep policy verifier passed (${suffix})`);
} finally {
  await prisma.$disconnect();
}
