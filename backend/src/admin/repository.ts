import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { createMovementLedger } from "../movement-ledger";
import { canonicalTonAddress, canonicalTonTransactionHash } from "../ton/gram-shadow-scanner";
import { officialMainnetUsdtMasterAddress } from "../ton/jetton-identities";
import { parseTonNetwork } from "../ton/direct-payments";
import { assertPaymentAssetSnapshot, parsePaymentAsset } from "../../../shared/payment-assets";
import { resumableFailedUsdtSweepStatus } from "../../../shared/mainnet-usdt-sweep-state";
import { adminLoginThrottleRetentionMs } from "./security";

export const adminPageSize = 50;

export type AdminSection =
  | "orders"
  | "movements"
  | "recovery"
  | "sweeps"
  | "webhooks"
  | "audit";

export type AdminPage = {
  section: AdminSection;
  page: number;
  total: number;
  records: any[];
  secondaryRecords?: any[];
  secondaryPage?: number;
  secondaryTotal?: number;
};

export type AdminOverview = {
  counts: {
    orders: number;
    openRecovery: number;
    failedSweeps: number;
    pendingWebhooks: number;
  };
  recovery: any[];
  sweeps: any[];
};

export type AdminRepository = {
  overview: () => Promise<AdminOverview>;
  page: (section: AdminSection, page: number, secondaryPage?: number) => Promise<AdminPage>;
  audit: (input: {
    adminUsername: string;
    action: string;
    targetType: string;
    targetId: string;
    payload?: Record<string, unknown>;
  }) => Promise<void>;
  consumeLoginAttempt: (input: {
    rateKey: string;
    adminUsername: string;
    now: Date;
  }) => Promise<{ allowed: boolean; retryAt: Date | null }>;
  finishLoginAttempt: (input: {
    rateKey: string;
    adminUsername: string;
    success: boolean;
  }) => Promise<void>;
  attachMovement: (input: {
    adminUsername: string;
    movementId: string;
    orderId: string;
    invoiceId: string;
  }) => Promise<{ outcome: string }>;
  markRecoveryReviewed: (input: {
    adminUsername: string;
    recoveryId: string;
  }) => Promise<void>;
  queueSweep: (input: {
    adminUsername: string;
    depositAddressId: string;
    asset: string;
    requestId: string;
  }) => Promise<{ jobId: string; status: string }>;
  retrySweep: (input: {
    adminUsername: string;
    sweepId: string;
  }) => Promise<void>;
  registerRefund: (input: {
    adminUsername: string;
    orderId: string;
    invoiceId?: string | null;
    network: string;
    asset: string;
    assetKind: string;
    assetDecimals: number;
    amountAtomic: string;
    fromAddress?: string | null;
    toAddress: string;
    jettonMasterAddress?: string | null;
    transactionHash: string;
    transactionLt?: string | null;
    blockchainAt: Date;
  }) => Promise<{ refundId: string }>;
  retryWebhook: (input: {
    adminUsername: string;
    outboxEventId: string;
  }) => Promise<void>;
};

function requiredText(value: unknown, field: string, maxLength = 512) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new Error(`${field} is required and must be at most ${maxLength} characters.`);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string, maxLength = 512) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return requiredText(value, field, maxLength);
}

function positiveAtomic(value: unknown) {
  const normalized = requiredText(value, "Refund amountAtomic", 128);
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error("Refund amountAtomic must be a positive integer string.");
  }
  return BigInt(normalized).toString();
}

function canonicalAddress(value: unknown, field: string) {
  const normalized = canonicalTonAddress(value);
  if (!normalized) {
    throw new Error(`${field} must be a valid TON address.`);
  }
  return normalized;
}

function iso(value: Date | null | undefined) {
  return value?.toISOString() ?? null;
}

function auditData(input: {
  adminUsername: string;
  action: string;
  targetType: string;
  targetId: string;
  payload?: Record<string, unknown>;
}) {
  return {
    adminUsername: requiredText(input.adminUsername, "Audit username", 128),
    action: requiredText(input.action, "Audit action", 128),
    targetType: requiredText(input.targetType, "Audit target type", 128),
    targetId: requiredText(input.targetId, "Audit target id", 512),
    payload: input.payload
      ? input.payload as Prisma.InputJsonValue
      : Prisma.DbNull,
  };
}

