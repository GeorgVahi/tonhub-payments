import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { parseFiatCurrency } from "./config";
import {
  normalizeRatePrice,
  normalizeRateSnapshotRecord,
  rateSnapshotMaxAgeMs,
} from "./rate-snapshots";
import { parseTonNetwork, type TonNetwork } from "./ton/direct-payments";
import { canonicalTonAddress } from "./ton/gram-shadow-scanner";
import { officialMainnetUsdtMasterAddress } from "./ton/jetton-identities";
import {
  assertPaymentAssetSnapshot,
  formatAssetAmount,
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
  tonhubOrderAdjustment: any;
  tonhubPaymentOrder: any;
  tonhubPaymentInvoice: any;
  tonhubPaymentQuote: any;
  tonhubDepositAddress: any;
  tonhubDepositAssetAccount: any;
  tonhubAssetSweep: any;
  tonhubRecoveryCase: any;
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

function officialUsdtPayload(value: unknown) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).officialUsdt === true &&
    (value as Record<string, unknown>).internalTestAsset !== true;
}

async function enqueueOfficialUsdtSweep(tx: PrismaLike, movement: PaymentMovementRecord) {
  if (
    movement.network !== "mainnet" ||
    movement.direction !== "INCOMING" ||
    movement.asset !== "USDT" ||
    movement.assetKind !== "JETTON" ||
    movement.assetDecimals !== 6 ||
    movement.status === "REJECTED" ||
    canonicalTonAddress(movement.jettonMasterAddress) !== officialMainnetUsdtMasterAddress ||
    !officialUsdtPayload(movement.rawPayload) ||
    !movement.depositAddressId
  ) {
    return null;
  }
  const deposit = await tx.tonhubDepositAddress.findUnique({
    where: { id: movement.depositAddressId },
    include: {
      invoice: true,
      assetAccounts: { where: { asset: "USDT" } },
    },
  });
  const invoice = deposit?.invoice;
  const account = deposit?.assetAccounts?.[0];
  const accountWalletAddress = canonicalTonAddress(account?.assetWalletAddress);
  const movementWalletAddress = canonicalTonAddress(movement.jettonWalletAddress);
  const ownerAddresses = [
    deposit?.address,
    deposit?.addressRaw,
    invoice?.address,
    invoice?.addressRaw,
    movement.toAddress,
    movement.ownerAddress,
  ].map(canonicalTonAddress);
  if (
    !deposit || !invoice || !account ||
    deposit.network !== "mainnet" ||
    invoice.network !== "mainnet" ||
    ownerAddresses.some((address) => !address || address !== ownerAddresses[0]) ||
    account.network !== "mainnet" ||
    account.asset !== "USDT" ||
    account.assetKind !== "JETTON" ||
    account.assetDecimals !== 6 ||
    account.status !== "VERIFIED" ||
    canonicalTonAddress(account.jettonMasterAddress) !== officialMainnetUsdtMasterAddress ||
    !accountWalletAddress ||
    !movementWalletAddress ||
    accountWalletAddress !== movementWalletAddress
  ) {
    throw new MovementAllocationConflictError(
      `Official USDT movement ${movement.id} cannot queue a sweep because ownership evidence is inconsistent.`,
    );
  }
  const idempotencyKey = `official-usdt-movement:${movement.id}`;
  await tx.$queryRawUnsafe(
    `SELECT "id" FROM "TonhubAssetSweep"
     WHERE "depositAddressId" = $1 AND "asset" = 'USDT'
       AND "status" IN ('QUEUED', 'GAS_CHECK', 'GAS_TOPUP_REQUIRED', 'GAS_TOPUP_SENT', 'READY', 'SENT', 'FAILED')
     FOR UPDATE`,
    deposit.id,
  );
  const ledgerMovements = await tx.tonhubPaymentMovement.findMany({
    where: {
      depositAddressId: deposit.id,
      network: "mainnet",
      asset: "USDT",
      assetKind: "JETTON",
      status: { not: "REJECTED" },
    },
    select: { direction: true, amountAtomic: true },
  });
  const unsweptAtomic = ledgerMovements.reduce(
    (balance: bigint, candidate: { direction: string; amountAtomic: string }) =>
      balance + (candidate.direction === "INCOMING" ? 1n : -1n) * BigInt(candidate.amountAtomic),
    0n,
  );
  if (unsweptAtomic <= 0n) {
    return null;
  }
  await tx.tonhubAssetSweep.createMany({
    data: {
      idempotencyKey,
      depositAddressId: deposit.id,
      orderId: invoice.orderId,
      invoiceId: invoice.id,
      asset: "USDT",
      assetKind: "JETTON",
      status: "QUEUED",
    },
    skipDuplicates: true,
  });
  const sweep = await tx.tonhubAssetSweep.findFirst({
    where: {
      depositAddressId: deposit.id,
      asset: "USDT",
      OR: [
        { idempotencyKey },
        {
          status: {
            in: [
              "QUEUED",
              "GAS_CHECK",
              "GAS_TOPUP_REQUIRED",
              "GAS_TOPUP_SENT",
              "READY",
              "SENT",
              "FAILED",
            ],
          },
        },
      ],
    },
    orderBy: { createdAt: "desc" },
  });
  if (!sweep) {
    throw new Error(`Official USDT movement ${movement.id} did not create or join an active sweep.`);
  }
  return sweep;
}

