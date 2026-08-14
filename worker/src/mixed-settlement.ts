import type { Prisma } from "@prisma/client";
import { prisma } from "../../backend/src/db";
import { mixedAssetSettlement, type MixedSettlementResult } from "../../backend/src/mixed-settlement";

type PrismaLike = {
  tonhubDepositAddress: {
    findMany: (args: Prisma.TonhubDepositAddressFindManyArgs) => Promise<any[]>;
    updateMany: (args: Prisma.TonhubDepositAddressUpdateManyArgs) => Promise<{ count: number }>;
  };
};

type SettlementService = {
  settleInvoice: (input: {
    invoiceId: string;
    now: Date;
    maxRateAgeMs?: number;
    partialPaymentTtlHours?: number;
    ratePendingBefore?: Date;
    scannerSettlementHorizonMs?: number;
  }) => Promise<MixedSettlementResult>;
};

export async function runMixedSettlementBatch(input: {
  db?: PrismaLike;
  settlement?: SettlementService;
  now?: Date;
  limit?: number;
  maxRateAgeMs?: number;
  partialPaymentTtlHours?: number;
  scannerSettlementHorizonMs?: number;
  retryMs?: number;
}) {
  const db = input.db ?? (prisma as unknown as PrismaLike);
  const settlement = input.settlement ?? mixedAssetSettlement;
  const now = input.now ?? new Date();
  const limit = input.limit ?? 100;
  const retryMs = input.retryMs ?? 60_000;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("Mixed settlement batch now must be a valid date.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error("Mixed settlement batch limit must be an integer between 1 and 10000.");
  }
  if (!Number.isInteger(retryMs) || retryMs < 1_000 || retryMs > 24 * 60 * 60 * 1_000) {
    throw new Error("Mixed settlement retryMs must be an integer between 1000 and 86400000.");
  }
  if (
    input.scannerSettlementHorizonMs !== undefined &&
    (
      !Number.isSafeInteger(input.scannerSettlementHorizonMs) ||
      input.scannerSettlementHorizonMs < 5_000 ||
      input.scannerSettlementHorizonMs > 3_600_000
    )
  ) {
    throw new Error(
      "Mixed settlement scannerSettlementHorizonMs must be between 5000 and 3600000.",
    );
  }
  const retryBefore = new Date(now.getTime() - retryMs);
  const nextAttemptAt = new Date(now.getTime() + retryMs);
  const dueDepositWhere: Prisma.TonhubDepositAddressWhereInput = {
    OR: [
      { settlementNextAttemptAt: null },
      { settlementNextAttemptAt: { lte: now } },
    ],
  };
  const eligibleMovementWhere: Prisma.TonhubPaymentMovementWhereInput = {
    direction: "INCOMING",
    OR: [
      { status: { in: ["OBSERVED", "VALIDATED"] } },
      { status: "RATE_PENDING", updatedAt: { lte: retryBefore } },
    ],
    blockchainAt: { lte: now },
  };
  const deposits = await db.tonhubDepositAddress.findMany({
    where: {
      invoice: { is: { activationThresholdFiatMicros: { not: "0" } } },
      movements: { some: eligibleMovementWhere },
      AND: dueDepositWhere,
    },
    select: {
      id: true,
      invoice: { select: { id: true } },
      _count: { select: { movements: { where: eligibleMovementWhere } } },
    },
    orderBy: [
      { settlementNextAttemptAt: { sort: "asc", nulls: "first" } },
      { id: "asc" },
    ],
    take: limit,
  });
  const candidates = deposits
    .map((deposit: any) => ({ depositId: deposit.id, invoiceId: deposit.invoice?.id }))
    .filter((candidate: any): candidate is { depositId: string; invoiceId: string } =>
      typeof candidate.depositId === "string" && Boolean(candidate.depositId) &&
      typeof candidate.invoiceId === "string" && Boolean(candidate.invoiceId));
  const movementsSelected = deposits.reduce(
    (sum: number, deposit: any) => sum + (Number.isInteger(deposit._count?.movements)
      ? deposit._count.movements
      : 0),
    0,
  );
  const settled: MixedSettlementResult[] = [];
  const errors: Array<{ invoiceId: string; error: string }> = [];
  for (const { depositId, invoiceId } of candidates) {
    try {
      const claimed = await db.tonhubDepositAddress.updateMany({
        where: { id: depositId, AND: dueDepositWhere },
        data: { settlementNextAttemptAt: nextAttemptAt },
      });
      if (!claimed.count) {
        continue;
      }
      const outcome = await settlement.settleInvoice({
        invoiceId,
        now,
        maxRateAgeMs: input.maxRateAgeMs,
        partialPaymentTtlHours: input.partialPaymentTtlHours,
        ratePendingBefore: retryBefore,
        scannerSettlementHorizonMs: input.scannerSettlementHorizonMs,
      });
      if (!outcome.ratePending && !outcome.deferred) {
        await db.tonhubDepositAddress.updateMany({
          where: { id: depositId, settlementNextAttemptAt: nextAttemptAt },
          data: { settlementNextAttemptAt: null },
        });
      }
      settled.push(outcome);
    } catch (error) {
      errors.push({
        invoiceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    movementsSelected,
    invoicesSelected: candidates.length,
    invoicesSettled: settled.length,
    settled,
    errors,
  };
}