function scopedLedger(tx: any) {
  const scoped: any = {
    $queryRawUnsafe: tx.$queryRawUnsafe.bind(tx),
    tonhubPaymentMovement: tx.tonhubPaymentMovement,
    tonhubMovementAllocation: tx.tonhubMovementAllocation,
    tonhubOrderAdjustment: tx.tonhubOrderAdjustment,
    tonhubPaymentOrder: tx.tonhubPaymentOrder,
    tonhubPaymentInvoice: tx.tonhubPaymentInvoice,
    tonhubPaymentQuote: tx.tonhubPaymentQuote,
    tonhubDepositAddress: tx.tonhubDepositAddress,
    tonhubDepositAssetAccount: tx.tonhubDepositAssetAccount,
    tonhubAssetSweep: tx.tonhubAssetSweep,
    tonhubScanCursor: tx.tonhubScanCursor,
    tonhubRecoveryCase: tx.tonhubRecoveryCase,
    tonhubRateSnapshot: tx.tonhubRateSnapshot,
  };
  scoped.$transaction = async (handler: (inner: any) => Promise<unknown>) => handler(scoped);
  return createMovementLedger(scoped);
}

function serializeOrder(value: any) {
  return {
    id: value.id,
    externalId: value.externalId,
    fiatAmountMicros: value.fiatAmountMicros,
    fiatCurrency: value.fiatCurrency,
    creditedFiatMicros: value.creditedFiatMicros,
    overpaymentFiatMicros: value.overpaymentFiatMicros,
    status: value.status,
    createdAt: iso(value.createdAt),
    updatedAt: iso(value.updatedAt),
    invoices: (value.invoices ?? []).map((invoice: any) => ({
      id: invoice.id,
      network: invoice.network,
      asset: invoice.checkoutAsset ?? invoice.asset,
      amountAtomic: invoice.amountAtomic ?? invoice.amountNano,
      status: invoice.status,
      address: invoice.address,
      createdAt: iso(invoice.createdAt),
    })),
  };
}

function serializeMovement(value: any) {
  return {
    id: value.id,
    direction: value.direction,
    network: value.network,
    asset: value.asset,
    assetKind: value.assetKind,
    assetDecimals: value.assetDecimals,
    amountAtomic: value.amountAtomic,
    fromAddress: value.fromAddress,
    toAddress: value.toAddress,
    jettonMasterAddress: value.jettonMasterAddress,
    jettonWalletAddress: value.jettonWalletAddress,
    transactionHash: value.transactionHash,
    transactionLt: value.transactionLt,
    blockchainAt: iso(value.blockchainAt),
    status: value.status,
    validationCode: value.validationCode,
    fiatCreditMicros: value.fiatCreditMicros,
    rate: value.rateSnapshot
      ? {
          id: value.rateSnapshot.id,
          price: String(value.rateSnapshot.price),
          quoteCurrency: value.rateSnapshot.quoteCurrency,
          source: value.rateSnapshot.source,
          observedAt: iso(value.rateSnapshot.observedAt),
        }
      : null,
    allocations: (value.allocations ?? []).map((allocation: any) => ({
      id: allocation.id,
      orderId: allocation.orderId,
      invoiceId: allocation.invoiceId,
      kind: allocation.kind,
      fiatCreditMicros: allocation.fiatCreditMicros,
      allocatedBy: allocation.allocatedBy,
    })),
    depositAddressId: value.depositAddressId,
  };
}

function serializeRecovery(value: any) {
  return {
    id: value.id,
    movementId: value.movementId,
    orderId: value.orderId,
    invoiceId: value.invoiceId,
    reason: value.reason,
    status: value.status,
    title: value.title,
    details: value.details,
    reviewedBy: value.reviewedBy,
    reviewedAt: iso(value.reviewedAt),
    createdAt: iso(value.createdAt),
    movement: value.movement ? serializeMovement(value.movement) : null,
  };
}