function compareMovementChronology(left: PaymentMovementRecord, right: PaymentMovementRecord) {
  const timeDifference = left.blockchainAt.getTime() - right.blockchainAt.getTime();
  if (timeDifference) {
    return timeDifference;
  }
  const leftLt = left.transactionLt && /^\d+$/.test(left.transactionLt)
    ? BigInt(left.transactionLt)
    : null;
  const rightLt = right.transactionLt && /^\d+$/.test(right.transactionLt)
    ? BigInt(right.transactionLt)
    : null;
  if (leftLt !== null && rightLt !== null && leftLt !== rightLt) {
    return leftLt < rightLt ? -1 : 1;
  }
  if (leftLt !== null || rightLt !== null) {
    return leftLt !== null ? -1 : 1;
  }
  return left.id.localeCompare(right.id);
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

export function calculateActivationThresholdFiatMicros(input: {
  orderFiatMicros: string;
  merchantNetworkFeeFiatMicros?: string;
}) {
  const obligation = BigInt(positiveAtomic(input.orderFiatMicros, "Order fiatAmountMicros"));
  const merchantNetworkFee = BigInt(nonNegativeInteger(
    input.merchantNetworkFeeFiatMicros ?? "0",
    "Merchant network fee fiat micros",
  ));
  const halfOrder = (obligation + BigInt(1)) / BigInt(2);
  const doubleMerchantCost = merchantNetworkFee * BigInt(2);
  const threshold = halfOrder > doubleMerchantCost ? halfOrder : doubleMerchantCost;
  return (threshold < obligation ? threshold : obligation).toString();
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

async function lockObservedMovementOrder(
  tx: PrismaLike,
  movement: PaymentMovementDraft,
) {
  if (movement.direction !== "INCOMING" || !movement.depositAddressId) {
    return;
  }
  await tx.$queryRawUnsafe(
    `SELECT payment_order."id"
     FROM "TonhubDepositAddress" AS deposit
     JOIN "TonhubPaymentInvoice" AS invoice ON invoice."id" = deposit."invoiceId"
     JOIN "TonhubPaymentOrder" AS payment_order ON payment_order."id" = invoice."orderId"
     WHERE deposit."id" = $1
     FOR UPDATE OF payment_order`,
    movement.depositAddressId,
  );
}

async function lockObservedMovementSelection(
  tx: PrismaLike,
  movement: PaymentMovementDraft,
) {
  if (movement.direction !== "INCOMING" || !movement.depositAddressId) {
    return;
  }
  const deposit = await tx.tonhubDepositAddress.findUnique({
    where: { id: movement.depositAddressId },
    include: { invoice: true },
  });
  if (deposit?.invoice) {
    await lockInvoicePaymentSelection(tx, deposit.invoice, movement.blockchainAt);
  }
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
      if (!movement) {
        throw new Error(`Allocation ${allocation.id} has no valid movement blockchain time.`);
      }
      return { allocation, movement: requireMovement(movement, allocation.movementId) };
    })
    .sort((left, right) => compareMovementChronology(left.movement, right.movement));
  let netCredit = BigInt(0);
  let paidAt: Date | null = null;
  let paidMovement: PaymentMovementRecord | null = null;
  for (const { allocation, movement } of activeCredits) {
    netCredit += BigInt(allocation.fiatCreditMicros);
    if (!paidAt && netCredit >= obligation) {
      paidAt = movement.blockchainAt;
      paidMovement = movement;
    }
  }
  return { netCredit, paidAt, paidMovement, activeCredits };
}

type OrderAdjustmentRecord = {
  id: string;
  idempotencyKey: string;
  orderId: string;
  invoiceId: string;
  quoteId: string;
  kind: "PAYMENT_METHOD_DISCOUNT" | "REVERSAL";
  reversesAdjustmentId: string | null;
  fiatAmountMicros: string;
  fiatCurrency: string;
  reason: string;
  evidence: unknown;
};

function normalizeOrderAdjustment(value: unknown): OrderAdjustmentRecord {
  if (!value || typeof value !== "object") {
    throw new MovementAllocationConflictError("Order adjustment evidence is missing.");
  }
  const row = value as OrderAdjustmentRecord;
  if (
    (row.kind !== "PAYMENT_METHOD_DISCOUNT" && row.kind !== "REVERSAL") ||
    !row.id ||
    !row.idempotencyKey ||
    !row.orderId ||
    !row.invoiceId ||
    !row.quoteId ||
    !row.fiatCurrency ||
    !row.reason
  ) {
    throw new MovementAllocationConflictError("Order adjustment evidence is malformed.");
  }
  nonNegativeInteger(row.fiatAmountMicros, "Order adjustment fiatAmountMicros");
  if (
    (row.kind === "PAYMENT_METHOD_DISCOUNT" && row.reversesAdjustmentId !== null) ||
    (row.kind === "REVERSAL" && !row.reversesAdjustmentId)
  ) {
    throw new MovementAllocationConflictError("Order adjustment lifecycle is malformed.");
  }
  return row;
}

async function orderAdjustmentSummary(tx: PrismaLike, orderId: string) {
  const rows: OrderAdjustmentRecord[] = (await tx.tonhubOrderAdjustment.findMany({ where: { orderId } }))
    .map(normalizeOrderAdjustment);
  const reversedIds = new Set(
    rows
      .filter((row) => row.kind === "REVERSAL" && row.reversesAdjustmentId)
      .map((row) => row.reversesAdjustmentId as string),
  );
  const activeDiscounts = rows.filter((row) => (
    row.kind === "PAYMENT_METHOD_DISCOUNT" && !reversedIds.has(row.id)
  ));
  const netDiscount = rows.reduce((sum, row) => (
    row.kind === "PAYMENT_METHOD_DISCOUNT"
      ? sum + BigInt(row.fiatAmountMicros)
      : sum - BigInt(row.fiatAmountMicros)
  ), BigInt(0));
  if (netDiscount < BigInt(0)) {
    throw new MovementAllocationConflictError(`Order ${orderId} has a negative adjustment balance.`);
  }
  return { rows, activeDiscounts, netDiscount };
}

