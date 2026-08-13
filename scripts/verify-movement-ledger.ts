import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
  createMovementLedger,
  MovementFingerprintConflictError,
} from "../backend/src/movement-ledger";
import { createPrismaRateSnapshotRepository } from "../backend/src/rate-snapshots";

const prisma = new PrismaClient();
const ledger = createMovementLedger(prisma as any);
const rates = createPrismaRateSnapshotRepository(prisma as any);
const suffix = process.env.TONHUB_LEDGER_VERIFY_SUFFIX ?? "default";
const ids = {
  order: `ledger-order-${suffix}`,
  invoice: `ledger-invoice-${suffix}`,
  deposit: `ledger-deposit-${suffix}`,
  external: `ledger-external-${suffix}`,
  reference: `ledger-reference-${suffix}`,
  address: `ledger-address-${suffix}`,
  rawAddress: `0:ledger-address-${suffix}`,
};

try {
  await prisma.tonhubPaymentOrder.create({
    data: {
      id: ids.order,
      externalId: ids.external,
      fiatAmountMicros: "5000000",
      fiatCurrency: "USD",
    },
  });
  await prisma.tonhubPaymentInvoice.create({
    data: {
      id: ids.invoice,
      orderId: ids.order,
      externalId: null,
      network: "testnet",
      fiatAmountCents: 500,
      fiatAmountMicros: "5000000",
      remainingFiatMicros: "5000000",
      activationThresholdFiatMicros: "2500000",
      fiatCurrency: "USD",
      address: ids.address,
      addressRaw: ids.rawAddress,
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 810_001 : 810_002,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: `ledger-key-${suffix}`,
      amountNano: "2000000000",
      amountAtomic: "2000000000",
      reference: ids.reference,
      expiresAt: new Date("2026-08-13T11:00:00.000Z"),
      priceLockedAt: new Date("2026-08-13T10:00:00.000Z"),
      priceLockedUntil: new Date("2026-08-13T11:00:00.000Z"),
    },
  });
  await prisma.tonhubDepositAddress.create({
    data: {
      id: ids.deposit,
      invoiceId: ids.invoice,
      network: "testnet",
      address: ids.address,
      addressRaw: ids.rawAddress,
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 810_001 : 810_002,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: `ledger-key-${suffix}`,
      status: "ACTIVE",
    },
  });
  await assert.rejects(
    prisma.tonhubPaymentInvoice.update({
      where: { id: ids.invoice },
      data: { activationThresholdFiatMicros: "2500001" },
    }),
  );

  await rates.recordMany([
    {
      asset: "GRAM",
      baseCurrency: "GRAM",
      quoteCurrency: "USD",
      price: "2.5",
      source: "coingecko",
      observedAt: new Date("2026-08-13T09:59:00.000Z"),
      fetchedAt: new Date("2026-08-13T09:59:10.000Z"),
      payload: { verifier: "movement-ledger" },
    },
    {
      asset: "USDT",
      baseCurrency: "USDT",
      quoteCurrency: "USD",
      price: "1",
      source: "usd-peg",
      observedAt: new Date("2026-08-13T09:59:30.000Z"),
      fetchedAt: new Date("2026-08-13T09:59:30.000Z"),
      payload: { policy: "1 USDT = 1 USD" },
    },
  ]);
  await assert.rejects(
    prisma.tonhubRateSnapshot.create({
      data: {
        asset: "USDT",
        baseCurrency: "USDT",
        quoteCurrency: "USD",
        price: "0.99",
        source: "usd-peg",
        observedAt: new Date("2026-08-13T09:59:40.000Z"),
        fetchedAt: new Date("2026-08-13T09:59:40.000Z"),
        payload: { policy: "1 USDT = 1 USD" },
      },
    }),
  );
  await assert.rejects(
    prisma.tonhubRateSnapshot.create({
      data: {
        asset: "USDT",
        baseCurrency: "USDT",
        quoteCurrency: "EUR",
        price: "0.8",
        source: "usd-peg",
        observedAt: new Date("2026-08-13T09:59:40.000Z"),
        fetchedAt: new Date("2026-08-13T09:59:40.000Z"),
        payload: {
          policy: "1 USDT = 1 USD",
          derivation: "GRAM/EUR divided by GRAM/USD",
          components: {},
        },
      },
    }),
  );

  const gramDraft = {
    fingerprint: `testnet:ledger-gram-${suffix}:incoming:0`,
    depositAddressId: ids.deposit,
    network: "testnet" as const,
    direction: "INCOMING" as const,
    asset: "GRAM" as const,
    assetKind: "NATIVE" as const,
    assetDecimals: 9,
    amountAtomic: "1500000000",
    fromAddress: "EQ_LEDGER_SENDER",
    toAddress: ids.address,
    transactionHash: `ledger-gram-${suffix}`,
    transactionLt: "900001",
    blockchainAt: new Date("2026-08-13T10:00:00.000Z"),
    rawPayload: { verifier: true, eventIndex: 0 },
  };
  const [gram, gramReplay] = await Promise.all([
    ledger.recordObserved(gramDraft),
    ledger.recordObserved(gramDraft),
  ]);
  assert.equal(gram.id, gramReplay.id);
  await assert.rejects(
    ledger.recordObserved({ ...gramDraft, amountAtomic: "1500000001" }),
    MovementFingerprintConflictError,
  );

  const usdt = await ledger.recordObserved({
    fingerprint: `testnet:ledger-usdt-${suffix}:incoming:0`,
    depositAddressId: ids.deposit,
    network: "testnet",
    direction: "INCOMING",
    asset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    amountAtomic: "2000000",
    fromAddress: "EQ_LEDGER_SENDER",
    toAddress: ids.address,
    ownerAddress: "EQ_LEDGER_SENDER",
    jettonMasterAddress: "EQ_LEDGER_USDT_MASTER",
    jettonWalletAddress: "EQ_LEDGER_USDT_WALLET",
    transactionHash: `ledger-usdt-${suffix}`,
    transactionLt: "900002",
    blockchainAt: new Date("2026-08-13T10:00:30.000Z"),
    rawPayload: { verifier: true, eventIndex: 0 },
  });

  let [gramCredit, usdtCredit] = await Promise.all([
    ledger.creditMovement({
      movementId: gram.id,
      orderId: ids.order,
      invoiceId: ids.invoice,
      validationCode: "NATIVE_INBOUND_V1",
      maxRateAgeMs: 300_000,
    }),
    ledger.creditMovement({
      movementId: usdt.id,
      orderId: ids.order,
      invoiceId: ids.invoice,
      validationCode: "JETTON_INBOUND_V1",
      maxRateAgeMs: 300_000,
    }),
  ]);
  if (gramCredit.outcome === "blocked-earlier-movement") {
    gramCredit = await ledger.creditMovement({
      movementId: gram.id,
      orderId: ids.order,
      invoiceId: ids.invoice,
      validationCode: "NATIVE_INBOUND_V1",
      maxRateAgeMs: 300_000,
    });
  }
  if (usdtCredit.outcome === "blocked-earlier-movement") {
    usdtCredit = await ledger.creditMovement({
      movementId: usdt.id,
      orderId: ids.order,
      invoiceId: ids.invoice,
      validationCode: "JETTON_INBOUND_V1",
      maxRateAgeMs: 300_000,
    });
  }
  assert.equal(gramCredit.movement.fiatCreditMicros, "3750000");
  assert.equal(usdtCredit.movement.fiatCreditMicros, "2000000");
  const paid = await prisma.tonhubPaymentOrder.findUniqueOrThrow({ where: { id: ids.order } });
  assert.equal(paid.status, "PAID");
  assert.equal(paid.creditedFiatMicros, "5000000");
  assert.equal(paid.overpaymentFiatMicros, "750000");
  assert.equal(paid.paidAt?.toISOString(), "2026-08-13T10:00:30.000Z");
  assert.equal(await prisma.tonhubMovementAllocation.count({
    where: { orderId: ids.order, kind: "CREDIT" },
  }), 2);
  const synchronizedInvoice = await prisma.tonhubPaymentInvoice.findUniqueOrThrow({
    where: { id: ids.invoice },
  });
  assert.equal(synchronizedInvoice.status, "PAID");
  assert.equal(synchronizedInvoice.creditedFiatMicros, "5000000");
  assert.equal(synchronizedInvoice.remainingFiatMicros, "0");

  const [laterGramRate] = await rates.recordMany([{
    asset: "GRAM",
    baseCurrency: "GRAM",
    quoteCurrency: "USD",
    price: "5",
    source: "coingecko",
    observedAt: new Date("2026-08-13T10:01:00.000Z"),
    fetchedAt: new Date("2026-08-13T10:01:10.000Z"),
    payload: { verifier: "movement-ledger-later-rate" },
  }]);
  const laterGram = await ledger.recordObserved({
    ...gramDraft,
    fingerprint: `testnet:ledger-gram-later-${suffix}:incoming:0`,
    amountAtomic: "100000000",
    transactionHash: `ledger-gram-later-${suffix}`,
    transactionLt: "900003",
    blockchainAt: new Date("2026-08-13T10:02:00.000Z"),
  });
  const laterGramCredit = await ledger.creditMovement({
    movementId: laterGram.id,
    orderId: ids.order,
    invoiceId: ids.invoice,
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });
  assert.equal(laterGramCredit.movement.rateSnapshotId, gramCredit.movement.rateSnapshotId);
  assert.equal(laterGramCredit.movement.fiatCreditMicros, "250000");
  assert.equal(laterGramCredit.order.status, "RECOVERY");
  const postPaidInvoice = await prisma.tonhubPaymentInvoice.findUniqueOrThrow({
    where: { id: ids.invoice },
  });
  assert.equal(postPaidInvoice.status, "PAID");
  assert.equal(postPaidInvoice.settlementReason, "POST_PAID_MOVEMENT_RECOVERY");
  assert.equal(await prisma.tonhubRecoveryCase.count({
    where: { movementId: laterGram.id, reason: "POST_PAID_MOVEMENT" },
  }), 1);

  const conflictingRateMovement = await prisma.tonhubPaymentMovement.create({
    data: {
      fingerprint: `testnet:ledger-gram-conflicting-rate-${suffix}:incoming:0`,
      depositAddressId: ids.deposit,
      network: "testnet",
      direction: "INCOMING",
      asset: "GRAM",
      assetKind: "NATIVE",
      assetDecimals: 9,
      amountAtomic: "100000000",
      fromAddress: "EQ_LEDGER_SENDER",
      toAddress: ids.address,
      transactionHash: `ledger-gram-conflicting-rate-${suffix}`,
      transactionLt: "900004",
      blockchainAt: new Date("2026-08-13T10:02:30.000Z"),
      status: "CREDITED",
      validationCode: "DIRECT_DB_RATE_LOCK_NEGATIVE",
      rateSnapshotId: laterGramRate.id,
      fiatCreditMicros: "500000",
    },
  });
  await assert.rejects(
    prisma.tonhubMovementAllocation.create({
      data: {
        movementId: conflictingRateMovement.id,
        orderId: ids.order,
        invoiceId: ids.invoice,
        kind: "CREDIT",
        fiatCreditMicros: "500000",
      },
    }),
  );

  const replay = await ledger.creditMovement({
    movementId: gram.id,
    orderId: ids.order,
    invoiceId: ids.invoice,
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });
  assert.equal(replay.allocation.id, gramCredit.allocation?.id);
  assert.equal(await prisma.tonhubMovementAllocation.count({
    where: { movementId: gram.id, kind: "CREDIT" },
  }), 1);

  const usdtAllocationId = usdtCredit.allocation!.id;
  const [reversed, reversedReplay] = await Promise.all([
    ledger.reverseAllocation({
      allocationId: usdtAllocationId,
      allocatedBy: "rehearsal-admin",
      note: "verify compensating correction",
    }),
    ledger.reverseAllocation({
      allocationId: usdtAllocationId,
      allocatedBy: "rehearsal-admin",
      note: "verify compensating correction",
    }),
  ]);
  assert.equal(reversed.reversal.id, reversedReplay.reversal.id);
  await assert.rejects(
    ledger.reverseAllocation({
      allocationId: usdtAllocationId,
      allocatedBy: "other-admin",
      note: "conflicting replay",
    }),
    /different audit evidence/,
  );
  const recovered = await prisma.tonhubPaymentOrder.findUniqueOrThrow({ where: { id: ids.order } });
  assert.equal(recovered.status, "RECOVERY");
  assert.equal(recovered.creditedFiatMicros, "4000000");
  assert.equal(recovered.overpaymentFiatMicros, "0");
  assert.equal(await prisma.tonhubMovementAllocation.count({
    where: { reversesAllocationId: usdtAllocationId },
  }), 1);
  const recoveryInvoice = await prisma.tonhubPaymentInvoice.findUniqueOrThrow({ where: { id: ids.invoice } });
  assert.equal(recoveryInvoice.status, "FAILED");
  assert.equal(recoveryInvoice.creditedFiatMicros, "4000000");
  assert.equal(await prisma.tonhubRecoveryCase.count({
    where: { movementId: usdt.id, reason: "ALLOCATION_REVERSED" },
  }), 1);

  await assert.rejects(
    prisma.tonhubMovementAllocation.create({
      data: {
        movementId: gram.id,
        orderId: ids.order,
        invoiceId: ids.invoice,
        kind: "CREDIT",
        fiatCreditMicros: "1",
      },
    }),
  );
  const ownerlessMovement = await prisma.tonhubPaymentMovement.create({
    data: {
      fingerprint: `testnet:ownerless-${suffix}:incoming:0`,
      network: "testnet",
      direction: "INCOMING",
      asset: "GRAM",
      assetKind: "NATIVE",
      assetDecimals: 9,
      amountAtomic: "1000000000",
      toAddress: "EQ_OWNERLESS",
      transactionHash: `ownerless-${suffix}`,
      blockchainAt: new Date("2026-08-13T10:00:00.000Z"),
      status: "CREDITED",
      validationCode: "DIRECT_DB_NEGATIVE",
      rateSnapshotId: gramCredit.movement.rateSnapshotId,
      fiatCreditMicros: "2500000",
    },
  });
  const ownerlessInvoice = await prisma.tonhubPaymentInvoice.create({
    data: {
      externalId: null,
      orderId: ids.order,
      network: "testnet",
      fiatAmountCents: 500,
      fiatAmountMicros: "5000000",
      remainingFiatMicros: "5000000",
      fiatCurrency: "USD",
      address: `ownerless-address-${suffix}`,
      addressRaw: `0:ownerless-address-${suffix}`,
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 810_011 : 810_012,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: `ownerless-key-${suffix}`,
      amountNano: "1000000000",
      amountAtomic: "1000000000",
      reference: `ownerless-reference-${suffix}`,
      status: "FAILED",
    },
  });
  await assert.rejects(
    prisma.tonhubMovementAllocation.create({
      data: {
        movementId: ownerlessMovement.id,
        orderId: ids.order,
        invoiceId: ownerlessInvoice.id,
        kind: "CREDIT",
        fiatCreditMicros: "2500000",
      },
    }),
  );
  await assert.rejects(
    prisma.tonhubMovementAllocation.create({
      data: {
        movementId: gram.id,
        orderId: ids.order,
        invoiceId: null,
        kind: "CREDIT",
        fiatCreditMicros: "3750000",
      },
    }),
  );
  await assert.rejects(
    prisma.tonhubMovementAllocation.create({
      data: {
        movementId: gram.id,
        orderId: ids.order,
        invoiceId: ids.invoice,
        kind: "CREDIT",
        fiatCreditMicros: "3750000",
      },
    }),
    (error: any) => error?.code === "P2002",
  );
} finally {
  await prisma.$disconnect();
}
