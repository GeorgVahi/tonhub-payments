import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { parseFiatCurrency } from "./config";
import {
  normalizeRatePrice,
  normalizeRateSnapshotRecord,
  rateSnapshotMaxAgeMs,
} from "./rate-snapshots";
import { parseTonNetwork, type TonNetwork } from "./ton/direct-payments";
import {
  assertPaymentAssetSnapshot,
  parsePaymentAsset,
  type PaymentAssetKind,
  type PaymentAssetSymbol,
} from "../../shared/payment-assets";

export type PaymentMovementDirection = "INCOMING" | "OUTGOING";
export type PaymentMovementStatus =
  | "OBSERVED"
  | "VALIDATED"
  | "RATE_PENDING"
  | "HELD_UNDER_MINIMUM"
  | "CREDITED"
  | "RECOVERY"
  | "REJECTED";

export type PaymentMovementDraft = {
  fingerprint: string;
  depositAddressId?: string | null;
  network: TonNetwork;
  direction: PaymentMovementDirection;
  asset: PaymentAssetSymbol;
  assetKind: PaymentAssetKind;
  assetDecimals: number;
  amountAtomic: string;
  fromAddress?: string | null;
  toAddress: string;
  ownerAddress?: string | null;
  jettonMasterAddress?: string | null;
  jettonWalletAddress?: string | null;
  transactionHash: string;
  transactionLt?: string | null;
  traceId?: string | null;
  queryId?: string | null;
  blockchainAt: Date;
  rawPayload?: unknown;
};

export type PaymentMovementRecord = PaymentMovementDraft & {
  id: string;
  status: PaymentMovementStatus;
  validationCode: string | null;
  rateSnapshotId: string | null;
  fiatCreditMicros: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MovementAllocationRecord = {
  id: string;
  movementId: string;
  orderId: string;
  invoiceId: string | null;
  kind: "CREDIT" | "REVERSAL";
  reversesAllocationId: string | null;
  fiatCreditMicros: string;
  allocatedBy: string;
  allocatedAt: Date;
  note: string | null;
};

type PrismaLike = {
  $transaction: <T>(handler: (tx: PrismaLike) => Promise<T>) => Promise<T>;
  $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => Promise<T>;
  tonhubPaymentMovement: any;
  tonhubMovementAllocation: any;
  tonhubPaymentOrder: any;
  tonhubPaymentInvoice: any;
  tonhubRateSnapshot: any;
};

export class MovementFingerprintConflictError extends Error {
  readonly code = "TON_MOVEMENT_FINGERPRINT_CONFLICT";

  constructor(fingerprint: string) {
    super(`Movement fingerprint ${fingerprint} already belongs to different on-chain facts.`);
    this.name = "MovementFingerprintConflictError";
  }
}

export class MovementAllocationConflictError extends Error {
  readonly code = "TON_MOVEMENT_ALLOCATION_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "MovementAllocationConflictError";
  }
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function requiredText(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function optionalText(value: unknown) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Optional movement text must be null or a non-empty string.");
  }
  return value.trim();
}

function positiveAtomic(value: string, field: string) {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${field} must be a positive atomic integer string.`);
  }
  return BigInt(value).toString();
}

function nonNegativeInteger(value: string, field: string) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${field} must be a non-negative integer string.`);
  }
  return BigInt(value).toString();
}

function canonicalJsonValue(value: unknown): unknown {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Movement rawPayload must contain only finite JSON numbers.");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalJsonValue);
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Movement rawPayload must contain only plain JSON objects.");
    }
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) {
        throw new Error("Movement rawPayload cannot contain undefined values.");
      }
      output[key] = canonicalJsonValue(record[key]);
    }
    return output;
  }
  throw new Error("Movement rawPayload must be JSON-compatible.");
}

function jsonIdentity(value: unknown) {
  return JSON.stringify(canonicalJsonValue(value));
}