function serializeSweep(value: any) {
  return {
    id: value.id,
    depositAddressId: value.depositAddressId,
    orderId: value.orderId,
    invoiceId: value.invoiceId,
    asset: value.asset,
    assetKind: value.assetKind,
    status: value.status,
    amountAtomic: value.amountAtomic,
    recipientAddress: value.recipientAddress,
    transactionHash: value.transactionHash,
    seqno: value.seqno,
    queryId: value.queryId,
    gasTopupAmountNano: value.gasTopupAmountNano,
    gasServiceAddress: value.gasServiceAddress,
    gasTopupSeqno: value.gasTopupSeqno,
    gasTopupTransactionHash: value.gasTopupTransactionHash,
    reserveTopupAmountNano: value.reserveTopupAmountNano,
    reserveTopupSeqno: value.reserveTopupSeqno,
    attempts: value.attempts,
    lastError: value.lastError,
    startedAt: iso(value.startedAt),
    sentAt: iso(value.sentAt),
    confirmedAt: iso(value.confirmedAt),
    createdAt: iso(value.createdAt),
    updatedAt: iso(value.updatedAt),
    depositAddress: value.depositAddress?.address ?? null,
  };
}

function serializeRefund(value: any) {
  return {
    id: value.id,
    orderId: value.orderId,
    invoiceId: value.invoiceId,
    network: value.network,
    direction: "OUTGOING",
    asset: value.asset,
    assetKind: value.assetKind,
    assetDecimals: value.assetDecimals,
    amountAtomic: value.amountAtomic,
    fromAddress: value.fromAddress,
    toAddress: value.toAddress,
    jettonMasterAddress: value.jettonMasterAddress,
    transactionHash: value.transactionHash,
    transactionLt: value.transactionLt,
    blockchainAt: iso(value.blockchainAt),
    registeredBy: value.registeredBy,
    createdAt: iso(value.createdAt),
  };
}

function serializeOutbox(value: any) {
  return {
    id: value.id,
    eventId: value.eventId,
    topic: value.topic,
    aggregateType: value.aggregateType,
    aggregateId: value.aggregateId,
    status: value.status,
    attempts: value.attempts,
    availableAt: iso(value.availableAt),
    deliveredAt: iso(value.deliveredAt),
    lastError: value.lastError,
    createdAt: iso(value.createdAt),
    deliveryAttempts: (value.deliveryAttempts ?? []).map((attempt: any) => ({
      id: attempt.id,
      attemptNumber: attempt.attemptNumber,
      status: attempt.status,
      webhookUrl: attempt.webhookUrl,
      requestTimestamp: attempt.requestTimestamp,
      httpStatus: attempt.httpStatus,
      error: attempt.error,
      durationMs: attempt.durationMs,
      startedAt: iso(attempt.startedAt),
      completedAt: iso(attempt.completedAt),
    })),
  };
}

function serializeWebhookAttempt(attempt: any) {
  return {
    id: attempt.id,
    outboxEventId: attempt.outboxEventId,
    eventId: attempt.outboxEvent?.eventId ?? null,
    topic: attempt.outboxEvent?.topic ?? null,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    webhookUrl: attempt.webhookUrl,
    requestTimestamp: attempt.requestTimestamp,
    httpStatus: attempt.httpStatus,
    error: attempt.error,
    durationMs: attempt.durationMs,
    startedAt: iso(attempt.startedAt),
    completedAt: iso(attempt.completedAt),
  };
}

