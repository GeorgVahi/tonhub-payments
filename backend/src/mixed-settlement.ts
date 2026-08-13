import { prisma } from "./db";
import { movementLedger } from "./movement-ledger";
import {
  prismaTonhubPaymentRepository,
  type TonhubPaymentRepository,
} from "./repository";
import type { TonhubPaymentInvoiceRecord } from "./types";

type PrismaLike = {
  tonhubPaymentInvoice: any;
  tonhubPaymentMovement: any;
};

type MovementCreditResult = {
  outcome: "credited" | "rate-pending" | "held-under-minimum" | "recovery" | "blocked-earlier-movement";
  movement: { id: string };
};

type MovementCreditor = {
  creditMovement: (input: {
    movementId: string;
    orderId: string;
    invoiceId: string;
    validationCode: string;
    allocatedBy?: string;
    maxRateAgeMs?: number;
    partialPaymentTtlHours?: number;
  }) => Promise<MovementCreditResult>;
};

function validDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function validationCodeForMovement(movement: any) {
  if (movement.asset === "GRAM" && movement.assetKind === "NATIVE" && movement.assetDecimals === 9) {
    return "NATIVE_INBOUND_V1";
  }
  if (movement.asset === "USDT" && movement.assetKind === "JETTON" && movement.assetDecimals === 6) {
    return "JETTON_INBOUND_V1";
  }
  throw new Error(`Movement ${movement.id} has unsupported settlement identity.`);
}

function assertSettlementOwner(invoice: any) {
  if (!invoice?.order || !invoice?.orderId || !invoice?.depositAddress?.id) {
    throw new Error(`Invoice ${invoice?.id ?? "unknown"} has incomplete settlement ownership.`);
  }
  if (!validDate(invoice.createdAt)) {
    throw new Error(`Invoice ${invoice.id} has invalid settlement chronology.`);
  }
}

function compareMovementChronology(left: any, right: any) {
  const timeDifference = left.blockchainAt.getTime() - right.blockchainAt.getTime();
  if (timeDifference) {
    return timeDifference;
  }
  const leftLt = typeof left.transactionLt === "string" && /^\d+$/.test(left.transactionLt)
    ? BigInt(left.transactionLt)
    : null;
  const rightLt = typeof right.transactionLt === "string" && /^\d+$/.test(right.transactionLt)
    ? BigInt(right.transactionLt)
    : null;
  if (leftLt !== null && rightLt !== null && leftLt !== rightLt) {
    return leftLt < rightLt ? -1 : 1;
  }
  if (leftLt !== null || rightLt !== null) {
    return leftLt !== null ? -1 : 1;
  }
  return String(left.id).localeCompare(String(right.id));
}

export type MixedSettlementResult = {
  invoice: TonhubPaymentInvoiceRecord;
  outcomes: MovementCreditResult[];
  ratePending: boolean;
  deferred: boolean;
};

export function createMixedAssetSettlement(
  db: PrismaLike,
  creditor: MovementCreditor,
  repository: TonhubPaymentRepository,
) {
  return {
    settleInvoice: async (input: {
      invoiceId: string;
      now: Date;
      maxRateAgeMs?: number;
      partialPaymentTtlHours?: number;
      ratePendingBefore?: Date;
    }): Promise<MixedSettlementResult> => {
      if (!validDate(input.now)) {
        throw new Error("Mixed settlement now must be a valid date.");
      }
      if (input.ratePendingBefore !== undefined && !validDate(input.ratePendingBefore)) {
        throw new Error("Mixed settlement ratePendingBefore must be a valid date.");
      }
      const invoice = await db.tonhubPaymentInvoice.findUnique({
        where: { id: input.invoiceId },
        include: { order: true, depositAddress: true },
      });
      if (!invoice) {
        throw new Error(`Payment invoice not found: ${input.invoiceId}.`);
      }
      assertSettlementOwner(invoice);
      const activationThreshold = invoice.activationThresholdFiatMicros;
      if (activationThreshold !== null && activationThreshold !== undefined && (
        typeof activationThreshold !== "string" || !/^\d+$/.test(activationThreshold)
      )) {
        throw new Error(`Invoice ${invoice.id} has malformed settlement policy.`);
      }
      if (activationThreshold === null || activationThreshold === undefined || BigInt(activationThreshold) === BigInt(0)) {
        const grandfathered = await repository.findInvoiceById(invoice.id);
        if (!grandfathered) {
          throw new Error(`Payment invoice disappeared during settlement: ${invoice.id}.`);
        }
        return { invoice: grandfathered, outcomes: [], ratePending: false, deferred: false };
      }

      const movements = (await db.tonhubPaymentMovement.findMany({
        where: {
          depositAddressId: invoice.depositAddress.id,
          direction: "INCOMING",
          OR: [
            { status: { in: ["OBSERVED", "VALIDATED"] } },
            {
              status: "RATE_PENDING",
              ...(input.ratePendingBefore
                ? { updatedAt: { lte: input.ratePendingBefore } }
                : {}),
            },
          ],
          blockchainAt: { gte: invoice.createdAt, lte: input.now },
        },
        orderBy: [{ blockchainAt: "asc" }, { transactionLt: "asc" }, { id: "asc" }],
      })).sort(compareMovementChronology);
      const outcomes: MovementCreditResult[] = [];
      let ratePending = false;
      let deferred = false;
      for (const movement of movements) {
        if (movement.depositAddressId !== invoice.depositAddress.id || !validDate(movement.blockchainAt)) {
          throw new Error(`Movement ${movement.id} has inconsistent settlement ownership or time.`);
        }
        const outcome = await creditor.creditMovement({
          movementId: movement.id,
          orderId: invoice.orderId,
          invoiceId: invoice.id,
          validationCode: validationCodeForMovement(movement),
          maxRateAgeMs: input.maxRateAgeMs,
          partialPaymentTtlHours: input.partialPaymentTtlHours,
        });
        outcomes.push(outcome);
        if (outcome.outcome === "rate-pending") {
          ratePending = true;
          break;
        }
        if (outcome.outcome === "blocked-earlier-movement") {
          deferred = true;
          break;
        }
      }

      let refreshed = await repository.findInvoiceById(invoice.id);
      if (!refreshed) {
        throw new Error(`Payment invoice disappeared during settlement: ${invoice.id}.`);
      }
      const deadline = refreshed.partialPaymentExpiresAt ?? refreshed.expiresAt;
      if (
        !ratePending &&
        !deferred &&
        (refreshed.status === "PENDING" || refreshed.status === "PARTIAL") &&
        deadline &&
        deadline.getTime() < input.now.getTime()
      ) {
        refreshed = await repository.markInvoiceExpired({
          invoiceId: refreshed.id,
          expiredAt: input.now,
        }) ?? refreshed;
      }
      return { invoice: refreshed, outcomes, ratePending, deferred };
    },
  };
}

export const mixedAssetSettlement = createMixedAssetSettlement(
  prisma as unknown as PrismaLike,
  movementLedger,
  prismaTonhubPaymentRepository,
);