function sameAdjustmentFacts(
  left: OrderAdjustmentRecord,
  right: Omit<OrderAdjustmentRecord, "id">,
) {
  return left.idempotencyKey === right.idempotencyKey &&
    left.orderId === right.orderId &&
    left.invoiceId === right.invoiceId &&
    left.quoteId === right.quoteId &&
    left.kind === right.kind &&
    left.reversesAdjustmentId === right.reversesAdjustmentId &&
    left.fiatAmountMicros === right.fiatAmountMicros &&
    left.fiatCurrency === right.fiatCurrency &&
    left.reason === right.reason &&
    jsonIdentity(left.evidence) === jsonIdentity(right.evidence);
}

async function createIdempotentOrderAdjustment(
  tx: PrismaLike,
  input: Omit<OrderAdjustmentRecord, "id">,
) {
  try {
    return normalizeOrderAdjustment(await tx.tonhubOrderAdjustment.create({
      data: {
        ...input,
        evidence: input.evidence as Prisma.InputJsonValue,
      },
    }));
  } catch (error) {
    if (!isP2002(error)) throw error;
    const stored = normalizeOrderAdjustment(await tx.tonhubOrderAdjustment.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    }));
    if (!sameAdjustmentFacts(stored, input)) {
      throw new MovementAllocationConflictError(
        `Order adjustment ${input.idempotencyKey} conflicts with immutable evidence.`,
      );
    }
    return stored;
  }
}

async function reverseActivePaymentMethodDiscounts(tx: PrismaLike, input: {
  orderId: string;
  cause: string;
  evidence: Record<string, unknown>;
}) {
  const summary = await orderAdjustmentSummary(tx, input.orderId);
  for (const discount of summary.activeDiscounts) {
    await createIdempotentOrderAdjustment(tx, {
      idempotencyKey: `payment-method-discount-reversal:${discount.id}`,
      orderId: discount.orderId,
      invoiceId: discount.invoiceId,
      quoteId: discount.quoteId,
      kind: "REVERSAL",
      reversesAdjustmentId: discount.id,
      fiatAmountMicros: discount.fiatAmountMicros,
      fiatCurrency: discount.fiatCurrency,
      reason: input.cause,
      evidence: input.evidence,
    });
  }
}

async function lockInvoicePaymentSelection(
  tx: PrismaLike,
  invoice: any,
  lockedAt: Date,
) {
  const selectedAsset = parsePaymentAsset(invoice.checkoutAsset ?? invoice.asset ?? "GRAM").symbol;
  if (invoice.paymentSelectionLockedAt !== null && invoice.paymentSelectionLockedAt !== undefined) {
    if (
      !validDate(invoice.paymentSelectionLockedAt) ||
      invoice.paymentSelectionLockedAsset !== selectedAsset
    ) {
      throw new MovementAllocationConflictError(
        `Invoice ${invoice.id} has inconsistent payment-selection evidence.`,
      );
    }
    return invoice;
  }
  if (invoice.paymentSelectionLockedAsset !== null && invoice.paymentSelectionLockedAsset !== undefined) {
    throw new MovementAllocationConflictError(
      `Invoice ${invoice.id} has incomplete payment-selection evidence.`,
    );
  }
  const locked = await tx.tonhubPaymentInvoice.updateMany({
    where: {
      id: invoice.id,
      paymentSelectionLockedAsset: null,
      paymentSelectionLockedAt: null,
    },
    data: {
      paymentSelectionLockedAsset: selectedAsset,
      paymentSelectionLockedAt: lockedAt,
    },
  });
  if (locked.count === 1) {
    return {
      ...invoice,
      paymentSelectionLockedAsset: selectedAsset,
      paymentSelectionLockedAt: lockedAt,
    };
  }
  const current = await tx.tonhubPaymentInvoice.findUnique({ where: { id: invoice.id } });
  if (
    !current ||
    current.paymentSelectionLockedAsset !== selectedAsset ||
    !validDate(current.paymentSelectionLockedAt)
  ) {
    throw new MovementAllocationConflictError(
      `Invoice ${invoice.id} payment selection changed concurrently.`,
    );
  }
  return { ...invoice, ...current };
}

async function applyEligibleGramOnlyDiscount(tx: PrismaLike, input: {
  order: any;
  invoice: any;
  forceRecovery: boolean;
  movement: PaymentMovementRecord;
  hasOtherUnresolvedMovements: boolean;
}) {
  if (
    input.forceRecovery ||
    input.hasOtherUnresolvedMovements ||
    input.invoice.checkoutAsset !== "GRAM" ||
    input.invoice.paymentSelectionLockedAsset !== "GRAM"
  ) {
    return null;
  }
  const obligation = BigInt(input.order.fiatAmountMicros);
  const allocationSummary = await orderAllocationSummary(tx, input.order.id, obligation);
  if (
    allocationSummary.activeCredits.length === 0 ||
    allocationSummary.activeCredits.some(({ movement }) => movement.asset !== "GRAM") ||
    allocationSummary.netCredit >= obligation
  ) {
    return null;
  }
  const adjustmentSummary = await orderAdjustmentSummary(tx, input.order.id);
  if (adjustmentSummary.activeDiscounts.length > 0) {
    return adjustmentSummary.activeDiscounts[0];
  }
  const quote = await tx.tonhubPaymentQuote.findFirst({
    where: {
      orderId: input.order.id,
      invoiceId: input.invoice.id,
      asset: "GRAM",
    },
  });
  if (!quote) return null;
  const quoteGross = BigInt(nonNegativeInteger(quote.grossFiatMicros, "GRAM quote grossFiatMicros"));
  const quoteDiscount = BigInt(nonNegativeInteger(
    quote.discountFiatMicros,
    "GRAM quote discountFiatMicros",
  ));
  const quoteNet = BigInt(nonNegativeInteger(quote.netFiatMicros, "GRAM quote netFiatMicros"));
  if (
    quote.orderId !== input.order.id ||
    quote.invoiceId !== input.invoice.id ||
    quote.asset !== "GRAM" ||
    quote.fiatCurrency !== input.order.fiatCurrency ||
    quoteGross !== obligation ||
    quoteGross !== quoteNet + quoteDiscount
  ) {
    throw new MovementAllocationConflictError("The GRAM discount quote has inconsistent ownership or value.");
  }
  const shortfall = obligation - allocationSummary.netCredit;
  if (quoteDiscount === BigInt(0) || allocationSummary.netCredit < quoteNet || shortfall > quoteDiscount) {
    return null;
  }
  return createIdempotentOrderAdjustment(tx, {
    idempotencyKey: `payment-method-discount:${input.order.id}`,
    orderId: input.order.id,
    invoiceId: input.invoice.id,
    quoteId: quote.id,
    kind: "PAYMENT_METHOD_DISCOUNT",
    reversesAdjustmentId: null,
    fiatAmountMicros: shortfall.toString(),
    fiatCurrency: input.order.fiatCurrency,
    reason: "GRAM_ONLY_SETTLEMENT",
    evidence: {
      selectedAsset: "GRAM",
      observedAssets: ["GRAM"],
      creditedFiatMicros: allocationSummary.netCredit.toString(),
      grossFiatMicros: obligation.toString(),
      closingMovementId: input.movement.id,
      closingMovementBlockchainAt: input.movement.blockchainAt.toISOString(),
    },
  });
}