export function createPrismaAdminRepository(db: any = prisma): AdminRepository {
  return {
    overview: async () => {
      const [orders, openRecovery, failedSweeps, pendingWebhooks, recovery, sweeps] = await Promise.all([
        db.tonhubPaymentOrder.count(),
        db.tonhubRecoveryCase.count({ where: { status: "OPEN" } }),
        db.tonhubAssetSweep.count({ where: { status: "FAILED" } }),
        db.tonhubOutboxEvent.count({ where: { status: { in: ["PENDING", "FAILED"] } } }),
        db.tonhubRecoveryCase.findMany({
          where: { status: "OPEN" },
          include: { movement: { include: { rateSnapshot: true, allocations: true } } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: 10,
        }),
        db.tonhubAssetSweep.findMany({
          where: { status: "FAILED" },
          include: { depositAddress: true },
          orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
          take: 10,
        }),
      ]);
      return {
        counts: { orders, openRecovery, failedSweeps, pendingWebhooks },
        recovery: recovery.map(serializeRecovery),
        sweeps: sweeps.map(serializeSweep),
      };
    },

    page: async (section, page, secondaryPage = 1) => {
      const skip = (page - 1) * adminPageSize;
      const secondarySkip = (secondaryPage - 1) * adminPageSize;
      if (section === "orders") {
        const [total, records] = await Promise.all([
          db.tonhubPaymentOrder.count(),
          db.tonhubPaymentOrder.findMany({
            include: { invoices: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip,
            take: adminPageSize,
          }),
        ]);
        return { section, page, total, records: records.map(serializeOrder) };
      }
      if (section === "movements") {
        const [total, records, secondaryTotal, refunds] = await Promise.all([
          db.tonhubPaymentMovement.count(),
          db.tonhubPaymentMovement.findMany({
            include: { rateSnapshot: true, allocations: true },
            orderBy: [{ blockchainAt: "desc" }, { id: "desc" }],
            skip,
            take: adminPageSize,
          }),
          db.tonhubRegisteredRefund.count(),
          db.tonhubRegisteredRefund.findMany({
            orderBy: [{ blockchainAt: "desc" }, { id: "desc" }],
            skip: secondarySkip,
            take: adminPageSize,
          }),
        ]);
        return {
          section,
          page,
          total,
          records: records.map(serializeMovement),
          secondaryRecords: refunds.map(serializeRefund),
          secondaryPage,
          secondaryTotal,
        };
      }
      if (section === "recovery") {
        const [total, records] = await Promise.all([
          db.tonhubRecoveryCase.count(),
          db.tonhubRecoveryCase.findMany({
            include: { movement: { include: { rateSnapshot: true, allocations: true } } },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip,
            take: adminPageSize,
          }),
        ]);
        return { section, page, total, records: records.map(serializeRecovery) };
      }
      if (section === "sweeps") {
        const [total, records, secondaryTotal, native] = await Promise.all([
          db.tonhubAssetSweep.count(),
          db.tonhubAssetSweep.findMany({
            include: { depositAddress: true },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip,
            take: adminPageSize,
          }),
          db.tonhubDepositAddress.count({ where: { sweepStatus: { not: "NOT_STARTED" } } }),
          db.tonhubDepositAddress.findMany({
            where: { sweepStatus: { not: "NOT_STARTED" } },
            select: {
              id: true,
              invoiceId: true,
              address: true,
              network: true,
              sweepStatus: true,
              sweepAmountNano: true,
              sweepRecipientAddress: true,
              sweepTransactionHash: true,
              sweepSeqno: true,
              sweepStartedAt: true,
              sweepSentAt: true,
              sweepLastError: true,
              sweepAttempts: true,
              updatedAt: true,
            },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
            skip: secondarySkip,
            take: adminPageSize,
          }),
        ]);
        return {
          section,
          page,
          total,
          records: records.map(serializeSweep),
          secondaryRecords: native.map((value: any) => ({
            ...value,
            sweepStartedAt: iso(value.sweepStartedAt),
            sweepSentAt: iso(value.sweepSentAt),
            updatedAt: iso(value.updatedAt),
          })),
          secondaryPage,
          secondaryTotal,
        };
      }
      if (section === "webhooks") {
        const [total, records, secondaryTotal, attempts] = await Promise.all([
          db.tonhubOutboxEvent.count(),
          db.tonhubOutboxEvent.findMany({
            include: {
              deliveryAttempts: {
                orderBy: [{ attemptNumber: "desc" }],
                take: 3,
              },
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip,
            take: adminPageSize,
          }),
          db.tonhubWebhookDeliveryAttempt.count(),
          db.tonhubWebhookDeliveryAttempt.findMany({
            include: { outboxEvent: { select: { eventId: true, topic: true } } },
            orderBy: [{ startedAt: "desc" }, { id: "desc" }],
            skip: secondarySkip,
            take: adminPageSize,
          }),
        ]);
        return {
          section,
          page,
          total,
          records: records.map(serializeOutbox),
          secondaryRecords: attempts.map(serializeWebhookAttempt),
          secondaryPage,
          secondaryTotal,
        };
      }
      const [total, records] = await Promise.all([
        db.tonhubAdminAuditEvent.count(),
        db.tonhubAdminAuditEvent.findMany({
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip,
          take: adminPageSize,
        }),
      ]);
      return {
        section,
        page,
        total,
        records: records.map((value: any) => ({ ...value, createdAt: iso(value.createdAt) })),
      };
    },

    audit: async (input) => {
      await db.tonhubAdminAuditEvent.create({ data: auditData(input) });
    },

    consumeLoginAttempt: async (input) => db.$transaction(async (tx: any) => {
      const rateKey = requiredText(input.rateKey, "Login rate key", 128);
      const windowStartedAt = new Date(input.now.getTime() - 15 * 60 * 1000);
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO "TonhubAdminLoginThrottle" (
           "id", "attempts", "windowStartedAt", "blockedUntil", "updatedAt"
         ) VALUES ($1, 1, $2, NULL, $2)
         ON CONFLICT ("id") DO UPDATE SET
           "attempts" = CASE
             WHEN "TonhubAdminLoginThrottle"."blockedUntil" > $2 THEN 6
             WHEN "TonhubAdminLoginThrottle"."windowStartedAt" <= $3 THEN 1
             ELSE LEAST("TonhubAdminLoginThrottle"."attempts" + 1, 6)
           END,
           "windowStartedAt" = CASE
             WHEN "TonhubAdminLoginThrottle"."blockedUntil" > $2 THEN "TonhubAdminLoginThrottle"."windowStartedAt"
             WHEN "TonhubAdminLoginThrottle"."windowStartedAt" <= $3 THEN $2
             ELSE "TonhubAdminLoginThrottle"."windowStartedAt"
           END,
           "blockedUntil" = CASE
             WHEN "TonhubAdminLoginThrottle"."blockedUntil" > $2 THEN "TonhubAdminLoginThrottle"."blockedUntil"
             WHEN "TonhubAdminLoginThrottle"."windowStartedAt" <= $3 THEN NULL
             WHEN "TonhubAdminLoginThrottle"."attempts" + 1 > 5 THEN
               GREATEST(COALESCE("TonhubAdminLoginThrottle"."blockedUntil", $2), $4)
             ELSE "TonhubAdminLoginThrottle"."blockedUntil"
           END,
           "updatedAt" = $2
         RETURNING "attempts", "blockedUntil"`,
        rateKey,
        input.now,
        windowStartedAt,
        new Date(input.now.getTime() + 15 * 60 * 1000),
      ) as Array<{ attempts: number; blockedUntil: Date | null }>;
      const state = rows[0];
      if (!state) {
        throw new Error("Login rate limiter did not return authoritative state.");
      }
      await tx.$executeRawUnsafe(
        `DELETE FROM "TonhubAdminLoginThrottle"
         WHERE "id" IN (
           SELECT "id" FROM "TonhubAdminLoginThrottle"
           WHERE "updatedAt" < $1
           ORDER BY "updatedAt" ASC
           LIMIT 100
           FOR UPDATE SKIP LOCKED
         )`,
        new Date(input.now.getTime() - adminLoginThrottleRetentionMs),
      );
      return {
        allowed: state.attempts <= 5 && (!state.blockedUntil || state.blockedUntil <= input.now),
        retryAt: state.blockedUntil,
      };
    }),

    finishLoginAttempt: async (input) => db.$transaction(async (tx: any) => {
      if (input.success) {
        await tx.tonhubAdminLoginThrottle.deleteMany({ where: { id: input.rateKey } });
      }
      await tx.tonhubAdminAuditEvent.create({
        data: auditData({
          adminUsername: input.adminUsername,
          action: input.success ? "ADMIN_LOGIN_SUCCEEDED" : "ADMIN_LOGIN_FAILED",
          targetType: "AdminSession",
          targetId: input.rateKey,
        }),
      });
    }),

    attachMovement: async (input) => db.$transaction(async (tx: any) => {
      const movementId = requiredText(input.movementId, "Movement id");
      const movement = await tx.tonhubPaymentMovement.findUnique({ where: { id: movementId } });
      if (!movement) {
        throw new Error(`Movement not found: ${movementId}.`);
      }
      const result = await scopedLedger(tx).creditMovement({
        movementId,
        orderId: requiredText(input.orderId, "Order id"),
        invoiceId: requiredText(input.invoiceId, "Invoice id"),
        validationCode: movement.validationCode ?? "ADMIN_REVIEWED",
        allocatedBy: `admin:${requiredText(input.adminUsername, "Admin username", 128)}`,
      });
      await tx.tonhubAdminAuditEvent.create({
        data: auditData({
          adminUsername: input.adminUsername,
          action: "MOVEMENT_ATTACHED",
          targetType: "TonhubPaymentMovement",
          targetId: movementId,
          payload: {
            orderId: input.orderId,
            invoiceId: input.invoiceId,
            outcome: result.outcome,
          },
        }),
      });
      return { outcome: result.outcome };
    }),

    markRecoveryReviewed: async (input) => db.$transaction(async (tx: any) => {
      const recoveryId = requiredText(input.recoveryId, "Recovery id");
      const reviewedAt = new Date();
      const updated = await tx.tonhubRecoveryCase.updateMany({
        where: { id: recoveryId, status: "OPEN" },
        data: {
          status: "REVIEWED",
          reviewedBy: input.adminUsername,
          reviewedAt,
        },
      });
      if (updated.count !== 1) {
        throw new Error("Recovery case is missing or no longer open.");
      }
      await tx.tonhubAdminAuditEvent.create({
        data: auditData({
          adminUsername: input.adminUsername,
          action: "RECOVERY_REVIEWED",
          targetType: "TonhubRecoveryCase",
          targetId: recoveryId,
        }),
      });
    }),

    queueSweep: async (input) => db.$transaction(async (tx: any) => {
      const depositAddressId = requiredText(input.depositAddressId, "Deposit address id");
      const requestId = requiredText(input.requestId, "Request id", 128);
      const asset = parsePaymentAsset(input.asset);
      const deposit = await tx.tonhubDepositAddress.findUnique({
        where: { id: depositAddressId },
        include: { invoice: true, assetAccounts: { where: { asset: "USDT" } } },
      });
      if (!deposit?.invoice || deposit.invoiceId !== deposit.invoice.id) {
        throw new Error("Sweep requires an assigned invoice deposit address.");
      }
      let jobId: string;
      let status: string;
      if (asset.symbol === "USDT") {
        const account = deposit.assetAccounts?.[0];
        const owners = [deposit.address, deposit.addressRaw, deposit.invoice.address, deposit.invoice.addressRaw]
          .map(canonicalTonAddress);
        if (
          deposit.network !== "mainnet" ||
          deposit.invoice.network !== "mainnet" ||
          owners.some((owner: string | null) => !owner || owner !== owners[0]) ||
          !account ||
          account.network !== "mainnet" ||
          account.asset !== "USDT" ||
          account.assetKind !== "JETTON" ||
          account.assetDecimals !== 6 ||
          account.status !== "VERIFIED" ||
          canonicalTonAddress(account.jettonMasterAddress) !== officialMainnetUsdtMasterAddress ||
          !canonicalTonAddress(account.assetWalletAddress)
        ) {
          throw new Error("USDT sweep requires the verified official mainnet asset wallet.");
        }
        const idempotencyKey = `admin-usdt:${depositAddressId}:${requestId}`;
        await tx.tonhubAssetSweep.createMany({
          data: {
            idempotencyKey,
            depositAddressId,
            orderId: deposit.invoice.orderId,
            invoiceId: deposit.invoice.id,
            asset: "USDT",
            assetKind: "JETTON",
            status: "QUEUED",
            leaseExpiresAt: new Date(),
          },
          skipDuplicates: true,
        });
        const job = await tx.tonhubAssetSweep.findFirst({
          where: {
            depositAddressId,
            asset: "USDT",
            OR: [
              { idempotencyKey },
              { status: { in: ["QUEUED", "GAS_CHECK", "GAS_TOPUP_REQUIRED", "GAS_TOPUP_SENT", "READY", "SENT", "FAILED"] } },
            ],
          },
          orderBy: { createdAt: "desc" },
        });
        if (!job) {
          throw new Error("USDT sweep job could not be queued or reused.");
        }
        if (job.status === "FAILED") {
          throw new Error("A failed USDT sweep already owns this deposit; use the explicit retry action.");
        }
        jobId = job.id;
        status = job.status;
      } else {
        if (deposit.status !== "PAID") {
          throw new Error("Native GRAM sweep can only be queued for a paid deposit address.");
        }
        const queued = await tx.tonhubDepositAddress.updateMany({
          where: { id: depositAddressId, sweepStatus: "NOT_STARTED" },
          data: {
            sweepStatus: "NOT_STARTED",
            sweepLastError: null,
            sweepStartedAt: null,
          },
        });
        if (queued.count !== 1) {
          throw new Error("Native sweep was already initiated; use retry only for an explicit FAILED state.");
        }
        jobId = `native:${depositAddressId}`;
        status = "QUEUED";
      }
      await tx.tonhubAdminAuditEvent.create({
        data: auditData({
          adminUsername: input.adminUsername,
          action: "SWEEP_QUEUED",
          targetType: asset.symbol === "USDT" ? "TonhubAssetSweep" : "TonhubDepositAddress",
          targetId: jobId,
          payload: { depositAddressId, asset: asset.symbol, requestId, status },
        }),
      });
      return { jobId, status };
    }),

    retrySweep: async (input) => db.$transaction(async (tx: any) => {
      const sweepId = requiredText(input.sweepId, "Sweep id");
      if (sweepId.startsWith("native:")) {
        const depositAddressId = sweepId.slice("native:".length);
        const updated = await tx.tonhubDepositAddress.updateMany({
          where: { id: depositAddressId, sweepStatus: "FAILED" },
          data: { sweepStatus: "NOT_STARTED", sweepLastError: null, sweepStartedAt: null },
        });
        if (updated.count !== 1) {
          throw new Error("Native sweep is missing or no longer failed.");
        }
      } else {
        const stored = await tx.tonhubAssetSweep.findUnique({ where: { id: sweepId } });
        if (!stored || stored.asset !== "USDT" || stored.status !== "FAILED") {
          throw new Error("Asset sweep is missing or no longer failed.");
        }
        const updated = await tx.tonhubAssetSweep.updateMany({
          where: { id: sweepId, status: "FAILED" },
          data: {
            status: resumableFailedUsdtSweepStatus(stored),
            attempts: 0,
            leaseOwner: null,
            leaseExpiresAt: new Date(),
            lastError: null,
          },
        });
        if (updated.count !== 1) {
          throw new Error("Asset sweep is missing or no longer failed.");
        }
      }
      await tx.tonhubAdminAuditEvent.create({
        data: auditData({
          adminUsername: input.adminUsername,
          action: "SWEEP_RETRY_QUEUED",
          targetType: sweepId.startsWith("native:") ? "TonhubDepositAddress" : "TonhubAssetSweep",
          targetId: sweepId,
        }),
      });
    }),

    registerRefund: async (input) => db.$transaction(async (tx: any) => {
      const orderId = requiredText(input.orderId, "Order id");
      const invoiceId = optionalText(input.invoiceId, "Invoice id");
      const network = parseTonNetwork(input.network);
      const order = await tx.tonhubPaymentOrder.findUnique({ where: { id: orderId } });
      if (!order) {
        throw new Error(`Order not found: ${orderId}.`);
      }
      if (invoiceId) {
        const invoice = await tx.tonhubPaymentInvoice.findUnique({ where: { id: invoiceId } });
        if (!invoice || invoice.orderId !== orderId || invoice.network !== network) {
          throw new Error("Refund invoice does not belong to the order and network.");
        }
      }
      const asset = assertPaymentAssetSnapshot(parsePaymentAsset(input.asset), {
        kind: input.assetKind,
        decimals: input.assetDecimals,
      });
      const amountAtomic = positiveAtomic(input.amountAtomic);
      const fromAddress = input.fromAddress ? canonicalAddress(input.fromAddress, "Refund fromAddress") : null;
      const toAddress = canonicalAddress(input.toAddress, "Refund toAddress");
      const transactionHash = canonicalTonTransactionHash(input.transactionHash);
      if (!transactionHash) {
        throw new Error("Refund transactionHash must be a canonical 32-byte TON hash.");
      }
      const transactionLt = optionalText(input.transactionLt, "Refund transactionLt", 32);
      if (transactionLt && !/^\d+$/.test(transactionLt)) {
        throw new Error("Refund transactionLt must be a non-negative integer.");
      }
      const canonicalTransactionLt = transactionLt ? BigInt(transactionLt).toString() : null;
      if (canonicalTransactionLt && BigInt(canonicalTransactionLt) > (BigInt(1) << BigInt(64)) - BigInt(1)) {
        throw new Error("Refund transactionLt exceeds uint64.");
      }
      if (!(input.blockchainAt instanceof Date) || Number.isNaN(input.blockchainAt.getTime())) {
        throw new Error("Refund blockchainAt must be a valid date.");
      }
      if (input.blockchainAt.getTime() > Date.now()) {
        throw new Error("Refund blockchainAt cannot be in the future.");
      }
      const jettonMasterAddress = asset.symbol === "USDT"
        ? canonicalAddress(input.jettonMasterAddress, "Refund jettonMasterAddress")
        : null;
      if (asset.symbol === "USDT" && (network !== "mainnet" || jettonMasterAddress !== officialMainnetUsdtMasterAddress)) {
        throw new Error("USDT refunds must use the official mainnet master.");
      }
      if (asset.symbol === "GRAM" && input.jettonMasterAddress) {
        throw new Error("Native GRAM refunds cannot contain a jetton master.");
      }
      const details = {
        orderId,
        invoiceId,
        network,
        asset: asset.symbol,
        assetKind: asset.kind,
        assetDecimals: asset.decimals,
        amountAtomic,
        fromAddress,
        toAddress,
        jettonMasterAddress,
        transactionHash,
        transactionLt: canonicalTransactionLt,
        blockchainAt: input.blockchainAt.toISOString(),
      };
      const identity = createHash("sha256").update(JSON.stringify(details)).digest("hex");
      const refundId = `refund:${identity}`;
      await tx.tonhubRegisteredRefund.createMany({
        data: {
          id: refundId,
          orderId,
          invoiceId,
          network,
          asset: asset.symbol,
          assetKind: asset.kind,
          assetDecimals: asset.decimals,
          amountAtomic,
          fromAddress,
          toAddress,
          jettonMasterAddress,
          transactionHash,
          transactionLt: canonicalTransactionLt,
          blockchainAt: input.blockchainAt,
          registeredBy: requiredText(input.adminUsername, "Admin username", 128),
        },
        skipDuplicates: true,
      });
      const stored = await tx.tonhubRegisteredRefund.findUnique({ where: { id: refundId } });
      if (
        !stored ||
        stored.orderId !== orderId ||
        stored.invoiceId !== invoiceId ||
        stored.network !== network ||
        stored.asset !== asset.symbol ||
        stored.assetKind !== asset.kind ||
        stored.assetDecimals !== asset.decimals ||
        stored.amountAtomic !== amountAtomic ||
        stored.fromAddress !== fromAddress ||
        stored.toAddress !== toAddress ||
        stored.jettonMasterAddress !== jettonMasterAddress ||
        stored.transactionHash !== transactionHash ||
        stored.transactionLt !== canonicalTransactionLt ||
        stored.blockchainAt.getTime() !== input.blockchainAt.getTime() ||
        stored.registeredBy !== input.adminUsername
      ) {
        throw new Error("Refund evidence conflicts with an existing immutable registration.");
      }
      await tx.tonhubAdminAuditEvent.createMany({
        data: {
          id: `refund-audit:${identity}`,
          adminUsername: requiredText(input.adminUsername, "Admin username", 128),
          action: "REFUND_REGISTERED",
          targetType: "TonhubRegisteredRefund",
          targetId: refundId,
          payload: details as Prisma.InputJsonValue,
        },
        skipDuplicates: true,
      });
      return { refundId };
    }),

    retryWebhook: async (input) => db.$transaction(async (tx: any) => {
      const outboxEventId = requiredText(input.outboxEventId, "Outbox event id");
      const retried = await tx.tonhubOutboxEvent.updateMany({
        where: { id: outboxEventId, status: "FAILED" },
        data: {
          status: "PENDING",
          availableAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: null,
        },
      });
      if (retried.count !== 1) {
        throw new Error("Webhook event is missing or not in FAILED state.");
      }
      await tx.tonhubAdminAuditEvent.create({
        data: auditData({
          adminUsername: input.adminUsername,
          action: "WEBHOOK_RETRY_QUEUED",
          targetType: "TonhubOutboxEvent",
          targetId: outboxEventId,
        }),
      });
    }),
  };
}

export const prismaAdminRepository = createPrismaAdminRepository();