function validateMovementDraft(input: PaymentMovementDraft): PaymentMovementDraft {
  const asset = assertPaymentAssetSnapshot(parsePaymentAsset(input.asset), {
    kind: input.assetKind,
    decimals: input.assetDecimals,
  });
  const direction = input.direction;
  if (direction !== "INCOMING" && direction !== "OUTGOING") {
    throw new Error("Movement direction must be INCOMING or OUTGOING.");
  }
  if (!validDate(input.blockchainAt)) {
    throw new Error("Movement blockchainAt must be a valid date.");
  }
  const jettonMasterAddress = optionalText(input.jettonMasterAddress);
  const jettonWalletAddress = optionalText(input.jettonWalletAddress);
  if (asset.kind === "NATIVE" && (jettonMasterAddress || jettonWalletAddress)) {
    throw new Error("Native movement cannot contain jetton identity fields.");
  }
  if (asset.kind === "JETTON" && (!jettonMasterAddress || !jettonWalletAddress)) {
    throw new Error("Jetton movement requires master and wallet addresses.");
  }
  return {
    fingerprint: requiredText(input.fingerprint, "Movement fingerprint"),
    depositAddressId: optionalText(input.depositAddressId),
    network: parseTonNetwork(input.network),
    direction,
    asset: asset.symbol,
    assetKind: asset.kind,
    assetDecimals: asset.decimals,
    amountAtomic: positiveAtomic(input.amountAtomic, "Movement amountAtomic"),
    fromAddress: optionalText(input.fromAddress),
    toAddress: requiredText(input.toAddress, "Movement toAddress"),
    ownerAddress: optionalText(input.ownerAddress),
    jettonMasterAddress,
    jettonWalletAddress,
    transactionHash: requiredText(input.transactionHash, "Movement transactionHash"),
    transactionLt: optionalText(input.transactionLt),
    traceId: optionalText(input.traceId),
    queryId: optionalText(input.queryId),
    blockchainAt: input.blockchainAt,
    rawPayload: canonicalJsonValue(input.rawPayload),
  };
}