async function assertOrderAccountingBaseline(tx: PrismaLike, order: any) {
  const summary = await orderAllocationSummary(
    tx,
    order.id,
    BigInt(order.fiatAmountMicros),
  );
  const materializedCredit = BigInt(order.creditedFiatMicros) + BigInt(order.overpaymentFiatMicros);
  if (summary.netCredit !== materializedCredit) {
    throw new MovementAllocationConflictError(
      `Order ${order.id} accounting is not backed by movement allocations; backfill or recovery is required.`,
    );
  }
  const adjustmentSummary = await orderAdjustmentSummary(tx, order.id);
  const materializedDiscount = BigInt(nonNegativeInteger(
    order.discountFiatMicros ?? "0",
    "Order discountFiatMicros",
  ));
  if (adjustmentSummary.netDiscount !== materializedDiscount) {
    throw new MovementAllocationConflictError(
      `Order ${order.id} discount is not backed by append-only adjustments.`,
    );
  }
  return { ...summary, adjustmentSummary };
}

async function syncOrderAccounting(tx: PrismaLike, input: {
  order: any;
  paidAt?: Date;
  forceRecovery?: boolean;
  allowExpiredRevival?: boolean;
  expiresAt?: Date | null;
}) {
  const obligation = BigInt(input.order.fiatAmountMicros);
  const { netCredit, paidAt, activeCredits } = await orderAllocationSummary(
    tx,
    input.order.id,
    obligation,
  );
  const { netDiscount } = await orderAdjustmentSummary(tx, input.order.id);
  if (netCredit < BigInt(0)) {
    throw new Error(`Order ${input.order.id} has a negative allocation balance.`);
  }
  const credited = netCredit < obligation ? netCredit : obligation;
  const overpayment = netCredit > obligation ? netCredit - obligation : BigInt(0);
  const wasTerminal = ["EXPIRED", "CANCELLED", "FAILED", "RECOVERY"].includes(input.order.status);
  const terminalLocksRecovery = wasTerminal && !(
    input.allowExpiredRevival && input.order.status === "EXPIRED"
  );
  const effectiveCredit = netCredit + netDiscount;
  const status = input.forceRecovery || terminalLocksRecovery
    ? "RECOVERY"
    : effectiveCredit >= obligation
      ? "PAID"
      : effectiveCredit > BigInt(0)
        ? "PARTIAL"
        : "PENDING";
  return tx.tonhubPaymentOrder.update({
    where: { id: input.order.id },
    data: {
      creditedFiatMicros: credited.toString(),
      overpaymentFiatMicros: overpayment.toString(),
      status,
      paidAt: status === "PAID"
        ? paidAt ?? activeCredits.at(-1)?.movement.blockchainAt ?? input.paidAt ?? input.order.paidAt
        : input.order.paidAt,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    },
  });
}

async function findLockedGramRate(tx: PrismaLike, orderId: string, quoteCurrency: string) {
  const rows = await tx.tonhubMovementAllocation.findMany({
    where: { orderId, kind: "CREDIT" },
    include: { movement: { include: { rateSnapshot: true } } },
    orderBy: [{ allocatedAt: "asc" }, { id: "asc" }],
  });
  for (const row of rows as any[]) {
    const movement = row.movement;
    if (movement?.asset !== "GRAM" || !movement.rateSnapshotId) {
      continue;
    }
    const rateValue = movement.rateSnapshot ?? await tx.tonhubRateSnapshot.findUnique({
      where: { id: movement.rateSnapshotId },
    });
    if (!rateValue) {
      throw new MovementAllocationConflictError("The locked GRAM rate snapshot is missing.");
    }
    const rate = normalizeRateSnapshotRecord(rateValue);
    if (
      rate.asset !== "GRAM" ||
      rate.baseCurrency !== "GRAM" ||
      rate.quoteCurrency !== quoteCurrency ||
      rate.source !== "coingecko"
    ) {
      throw new MovementAllocationConflictError("The locked GRAM rate snapshot has inconsistent identity.");
    }
    return rate;
  }
  return null;
}

function partialWindowEnd(startedAt: Date, partialPaymentTtlHours: number) {
  const expiresAt = new Date(startedAt);
  expiresAt.setUTCHours(expiresAt.getUTCHours() + partialPaymentTtlHours);
  return expiresAt;
}

function invoiceStatusIsActive(status: string) {
  return status === "PENDING" || status === "PARTIAL";
}

async function createRecoveryCase(tx: PrismaLike, input: {
  movementId: string;
  orderId: string;
  invoiceId: string;
  reason: string;
  title: string;
  details: Record<string, unknown>;
}) {
  await tx.tonhubRecoveryCase.createMany({
    data: {
      movementId: input.movementId,
      orderId: input.orderId,
      invoiceId: input.invoiceId,
      reason: input.reason,
      title: input.title,
      details: input.details as Prisma.InputJsonValue,
    },
    skipDuplicates: true,
  });
}

async function syncInvoiceAccounting(tx: PrismaLike, input: {
  invoice: any;
  order: any;
  movement: PaymentMovementRecord;
  forceRecovery: boolean;
  partialPaymentTtlHours: number;
  recoveryInvoiceStatus?: "EXPIRED" | "FAILED";
  settlementReason?: string;
}) {
  const rows = await tx.tonhubMovementAllocation.findMany({
    where: { invoiceId: input.invoice.id },
    include: { movement: true },
  });
  const reversedIds = new Set<string>();
  for (const row of rows as any[]) {
    if (row.kind === "REVERSAL" && row.reversesAllocationId) {
      reversedIds.add(row.reversesAllocationId);
    }
  }
  const credits = (rows as any[])
    .filter((row) => row.kind === "CREDIT" && !reversedIds.has(row.id) && row.movement)
    .map((row) => ({
      ...row,
      movement: requireMovement(row.movement, row.movementId),
    }))
    .sort((left, right) => compareMovementChronology(left.movement, right.movement));
  const obligation = BigInt(input.order.fiatAmountMicros);
  const netCredit = credits.reduce(
    (sum, row) => sum + BigInt(row.fiatCreditMicros),
    BigInt(0),
  );
  const { netDiscount } = await orderAdjustmentSummary(tx, input.order.id);
  const credited = netCredit < obligation ? netCredit : obligation;
  const effectiveCredit = netCredit + netDiscount;
  const remaining = effectiveCredit < obligation ? obligation - effectiveCredit : BigInt(0);
  const checkoutAsset = parsePaymentAsset(input.invoice.checkoutAsset ?? "GRAM");
  const paidAmountAtomic = credits
    .filter((row) => row.movement.asset === checkoutAsset.symbol)
    .reduce((sum, row) => sum + BigInt(row.movement.amountAtomic), BigInt(0));
  const firstMovementAt = credits[0]?.movement.blockchainAt ?? input.invoice.firstMovementAt ?? null;
  const latestMovementAt = credits[credits.length - 1]?.movement.blockchainAt ?? null;
  const partialPaymentExpiresAt = firstMovementAt
    ? partialWindowEnd(firstMovementAt, input.partialPaymentTtlHours)
    : input.invoice.partialPaymentExpiresAt ?? null;
  let cumulativeCredit = BigInt(0);
  let paidMovement: PaymentMovementRecord | null = null;
  for (const row of credits) {
    cumulativeCredit += BigInt(row.fiatCreditMicros);
    if (!paidMovement && cumulativeCredit + netDiscount >= obligation) {
      paidMovement = row.movement;
    }
  }
  const currentStatus = String(input.invoice.status);
  const status = input.forceRecovery
    ? input.recoveryInvoiceStatus ?? (invoiceStatusIsActive(currentStatus) ? "EXPIRED" : currentStatus)
    : input.order.status === "PAID"
      ? "PAID"
      : netCredit > BigInt(0)
        ? "PARTIAL"
        : "PENDING";
  const observedPayments = credits.map((row) => {
    const asset = parsePaymentAsset(row.movement.asset);
    return {
      transactionId: row.movement.transactionHash,
      asset: asset.symbol,
      assetDecimals: asset.decimals,
      amountAtomic: row.movement.amountAtomic,
      amountFormatted: formatAssetAmount(row.movement.amountAtomic, asset),
      ...(asset.symbol === "GRAM"
        ? {
            amountNano: row.movement.amountAtomic,
            amountGram: formatAssetAmount(row.movement.amountAtomic, asset),
            amountTon: formatAssetAmount(row.movement.amountAtomic, asset),
          }
        : {}),
      createdAt: row.movement.blockchainAt.toISOString(),
      status: "observed",
      comment: "",
    };
  });
  const updated = await tx.tonhubPaymentInvoice.update({
    where: { id: input.invoice.id },
    data: {
      status,
      creditedFiatMicros: credited.toString(),
      remainingFiatMicros: remaining.toString(),
      paidNano: checkoutAsset.symbol === "GRAM" ? paidAmountAtomic.toString() : input.invoice.paidNano,
      paidAmountAtomic: paidAmountAtomic.toString(),
      firstMovementAt,
      partialPaymentStartedAt: effectiveCredit > BigInt(0) && effectiveCredit < obligation
        ? firstMovementAt
        : input.invoice.partialPaymentStartedAt,
      partialPaymentExpiresAt: effectiveCredit > BigInt(0) && effectiveCredit < obligation
        ? partialPaymentExpiresAt
        : input.invoice.partialPaymentExpiresAt,
      observedAt: latestMovementAt,
      observedTransactionHash: status === "PAID"
        ? paidMovement?.transactionHash ?? input.invoice.observedTransactionHash
        : input.invoice.observedTransactionHash,
      observedPayments: observedPayments as Prisma.InputJsonValue,
      settlementReason: input.settlementReason ?? (input.forceRecovery
        ? "LATE_MOVEMENT_RECOVERY"
        : status === "PAID"
          ? "FIAT_LEDGER_PAID"
          : "FIAT_LEDGER_PARTIAL"),
      version: { increment: 1 },
    },
  });
  await tx.tonhubDepositAddress.updateMany({
    where: { id: input.invoice.depositAddress.id },
    data: {
      status: status === "PAID" ? "PAID" : status === "PARTIAL" ? "PARTIAL" : status,
      ...(status === "PAID" ? { paidAt: input.order.paidAt ?? latestMovementAt } : {}),
    },
  });
  return updated;
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
  } else {
    await tx.tonhubPaymentMovement.updateMany({
      where: { id: movement.id, status: "RATE_PENDING" },
      data: { validationCode },
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
        await lockObservedMovementOrder(tx, draft);
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
        if (movement.status === "REJECTED") {
          throw new MovementAllocationConflictError(
            `Rejected movement ${movement.id} cannot be replayed as observed.`,
          );
        }
        await lockObservedMovementSelection(tx, movement);
        await enqueueOfficialUsdtSweep(tx, movement);
        return movement;
      });
    },

    recordRejected: async (input: {
      movement: PaymentMovementDraft;
      validationCode: string;
      reason: string;
      title: string;
      details: Record<string, unknown>;
    }) => {
      const draft = validateMovementDraft(input.movement);
      const validationCode = requiredText(input.validationCode, "Movement validationCode");
      const reason = requiredText(input.reason, "Recovery reason");
      const title = requiredText(input.title, "Recovery title");
      const details = canonicalJsonValue(input.details) as Record<string, unknown>;
      return db.$transaction(async (tx) => {
        await tx.tonhubPaymentMovement.createMany({
          data: [{
            ...draft,
            status: "REJECTED",
            validationCode,
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
          throw new Error(`Rejected movement was not persisted: ${draft.fingerprint}.`);
        }
        const movement = normalizeMovement(stored);
        if (movementFactsIdentity(movement) !== movementFactsIdentity(draft)) {
          throw new MovementFingerprintConflictError(draft.fingerprint);
        }
        if (movement.status !== "REJECTED" || movement.validationCode !== validationCode) {
          throw new MovementAllocationConflictError(
            `Movement ${movement.id} already has a different validation lifecycle.`,
          );
        }
        const deposit = movement.depositAddressId
          ? await tx.tonhubDepositAddress.findUnique({
              where: { id: movement.depositAddressId },
              include: { invoice: { select: { id: true, orderId: true } } },
            })
          : null;
        const recoveryId = `rejected:${movement.id}`;
        await tx.tonhubRecoveryCase.createMany({
          data: {
            id: recoveryId,
            movementId: movement.id,
            orderId: deposit?.invoice?.orderId ?? null,
            invoiceId: deposit?.invoice?.id ?? null,
            reason,
            title,
            details: details as Prisma.InputJsonValue,
          },
          skipDuplicates: true,
        });
        const recovery = await tx.tonhubRecoveryCase.findUnique({
          where: { id: recoveryId },
        });
        if (
          !recovery ||
          recovery.movementId !== movement.id ||
          recovery.orderId !== (deposit?.invoice?.orderId ?? null) ||
          recovery.invoiceId !== (deposit?.invoice?.id ?? null) ||
          recovery.reason !== reason ||
          recovery.title !== title ||
          jsonIdentity(recovery.details) !== jsonIdentity(details)
        ) {
          throw new MovementAllocationConflictError(
            `Movement ${movement.id} recovery evidence conflicts with its immutable rejection.`,
          );
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
      partialPaymentTtlHours?: number;
    }) => db.$transaction(async (tx) => {
      const orderId = requiredText(input.orderId, "Allocation orderId");
      const movementId = requiredText(input.movementId, "Allocation movementId");
      const invoiceId = requiredText(input.invoiceId, "Allocation invoiceId");
      const validationCode = requiredText(input.validationCode, "Movement validationCode");
      const allocatedBy = requiredText(input.allocatedBy ?? "system", "Allocation allocatedBy");
      const maxRateAgeMs = input.maxRateAgeMs ?? rateSnapshotMaxAgeMs();
      const partialPaymentTtlHours = input.partialPaymentTtlHours ?? 24;
      if (!Number.isInteger(maxRateAgeMs) || maxRateAgeMs < 0) {
        throw new Error("Movement maxRateAgeMs must be a non-negative integer.");
      }
      if (!Number.isInteger(partialPaymentTtlHours) || partialPaymentTtlHours < 1 || partialPaymentTtlHours > 24 * 30) {
        throw new Error("Movement partialPaymentTtlHours must be an integer between 1 and 720.");
      }
      const order = await lockOrder(tx, orderId);
      const baseline = await assertOrderAccountingBaseline(tx, order);
      let movement = await lockMovement(tx, movementId);
      if (movement.direction !== "INCOMING") {
        throw new MovementAllocationConflictError("Only incoming movements can credit an order.");
      }
      if (movement.status === "REJECTED") {
        throw new MovementAllocationConflictError(`Movement ${movement.id} is ${movement.status}.`);
      }
      if (movement.validationCode && movement.validationCode !== validationCode) {
        throw new MovementAllocationConflictError("Movement validation evidence cannot be replaced.");
      }
      let invoice = await tx.tonhubPaymentInvoice.findUnique({
        where: { id: invoiceId },
        include: { depositAddress: true },
      });
      if (!invoice || invoice.orderId !== orderId) {
        throw new MovementAllocationConflictError("Allocation invoice does not belong to the order.");
      }
      if (!movement.depositAddressId || invoice.depositAddress?.id !== movement.depositAddressId) {
        throw new MovementAllocationConflictError("Movement deposit address does not belong to the invoice.");
      }
      const unresolvedMovements = (await tx.tonhubPaymentMovement.findMany({
        where: {
          depositAddress: {
            invoice: { orderId },
          },
          direction: "INCOMING",
          status: { in: ["OBSERVED", "VALIDATED", "RATE_PENDING", "RECOVERY"] },
        },
      }))
        .map((value: unknown) => requireMovement(value, "unknown"))
        .sort(compareMovementChronology);
      const selectionMovement = [
        movement,
        baseline.activeCredits.find(({ allocation }) => allocation.invoiceId === invoiceId)?.movement,
        unresolvedMovements.find(
          (candidate: PaymentMovementRecord) => candidate.depositAddressId === movement.depositAddressId,
        ),
      ]
        .filter((value): value is PaymentMovementRecord => Boolean(value))
        .sort(compareMovementChronology)[0];
      invoice = await lockInvoicePaymentSelection(
        tx,
        invoice,
        selectionMovement?.blockchainAt ?? movement.blockchainAt,
      );
      if (movement.status === "HELD_UNDER_MINIMUM") {
        throw new MovementAllocationConflictError(`Movement ${movement.id} is ${movement.status}.`);
      }
      if (movement.status === "CREDITED") {
        const allocation = await findCreditAllocation(tx, movement.id);
        if (!allocation) {
          throw new MovementAllocationConflictError("Credited movement has no CREDIT allocation.");
        }
        assertAllocationTarget(allocation, { orderId, invoiceId });
        return { outcome: "credited" as const, movement, allocation, order };
      }
      if (unresolvedMovements[0]?.id !== movement.id) {
        return {
          outcome: "blocked-earlier-movement" as const,
          movement,
          allocation: null,
          order,
        };
      }

      const latestCreditedMovement = baseline.activeCredits[baseline.activeCredits.length - 1]?.movement ?? null;
      const outOfOrder = Boolean(
        latestCreditedMovement && compareMovementChronology(movement, latestCreditedMovement) < 0
      );
      const postPaid = order.status === "PAID" && (
        baseline.paidMovement
          ? compareMovementChronology(movement, baseline.paidMovement) > 0
          : true
      );
      const deadline = validDate(invoice.partialPaymentExpiresAt)
        ? invoice.partialPaymentExpiresAt
        : validDate(invoice.firstMovementAt)
          ? partialWindowEnd(invoice.firstMovementAt, partialPaymentTtlHours)
          : validDate(invoice.expiresAt)
            ? invoice.expiresAt
            : null;
      const late = Boolean(deadline && movement.blockchainAt.getTime() > deadline.getTime());
      const conflictingAttempt = !invoiceStatusIsActive(invoice.status)
        ? await tx.tonhubPaymentInvoice.findFirst({
            where: {
              orderId,
              id: { not: invoiceId },
              status: { in: ["PENDING", "PARTIAL"] },
            },
          })
        : null;
      const hardTerminal = ["CANCELLED", "FAILED", "RECOVERY"].includes(order.status);
      const forceRecovery = late || postPaid || outOfOrder || hardTerminal || Boolean(conflictingAttempt);
      const settlementReason = outOfOrder
        ? "OUT_OF_ORDER_MOVEMENT_RECOVERY"
        : postPaid
          ? "POST_PAID_MOVEMENT_RECOVERY"
          : late
            ? "LATE_MOVEMENT_RECOVERY"
            : forceRecovery
              ? "TERMINAL_OR_CONFLICTING_ATTEMPT_RECOVERY"
              : undefined;
      const lockedRate = movement.asset === "GRAM"
        ? await findLockedGramRate(tx, orderId, order.fiatCurrency)
        : null;
      if (lockedRate && lockedRate.observedAt.getTime() > movement.blockchainAt.getTime()) {
        await tx.tonhubPaymentMovement.updateMany({
          where: { id: movement.id, status: movement.status },
          data: { status: "RECOVERY", validationCode },
        });
        movement = requireMovement(
          await tx.tonhubPaymentMovement.findUnique({ where: { id: movement.id } }),
          movement.id,
        );
        await createRecoveryCase(tx, {
          movementId,
          orderId,
          invoiceId,
          reason: "OUT_OF_ORDER_RATE_LOCK",
          title: "GRAM movement predates the locked rate",
          details: {
            movementBlockchainAt: movement.blockchainAt.toISOString(),
            lockedRateSnapshotId: lockedRate.id,
            lockedRateObservedAt: lockedRate.observedAt.toISOString(),
          },
        });
        return { outcome: "recovery" as const, movement, allocation: null, order };
      }
      const rateValue = lockedRate ?? await tx.tonhubRateSnapshot.findFirst({
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
      const rate = lockedRate ?? normalizeRateSnapshotRecord(rateValue);
      if (!lockedRate && movement.blockchainAt.getTime() - rate.observedAt.getTime() > maxRateAgeMs) {
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
          data: {
            status: "HELD_UNDER_MINIMUM",
            validationCode,
            rateSnapshotId: rate.id,
            fiatCreditMicros,
          },
        });
        movement = requireMovement(
          await tx.tonhubPaymentMovement.findUnique({ where: { id: movement.id } }),
          movement.id,
        );
        await createRecoveryCase(tx, {
          movementId,
          orderId,
          invoiceId,
          reason: "PAYMENT_BELOW_ACCOUNTING_PRECISION",
          title: "Incoming payment rounds below one fiat micro",
          details: {
            asset: movement.asset,
            amountAtomic: movement.amountAtomic,
            fiatCreditMicros,
          },
        });
        return { outcome: "held-under-minimum" as const, movement, allocation: null, order };
      }
      const obligation = BigInt(order.fiatAmountMicros);
      const activationThreshold = invoice.activationThresholdFiatMicros === null ||
        invoice.activationThresholdFiatMicros === undefined
        ? BigInt(0)
        : BigInt(nonNegativeInteger(
            invoice.activationThresholdFiatMicros,
            "Invoice activationThresholdFiatMicros",
          ));
      if (
        !forceRecovery &&
        baseline.netCredit === BigInt(0) &&
        BigInt(fiatCreditMicros) < obligation &&
        BigInt(fiatCreditMicros) < activationThreshold
      ) {
        await tx.tonhubPaymentMovement.updateMany({
          where: { id: movement.id, status: movement.status },
          data: {
            status: "HELD_UNDER_MINIMUM",
            validationCode,
            rateSnapshotId: rate.id,
            fiatCreditMicros,
          },
        });
        movement = requireMovement(
          await tx.tonhubPaymentMovement.findUnique({ where: { id: movement.id } }),
          movement.id,
        );
        await createRecoveryCase(tx, {
          movementId,
          orderId,
          invoiceId,
          reason: "INITIAL_PAYMENT_UNDER_MINIMUM",
          title: "Initial partial payment is under the activation threshold",
          details: {
            asset: movement.asset,
            amountAtomic: movement.amountAtomic,
            fiatCreditMicros,
            activationThresholdFiatMicros: activationThreshold.toString(),
          },
        });
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

      if (movement.asset === "USDT") {
        await reverseActivePaymentMethodDiscounts(tx, {
          orderId,
          cause: "USDT_CREDIT_REMOVES_GRAM_ONLY_DISCOUNT",
          evidence: {
            movementId: movement.id,
            movementBlockchainAt: movement.blockchainAt.toISOString(),
            asset: movement.asset,
          },
        });
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
      await applyEligibleGramOnlyDiscount(tx, {
        order,
        invoice,
        forceRecovery,
        movement,
        hasOtherUnresolvedMovements: unresolvedMovements.some(
          (candidate: PaymentMovementRecord) => candidate.id !== movement.id,
        ),
      });
      const updatedOrder = await syncOrderAccounting(tx, {
        order,
        paidAt: movement.blockchainAt,
        forceRecovery,
        allowExpiredRevival: order.status === "EXPIRED" && !late && !conflictingAttempt,
        expiresAt: !forceRecovery && baseline.netCredit === BigInt(0) &&
          baseline.netCredit + BigInt(fiatCreditMicros) < BigInt(order.fiatAmountMicros)
          ? partialWindowEnd(movement.blockchainAt, partialPaymentTtlHours)
          : order.expiresAt,
      });
      const updatedInvoice = await syncInvoiceAccounting(tx, {
        invoice,
        order: updatedOrder,
        movement,
        forceRecovery,
        partialPaymentTtlHours,
        settlementReason,
      });
      if (forceRecovery) {
        const reason = outOfOrder
          ? "OUT_OF_ORDER_MOVEMENT"
          : postPaid
            ? "POST_PAID_MOVEMENT"
            : late
              ? "LATE_MOVEMENT"
              : "TERMINAL_OR_CONFLICTING_ATTEMPT_MOVEMENT";
        await createRecoveryCase(tx, {
          movementId,
          orderId,
          invoiceId,
          reason,
          title: outOfOrder
            ? "Payment was discovered after a later blockchain movement was credited"
            : postPaid
              ? "Payment arrived after the order was fully paid"
              : late
                ? "Payment arrived after the active payment window"
                : "Payment belongs to a terminal or superseded attempt",
          details: {
            asset: movement.asset,
            amountAtomic: movement.amountAtomic,
            fiatCreditMicros,
            blockchainAt: movement.blockchainAt.toISOString(),
            deadline: deadline?.toISOString() ?? null,
            latestCreditedMovementId: latestCreditedMovement?.id ?? null,
            paidMovementId: baseline.paidMovement?.id ?? null,
          },
        });
      }
      return {
        outcome: "credited" as const,
        movement,
        allocation,
        order: updatedOrder,
        invoice: updatedInvoice,
      };
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
      await reverseActivePaymentMethodDiscounts(tx, {
        orderId: original.orderId,
        cause: "MOVEMENT_ALLOCATION_REVERSAL_REMOVES_DISCOUNT",
        evidence: {
          allocationId: original.id,
          movementId: original.movementId,
          requestedBy: allocatedBy,
          note,
        },
      });
      const existing = await tx.tonhubMovementAllocation.findFirst({
        where: { reversesAllocationId: allocationId },
      });
      let reversal: MovementAllocationRecord;
      let createdReversal = false;
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
        createdReversal = true;
      }
      const updatedOrder = await syncOrderAccounting(tx, { order, forceRecovery: true });
      let updatedInvoice = null;
      if (original.invoiceId && createdReversal) {
        const invoice = await tx.tonhubPaymentInvoice.findUnique({
          where: { id: original.invoiceId },
          include: { depositAddress: true },
        });
        const movement = await lockMovement(tx, original.movementId);
        if (!invoice || !invoice.depositAddress) {
          throw new MovementAllocationConflictError("Reversed allocation invoice ownership is missing.");
        }
        updatedInvoice = await syncInvoiceAccounting(tx, {
          invoice,
          order: updatedOrder,
          movement,
          forceRecovery: true,
          partialPaymentTtlHours: 24,
          recoveryInvoiceStatus: "FAILED",
          settlementReason: "ALLOCATION_REVERSED_RECOVERY",
        });
        await createRecoveryCase(tx, {
          movementId: movement.id,
          orderId: original.orderId,
          invoiceId: original.invoiceId,
          reason: "ALLOCATION_REVERSED",
          title: "A credited movement allocation was reversed",
          details: {
            allocationId: original.id,
            reversalId: reversal.id,
            allocatedBy,
            note,
          },
        });
      }
      return { original, reversal, order: updatedOrder, invoice: updatedInvoice };
    }),
  };
}

export const movementLedger = createMovementLedger(prisma as unknown as PrismaLike);