function normalizeMovement(value: any): PaymentMovementRecord {
  const draft = validateMovementDraft({
    fingerprint: value.fingerprint,
    depositAddressId: value.depositAddressId,
    network: value.network,
    direction: value.direction,
    asset: value.asset,
    assetKind: value.assetKind,
    assetDecimals: value.assetDecimals,
    amountAtomic: value.amountAtomic,
    fromAddress: value.fromAddress,
    toAddress: value.toAddress,
    ownerAddress: value.ownerAddress,
    jettonMasterAddress: value.jettonMasterAddress,
    jettonWalletAddress: value.jettonWalletAddress,
    transactionHash: value.transactionHash,
    transactionLt: value.transactionLt,
    traceId: value.traceId,
    queryId: value.queryId,
    blockchainAt: value.blockchainAt,
    rawPayload: value.rawPayload ?? null,
  });
  const statuses: PaymentMovementStatus[] = [
    "OBSERVED",
    "VALIDATED",
    "RATE_PENDING",
    "HELD_UNDER_MINIMUM",
    "CREDITED",
    "RECOVERY",
    "REJECTED",
  ];
  if (
    typeof value.id !== "string" ||
    !statuses.includes(value.status) ||
    !validDate(value.createdAt) ||
    !validDate(value.updatedAt)
  ) {
    throw new Error("Stored movement has invalid lifecycle fields.");
  }
  return {
    ...draft,
    id: value.id,
    status: value.status,
    validationCode: value.validationCode ?? null,
    rateSnapshotId: value.rateSnapshotId ?? null,
    fiatCreditMicros: value.fiatCreditMicros === null || value.fiatCreditMicros === undefined
      ? null
      : nonNegativeInteger(value.fiatCreditMicros, "Movement fiatCreditMicros"),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function requireMovement(value: unknown, movementId: string) {
  if (!value) {
    throw new Error(`Payment movement not found: ${movementId}.`);
  }
  return normalizeMovement(value);
}

function movementFactsIdentity(value: PaymentMovementDraft) {
  return JSON.stringify({
    fingerprint: value.fingerprint,
    depositAddressId: value.depositAddressId ?? null,
    network: value.network,
    direction: value.direction,
    asset: value.asset,
    assetKind: value.assetKind,
    assetDecimals: value.assetDecimals,
    amountAtomic: value.amountAtomic,
    fromAddress: value.fromAddress ?? null,
    toAddress: value.toAddress,
    ownerAddress: value.ownerAddress ?? null,
    jettonMasterAddress: value.jettonMasterAddress ?? null,
    jettonWalletAddress: value.jettonWalletAddress ?? null,
    transactionHash: value.transactionHash,
    transactionLt: value.transactionLt ?? null,
    traceId: value.traceId ?? null,
    queryId: value.queryId ?? null,
    blockchainAt: value.blockchainAt.toISOString(),
    rawPayload: JSON.parse(jsonIdentity(value.rawPayload)),
  });
}

function normalizeAllocation(value: any): MovementAllocationRecord {
  if (
    typeof value.id !== "string" ||
    (value.kind !== "CREDIT" && value.kind !== "REVERSAL") ||
    !validDate(value.allocatedAt)
  ) {
    throw new Error("Stored movement allocation has invalid lifecycle fields.");
  }
  return {
    id: value.id,
    movementId: requiredText(value.movementId, "Allocation movementId"),
    orderId: requiredText(value.orderId, "Allocation orderId"),
    invoiceId: optionalText(value.invoiceId),
    kind: value.kind,
    reversesAllocationId: optionalText(value.reversesAllocationId),
    fiatCreditMicros: positiveAtomic(value.fiatCreditMicros, "Allocation fiatCreditMicros"),
    allocatedBy: requiredText(value.allocatedBy, "Allocation allocatedBy"),
    allocatedAt: value.allocatedAt,
    note: optionalText(value.note),
  };
}

export function calculateMovementFiatMicros(input: {
  amountAtomic: string;
  assetDecimals: number;
  price: string;
}) {
  const amountAtomic = positiveAtomic(input.amountAtomic, "Movement amountAtomic");
  if (!Number.isInteger(input.assetDecimals) || input.assetDecimals < 0 || input.assetDecimals > 255) {
    throw new Error("Movement assetDecimals must be an integer between 0 and 255.");
  }
  const price = normalizeRatePrice(input.price);
  const [whole, fraction = ""] = price.split(".");
  const priceCoefficient = BigInt(`${whole}${fraction}`);
  const numerator = BigInt(amountAtomic) * priceCoefficient * BigInt(1_000_000);
  const denominator = BigInt(10) ** BigInt(input.assetDecimals + fraction.length);
  return (numerator / denominator).toString();
}

function expectedRateSource(asset: PaymentAssetSymbol) {
  return parsePaymentAsset(asset).pricingStrategy === "MARKET" ? "coingecko" : "usd-peg";
}

function isP2002(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

async function lockOrder(tx: PrismaLike, orderId: string) {
  await tx.$queryRawUnsafe(
    `SELECT "id" FROM "TonhubPaymentOrder" WHERE "id" = $1 FOR UPDATE`,
    orderId,
  );
  const order = await tx.tonhubPaymentOrder.findUnique({ where: { id: orderId } });
  if (!order) {
    throw new Error(`Payment order not found: ${orderId}.`);
  }
  parseFiatCurrency(order.fiatCurrency);
  positiveAtomic(order.fiatAmountMicros, "Order fiatAmountMicros");
  nonNegativeInteger(order.creditedFiatMicros, "Order creditedFiatMicros");
  nonNegativeInteger(order.overpaymentFiatMicros, "Order overpaymentFiatMicros");
  return order;
}

async function lockMovement(tx: PrismaLike, movementId: string) {
  await tx.$queryRawUnsafe(
    `SELECT "id" FROM "TonhubPaymentMovement" WHERE "id" = $1 FOR UPDATE`,
    movementId,
  );
  return requireMovement(
    await tx.tonhubPaymentMovement.findUnique({ where: { id: movementId } }),
    movementId,
  );
}

async function orderAllocationSummary(tx: PrismaLike, orderId: string, obligation: bigint) {
  const rows = await tx.tonhubMovementAllocation.findMany({
    where: { orderId },
    include: { movement: true },
  });
  const reversedIds = new Set<string>();
  for (const row of rows) {
    const allocation = normalizeAllocation(row);
    if (allocation.kind === "REVERSAL" && allocation.reversesAllocationId) {
      reversedIds.add(allocation.reversesAllocationId);
    }
  }
  const candidates: Array<{ allocation: MovementAllocationRecord; movement: any }> = (rows as any[])
    .map((row) => ({ allocation: normalizeAllocation(row), movement: row.movement }));
  const activeCredits = candidates
    .filter(({ allocation }) => allocation.kind === "CREDIT" && !reversedIds.has(allocation.id))
    .map(({ allocation, movement }) => {
      if (!movement || !validDate(movement.blockchainAt)) {
        throw new Error(`Allocation ${allocation.id} has no valid movement blockchain time.`);
      }
      return { allocation, blockchainAt: movement.blockchainAt as Date };
    })
    .sort((left, right) =>
      left.blockchainAt.getTime() - right.blockchainAt.getTime() ||
      left.allocation.id.localeCompare(right.allocation.id));
  let netCredit = BigInt(0);
  let paidAt: Date | null = null;
  for (const { allocation, blockchainAt } of activeCredits) {
    netCredit += BigInt(allocation.fiatCreditMicros);
    if (!paidAt && netCredit >= obligation) {
      paidAt = blockchainAt;
    }
  }
  return { netCredit, paidAt };
}

async function assertOrderAccountingBaseline(tx: PrismaLike, order: any) {
  const { netCredit } = await orderAllocationSummary(
    tx,
    order.id,
    BigInt(order.fiatAmountMicros),
  );
  const materializedCredit = BigInt(order.creditedFiatMicros) + BigInt(order.overpaymentFiatMicros);
  if (netCredit !== materializedCredit) {
    throw new MovementAllocationConflictError(
      `Order ${order.id} accounting is not backed by movement allocations; backfill or recovery is required.`,
    );
  }
}

async function syncOrderAccounting(tx: PrismaLike, input: {
  order: any;
  paidAt?: Date;
  forceRecovery?: boolean;
}) {
  const obligation = BigInt(input.order.fiatAmountMicros);
  const { netCredit, paidAt } = await orderAllocationSummary(tx, input.order.id, obligation);
  if (netCredit < BigInt(0)) {
    throw new Error(`Order ${input.order.id} has a negative allocation balance.`);
  }
  const credited = netCredit < obligation ? netCredit : obligation;
  const overpayment = netCredit > obligation ? netCredit - obligation : BigInt(0);
  const wasTerminal = ["EXPIRED", "CANCELLED", "FAILED", "RECOVERY"].includes(input.order.status);
  const status = input.forceRecovery || wasTerminal
    ? "RECOVERY"
    : netCredit >= obligation
      ? "PAID"
      : netCredit > BigInt(0)
        ? "PARTIAL"
        : "PENDING";
  return tx.tonhubPaymentOrder.update({
    where: { id: input.order.id },
    data: {
      creditedFiatMicros: credited.toString(),
      overpaymentFiatMicros: overpayment.toString(),
      status,
      paidAt: status === "PAID" ? paidAt ?? input.paidAt ?? input.order.paidAt : input.order.paidAt,
    },
  });
}

async function findCreditAllocation(tx: PrismaLike, movementId: string) {
  const value = await tx.tonhubMovementAllocation.findFirst({
    where: { movementId, kind: "CREDIT" },
  });
  return value ? normalizeAllocation(value) : null;
}

function assertAllocationTarget(
  allocation: MovementAllocationRecord,
  input: { orderId: string; invoiceId?: string | null },
) {
  if (allocation.orderId !== input.orderId || allocation.invoiceId !== (input.invoiceId ?? null)) {
    throw new MovementAllocationConflictError(
      `Movement ${allocation.movementId} is already allocated to another order or invoice.`,
    );
  }
}

async function markRatePending(
  tx: PrismaLike,
  movement: PaymentMovementRecord,
  validationCode: string,
) {
  if (movement.validationCode && movement.validationCode !== validationCode) {
    throw new MovementAllocationConflictError("Movement validation evidence cannot be replaced.");
  }
  if (movement.status !== "RATE_PENDING") {
    await tx.tonhubPaymentMovement.updateMany({
      where: { id: movement.id, status: movement.status },
      data: { status: "RATE_PENDING", validationCode },
    });
  }
  return requireMovement(
    await tx.tonhubPaymentMovement.findUnique({ where: { id: movement.id } }),
    movement.id,
  );
}

export function createMovementLedger(db: PrismaLike) {
  return {
    recordObserved: async (input: PaymentMovementDraft) => {
      const draft = validateMovementDraft(input);
      return db.$transaction(async (tx) => {
        await tx.tonhubPaymentMovement.createMany({
          data: [{
            ...draft,
            rawPayload: draft.rawPayload === null
              ? Prisma.DbNull
              : draft.rawPayload as Prisma.InputJsonValue,
          }],
          skipDuplicates: true,
        });
        const stored = await tx.tonhubPaymentMovement.findUnique({
          where: { fingerprint: draft.fingerprint },
        });
        if (!stored) {
          throw new Error(`Movement was not persisted: ${draft.fingerprint}.`);
        }
        const movement = normalizeMovement(stored);
        if (movementFactsIdentity(movement) !== movementFactsIdentity(draft)) {
          throw new MovementFingerprintConflictError(draft.fingerprint);
        }
        return movement;
      });
    },

    creditMovement: async (input: {
      movementId: string;
      orderId: string;
      invoiceId: string;
      validationCode: string;
      allocatedBy?: string;
      maxRateAgeMs?: number;
    }) => db.$transaction(async (tx) => {
      const orderId = requiredText(input.orderId, "Allocation orderId");
      const movementId = requiredText(input.movementId, "Allocation movementId");
      const invoiceId = requiredText(input.invoiceId, "Allocation invoiceId");
      const validationCode = requiredText(input.validationCode, "Movement validationCode");
      const allocatedBy = requiredText(input.allocatedBy ?? "system", "Allocation allocatedBy");
      const maxRateAgeMs = input.maxRateAgeMs ?? rateSnapshotMaxAgeMs();
      if (!Number.isInteger(maxRateAgeMs) || maxRateAgeMs < 0) {
        throw new Error("Movement maxRateAgeMs must be a non-negative integer.");
      }
      const order = await lockOrder(tx, orderId);
      await assertOrderAccountingBaseline(tx, order);
      let movement = await lockMovement(tx, movementId);
      if (movement.direction !== "INCOMING") {
        throw new MovementAllocationConflictError("Only incoming movements can credit an order.");
      }
      if (["REJECTED", "HELD_UNDER_MINIMUM"].includes(movement.status)) {
        throw new MovementAllocationConflictError(`Movement ${movement.id} is ${movement.status}.`);
      }
      if (movement.validationCode && movement.validationCode !== validationCode) {
        throw new MovementAllocationConflictError("Movement validation evidence cannot be replaced.");
      }
      const invoice = await tx.tonhubPaymentInvoice.findUnique({
        where: { id: invoiceId },
        include: { depositAddress: true },
      });
      if (!invoice || invoice.orderId !== orderId) {
        throw new MovementAllocationConflictError("Allocation invoice does not belong to the order.");
      }
      if (!movement.depositAddressId || invoice.depositAddress?.id !== movement.depositAddressId) {
        throw new MovementAllocationConflictError("Movement deposit address does not belong to the invoice.");
      }
      if (movement.status === "CREDITED") {
        const allocation = await findCreditAllocation(tx, movement.id);
        if (!allocation) {
          throw new MovementAllocationConflictError("Credited movement has no CREDIT allocation.");
        }
        assertAllocationTarget(allocation, { orderId, invoiceId });
        return { outcome: "credited" as const, movement, allocation, order };
      }

      const rateValue = await tx.tonhubRateSnapshot.findFirst({
        where: {
          asset: movement.asset,
          baseCurrency: movement.asset,
          quoteCurrency: order.fiatCurrency,
          source: expectedRateSource(movement.asset),
          observedAt: { lte: movement.blockchainAt },
        },
        orderBy: [{ observedAt: "desc" }, { fetchedAt: "desc" }, { createdAt: "desc" }],
      });
      if (!rateValue) {
        movement = await markRatePending(tx, movement, validationCode);
        return { outcome: "rate-pending" as const, movement, allocation: null, order };
      }
      const rate = normalizeRateSnapshotRecord(rateValue);
      if (movement.blockchainAt.getTime() - rate.observedAt.getTime() > maxRateAgeMs) {
        movement = await markRatePending(tx, movement, validationCode);
        return { outcome: "rate-pending" as const, movement, allocation: null, order };
      }
      const fiatCreditMicros = calculateMovementFiatMicros({
        amountAtomic: movement.amountAtomic,
        assetDecimals: movement.assetDecimals,
        price: rate.price,
      });
      if (fiatCreditMicros === "0") {
        await tx.tonhubPaymentMovement.updateMany({
          where: { id: movement.id, status: movement.status },
          data: { status: "HELD_UNDER_MINIMUM", validationCode },
        });
        movement = requireMovement(
          await tx.tonhubPaymentMovement.findUnique({ where: { id: movement.id } }),
          movement.id,
        );
        return { outcome: "held-under-minimum" as const, movement, allocation: null, order };
      }

      const claimed = await tx.tonhubPaymentMovement.updateMany({
        where: {
          id: movement.id,
          status: { in: ["OBSERVED", "VALIDATED", "RATE_PENDING", "RECOVERY"] },
        },
        data: {
          status: "CREDITED",
          validationCode,
          rateSnapshotId: rate.id,
          fiatCreditMicros,
        },
      });
      if (!claimed.count) {
        movement = requireMovement(
          await tx.tonhubPaymentMovement.findUnique({ where: { id: movement.id } }),
          movement.id,
        );
        const allocation = await findCreditAllocation(tx, movement.id);
        if (movement.status !== "CREDITED" || !allocation) {
          throw new MovementAllocationConflictError(`Movement ${movement.id} changed concurrently.`);
        }
        assertAllocationTarget(allocation, { orderId, invoiceId });
        return { outcome: "credited" as const, movement, allocation, order };
      }

      let allocation: MovementAllocationRecord;
      try {
        allocation = normalizeAllocation(await tx.tonhubMovementAllocation.create({
          data: {
            movementId: movement.id,
            orderId,
            invoiceId,
            kind: "CREDIT",
            fiatCreditMicros,
            allocatedBy,
          },
        }));
      } catch (error) {
        if (!isP2002(error)) {
          throw error;
        }
        const existing = await findCreditAllocation(tx, movement.id);
        if (!existing) {
          throw error;
        }
        assertAllocationTarget(existing, { orderId, invoiceId });
        allocation = existing;
      }
      movement = requireMovement(
        await tx.tonhubPaymentMovement.findUnique({ where: { id: movement.id } }),
        movement.id,
      );
      const updatedOrder = await syncOrderAccounting(tx, {
        order,
        paidAt: movement.blockchainAt,
      });
      return { outcome: "credited" as const, movement, allocation, order: updatedOrder };
    }),

    reverseAllocation: async (input: {
      allocationId: string;
      allocatedBy: string;
      note: string;
    }) => db.$transaction(async (tx) => {
      const allocationId = requiredText(input.allocationId, "Reversed allocationId");
      const allocatedBy = requiredText(input.allocatedBy, "Reversal allocatedBy");
      const note = requiredText(input.note, "Reversal note");
      let original = await tx.tonhubMovementAllocation.findUnique({ where: { id: allocationId } });
      if (!original || original.kind !== "CREDIT") {
        throw new MovementAllocationConflictError("Only a CREDIT allocation can be reversed.");
      }
      const order = await lockOrder(tx, original.orderId);
      await assertOrderAccountingBaseline(tx, order);
      original = normalizeAllocation(await tx.tonhubMovementAllocation.findUnique({ where: { id: allocationId } }));
      const existing = await tx.tonhubMovementAllocation.findFirst({
        where: { reversesAllocationId: allocationId },
      });
      let reversal: MovementAllocationRecord;
      if (existing) {
        reversal = normalizeAllocation(existing);
        if (reversal.allocatedBy !== allocatedBy || reversal.note !== note) {
          throw new MovementAllocationConflictError(
            `Allocation ${allocationId} was already reversed with different audit evidence.`,
          );
        }
      } else {
        reversal = normalizeAllocation(await tx.tonhubMovementAllocation.create({
          data: {
            movementId: original.movementId,
            orderId: original.orderId,
            invoiceId: original.invoiceId,
            kind: "REVERSAL",
            reversesAllocationId: original.id,
            fiatCreditMicros: original.fiatCreditMicros,
            allocatedBy,
            note,
          },
        }));
      }
      const updatedOrder = await syncOrderAccounting(tx, { order, forceRecovery: true });
      return { original, reversal, order: updatedOrder };
    }),
  };
}

export const movementLedger = createMovementLedger(prisma as unknown as PrismaLike);
