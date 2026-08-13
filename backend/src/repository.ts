import { prisma } from "./db";
import type { TonUniqueDepositAddress } from "./ton/deposit-addresses";
import type {
  TonhubObservedPayment,
  TonhubPaymentInvoiceRecord,
  TonhubPaymentOrderRecord,
  TonhubRateQuote,
} from "./types";
import { gramAsset, type TonNetwork } from "./ton/direct-payments";

type PrismaLike = {
  $transaction: <T>(handler: (tx: PrismaLike) => Promise<T>) => Promise<T>;
  tonhubPaymentOrder: any;
  tonhubPaymentInvoice: any;
  tonhubDepositAddress: any;
  tonhubPaymentTransaction: any;
};

const activeAttemptStatuses = ["PENDING", "PARTIAL"] as const;
const reusableAttemptStatuses = ["PENDING", "PARTIAL", "PAID"] as const;

export class TonhubOrderTermsMismatchError extends Error {
  readonly code = "TON_ORDER_TERMS_MISMATCH";

  constructor() {
    super("The externalId already belongs to an order with a different fiat amount or currency.");
    this.name = "TonhubOrderTermsMismatchError";
  }
}

export class TonhubOrderNotRetryableError extends Error {
  readonly code = "TON_ORDER_NOT_RETRYABLE";

  constructor(status: string) {
    super(`The order cannot create a new payment attempt while it is ${status}.`);
    this.name = "TonhubOrderNotRetryableError";
  }
}

function toInputJson(value: unknown) {
  return value as any;
}

function fiatCentsToMicros(amountCents: number) {
  return (BigInt(amountCents) * BigInt(10_000)).toString();
}

function minBigInt(left: bigint, right: bigint) {
  return left <= right ? left : right;
}

function calculateFiatCreditMicros(input: {
  fiatAmountMicros: string;
  amountAtomic: string;
  paidAmountAtomic: string;
}) {
  const fiatAmountMicros = BigInt(input.fiatAmountMicros);
  const amountAtomic = BigInt(input.amountAtomic);
  const paidAmountAtomic = BigInt(input.paidAmountAtomic);

  if (fiatAmountMicros <= BigInt(0) || amountAtomic <= BigInt(0) || paidAmountAtomic <= BigInt(0)) {
    return "0";
  }

  return minBigInt(
    fiatAmountMicros,
    (fiatAmountMicros * paidAmountAtomic) / amountAtomic,
  ).toString();
}

function normalizeOrder(value: unknown): TonhubPaymentOrderRecord | null {
  return value ? value as TonhubPaymentOrderRecord : null;
}

function normalizeInvoice(value: unknown): TonhubPaymentInvoiceRecord {
  const invoice = value as TonhubPaymentInvoiceRecord & { order?: unknown };
  const order = normalizeOrder(invoice.order);
  const fiatAmountMicros = invoice.fiatAmountMicros ?? fiatCentsToMicros(invoice.fiatAmountCents);
  const paidAmountAtomic = invoice.paidAmountAtomic ?? invoice.paidNano ?? "0";
  const amountAtomic = invoice.amountAtomic ?? invoice.amountNano;
  const creditedFiatMicros = invoice.creditedFiatMicros ?? calculateFiatCreditMicros({
    fiatAmountMicros,
    amountAtomic,
    paidAmountAtomic,
  });

  return {
    ...invoice,
    externalId: order ? order.externalId : invoice.externalId,
    orderId: invoice.orderId ?? null,
    order,
    checkoutAsset: invoice.checkoutAsset ?? (invoice.asset === "TON" ? gramAsset.symbol : invoice.asset),
    assetKind: invoice.assetKind ?? "NATIVE",
    assetDecimals: invoice.assetDecimals ?? 9,
    fiatAmountMicros,
    creditedFiatMicros,
    remainingFiatMicros: invoice.remainingFiatMicros ?? (
      BigInt(fiatAmountMicros) > BigInt(creditedFiatMicros)
        ? (BigInt(fiatAmountMicros) - BigInt(creditedFiatMicros)).toString()
        : "0"
    ),
    amountAtomic,
    paidAmountAtomic,
  };
}

function assertOrderTerms(
  order: TonhubPaymentOrderRecord,
  input: { amountCents?: number; currency?: string },
) {
  if (
    (input.amountCents !== undefined && order.fiatAmountMicros !== fiatCentsToMicros(input.amountCents)) ||
    (input.currency !== undefined && order.fiatCurrency !== input.currency)
  ) {
    throw new TonhubOrderTermsMismatchError();
  }
}

function isConcurrentOrderAttemptConflict(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error) || error.code !== "P2002") {
    return false;
  }

  const details = JSON.stringify("meta" in error ? error.meta : error);
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  return details.includes("orderId") ||
    details.includes("externalId") ||
    details.includes("TonhubPaymentInvoice_one_active_attempt_per_order_key") ||
    message.includes("TonhubPaymentInvoice_one_active_attempt_per_order_key") ||
    message.includes("TonhubPaymentOrder_externalId_key");
}

async function summarizeOrderAttemptCredits(
  db: PrismaLike,
  orderId: string,
  fiatAmountMicros: string,
) {
  const attempts = await db.tonhubPaymentInvoice.findMany({
    where: { orderId },
    include: { order: true },
  });
  const credits = attempts.map((value: unknown) => BigInt(normalizeInvoice(value).creditedFiatMicros ?? "0"));
  return {
    totalCreditMicros: minBigInt(
      BigInt(fiatAmountMicros),
      credits.reduce((total: bigint, credit: bigint) => total + credit, BigInt(0)),
    ).toString(),
    fundedAttemptCount: credits.filter((credit: bigint) => credit > BigInt(0)).length,
  };
}

async function syncOrderFromAttempts(
  db: PrismaLike,
  input: {
    orderId: string;
    fiatAmountMicros: string;
    nextStatus: "PENDING" | "PARTIAL" | "PAID" | "EXPIRED" | "CANCELLED" | "FAILED";
    expiresAt?: Date | null;
    paidAt?: Date | null;
    forceRecovery?: boolean;
  },
) {
  const order = normalizeOrder(await db.tonhubPaymentOrder.findUnique({ where: { id: input.orderId } }));
  if (!order) {
    return;
  }
  const summary = await summarizeOrderAttemptCredits(db, input.orderId, input.fiatAmountMicros);
  const orderWasTerminal = ["RECOVERY", "CANCELLED", "FAILED"].includes(order.status);
  const status = input.forceRecovery || summary.fundedAttemptCount > 1 ||
    (input.nextStatus === "EXPIRED" && BigInt(summary.totalCreditMicros) > BigInt(0)) ||
    (orderWasTerminal && input.nextStatus !== order.status)
    ? "RECOVERY"
    : input.nextStatus;
  await db.tonhubPaymentOrder.updateMany({
    where: { id: input.orderId },
    data: {
      status,
      creditedFiatMicros: summary.totalCreditMicros,
      expiresAt: input.expiresAt === undefined ? order.expiresAt : input.expiresAt,
      paidAt: status === "PAID" ? input.paidAt ?? order.paidAt : order.paidAt,
    },
  });
}

async function findInvoiceWithOrder(db: PrismaLike, id: string) {
  const invoice = await db.tonhubPaymentInvoice.findUnique({
    where: { id },
    include: { order: true },
  });
  return invoice ? normalizeInvoice(invoice) : null;
}

async function ensureInvoiceOrder(
  db: PrismaLike,
  invoice: TonhubPaymentInvoiceRecord,
  options: { preferInvoice?: boolean } = {},
) {
  if (invoice.orderId) {
    return invoice;
  }

  const fiatAmountMicros = invoice.fiatAmountMicros ?? fiatCentsToMicros(invoice.fiatAmountCents);
  const amountAtomic = invoice.amountAtomic ?? invoice.amountNano;
  const paidAmountAtomic = invoice.paidAmountAtomic ?? invoice.paidNano ?? "0";
  const creditedFiatMicros = invoice.status === "PAID"
    ? fiatAmountMicros
    : calculateFiatCreditMicros({ fiatAmountMicros, amountAtomic, paidAmountAtomic });
  const hasCredit = BigInt(creditedFiatMicros) > BigInt(0);
  const orderData = {
    id: `legacy-order:${invoice.id}`,
    externalId: invoice.externalId,
    fiatAmountMicros,
    fiatCurrency: invoice.fiatCurrency,
    creditedFiatMicros: "0",
    overpaymentFiatMicros: "0",
    status: "PENDING",
    paidAt: null,
    expiresAt: invoice.partialPaymentExpiresAt ?? invoice.expiresAt,
    metadata: toInputJson(invoice.metadata ?? null),
    createdAt: invoice.createdAt,
    updatedAt: invoice.updatedAt,
  };
  const orderWhere = invoice.externalId
    ? { externalId: invoice.externalId }
    : { id: orderData.id };
  const existingOrder = await db.tonhubPaymentOrder.findUnique({ where: orderWhere });
  const order = normalizeOrder(existingOrder ?? await db.tonhubPaymentOrder.upsert({
    where: orderWhere,
    create: orderData,
    update: {},
  }))!;
  assertOrderTerms(order, {
    amountCents: invoice.fiatAmountCents,
    currency: invoice.fiatCurrency,
  });

  const conflictingAttemptValue = await db.tonhubPaymentInvoice.findFirst({
    where: {
      orderId: order.id,
      status: { in: [...activeAttemptStatuses] },
    },
    orderBy: { createdAt: "desc" },
    include: { order: true },
  });
  const conflictingAttempt = conflictingAttemptValue
    ? normalizeInvoice(conflictingAttemptValue)
    : null;
  const preferInvoice = Boolean(options.preferInvoice || hasCredit || invoice.status === "PAID");
  let attachedStatus = invoice.status;
  const orderIsTerminal = ["PAID", "RECOVERY", "CANCELLED", "FAILED"].includes(order.status);

  if (conflictingAttempt && conflictingAttempt.id !== invoice.id) {
    // A terminal attachment cannot violate the one-active-attempt index. Only
    // after winning that attachment may this transaction supersede the old
    // active attempt and restore the incoming attempt's observed status.
    attachedStatus = "CANCELLED";
  } else if (
    orderIsTerminal &&
    activeAttemptStatuses.includes(invoice.status as typeof activeAttemptStatuses[number]) &&
    !preferInvoice
  ) {
    attachedStatus = "CANCELLED";
  }

  const attached = await db.tonhubPaymentInvoice.updateMany({
    where: { id: invoice.id, orderId: null },
    data: {
      orderId: order.id,
      status: attachedStatus,
      checkoutAsset: invoice.asset === "TON" ? gramAsset.symbol : invoice.asset,
      assetKind: invoice.assetKind ?? "NATIVE",
      assetDecimals: invoice.assetDecimals ?? 9,
      fiatAmountMicros,
      creditedFiatMicros,
      remainingFiatMicros: (
        BigInt(fiatAmountMicros) - BigInt(creditedFiatMicros)
      ).toString(),
      amountAtomic,
      paidAmountAtomic,
      firstMovementAt: invoice.firstMovementAt ?? invoice.partialPaymentStartedAt ?? (
        BigInt(paidAmountAtomic) > BigInt(0) ? invoice.observedAt : null
      ),
      settlementReason: attachedStatus === "CANCELLED"
        ? "ROLLOUT_ATTEMPT_SUPERSEDED"
        : invoice.status === "PAID"
          ? "LEGACY_PAID_LAZY_ATTACH"
          : invoice.status === "EXPIRED"
            ? "LEGACY_EXPIRED_LAZY_ATTACH"
            : undefined,
      scanPriorityAt: activeAttemptStatuses.includes(attachedStatus as typeof activeAttemptStatuses[number])
        ? invoice.createdAt
        : null,
    },
  });

  let currentInvoice = (await findInvoiceWithOrder(db, invoice.id)) ?? invoice;
  if (!attached.count && !preferInvoice) {
    return currentInvoice;
  }

  if (preferInvoice && currentInvoice.orderId === order.id) {
    const liveConflictValue = await db.tonhubPaymentInvoice.findFirst({
      where: {
        orderId: order.id,
        status: { in: [...activeAttemptStatuses] },
      },
      orderBy: { createdAt: "desc" },
      include: { order: true },
    });
    const liveConflict = liveConflictValue ? normalizeInvoice(liveConflictValue) : null;
    if (liveConflict && liveConflict.id !== invoice.id) {
      const liveConflictCreditMicros = liveConflict.creditedFiatMicros ?? "0";
      const supersededStatus = BigInt(liveConflictCreditMicros) > BigInt(0) ? "FAILED" : "CANCELLED";
      const superseded = await db.tonhubPaymentInvoice.updateMany({
        where: {
          id: liveConflict.id,
          status: { in: [...activeAttemptStatuses] },
        },
        data: {
          status: supersededStatus,
          settlementReason: "ROLLOUT_ATTEMPT_SUPERSEDED",
          scanPriorityAt: null,
          version: { increment: 1 },
        },
      });
      if (superseded.count) {
        await db.tonhubDepositAddress.updateMany({
          where: { invoiceId: liveConflict.id },
          data: { status: supersededStatus },
        });
      }
    }

    if (invoice.status !== "CANCELLED") {
      await db.tonhubPaymentInvoice.updateMany({
        where: {
          id: invoice.id,
          orderId: order.id,
          status: "CANCELLED",
          settlementReason: "ROLLOUT_ATTEMPT_SUPERSEDED",
        },
        data: {
          status: invoice.status,
          settlementReason: invoice.status === "PAID"
            ? "LEGACY_PAID_LAZY_ATTACH"
            : invoice.status === "EXPIRED"
              ? "LEGACY_EXPIRED_LAZY_ATTACH"
              : null,
          scanPriorityAt: activeAttemptStatuses.includes(invoice.status as typeof activeAttemptStatuses[number])
            ? invoice.createdAt
            : null,
          version: { increment: 1 },
        },
      });
      currentInvoice = (await findInvoiceWithOrder(db, invoice.id)) ?? currentInvoice;
    }
  }

  const depositStatus = activeAttemptStatuses.includes(currentInvoice.status as typeof activeAttemptStatuses[number])
    ? "ACTIVE"
    : currentInvoice.status;
  if (depositStatus !== "ACTIVE" || attachedStatus !== currentInvoice.status) {
    await db.tonhubDepositAddress.updateMany({
      where: { invoiceId: invoice.id },
      data: { status: depositStatus },
    });
  }

  const latestOrder = normalizeOrder(await db.tonhubPaymentOrder.findUnique({ where: { id: order.id } })) ?? order;
  const creditSummary = await summarizeOrderAttemptCredits(db, order.id, fiatAmountMicros);
  const targetOrderStatus = creditSummary.fundedAttemptCount > 1 ||
    (invoice.status === "EXPIRED" && hasCredit) ||
    (Boolean(options.preferInvoice) && orderIsTerminal)
    ? "RECOVERY"
    : preferInvoice && invoice.status === "PAID"
      ? "PAID"
    : preferInvoice && invoice.status === "PARTIAL"
        ? "PARTIAL"
        : !conflictingAttempt && !orderIsTerminal && ["EXPIRED", "CANCELLED", "FAILED"].includes(currentInvoice.status)
          ? currentInvoice.status
          : latestOrder.status;
  await db.tonhubPaymentOrder.updateMany({
    where: { id: order.id },
    data: {
      status: targetOrderStatus,
      creditedFiatMicros: creditSummary.totalCreditMicros,
      paidAt: targetOrderStatus === "PAID" ? invoice.observedAt : latestOrder.paidAt,
      expiresAt: invoice.partialPaymentExpiresAt ?? invoice.expiresAt ?? latestOrder.expiresAt,
    },
  });

  return (await findInvoiceWithOrder(db, invoice.id)) ?? invoice;
}

export type TonhubPaymentRepository = {
  findInvoiceById: (id: string) => Promise<TonhubPaymentInvoiceRecord | null>;
  findReusableInvoice: (input: {
    externalId?: string | null;
    network: TonNetwork;
    amountCents?: number;
    currency?: string;
  }) => Promise<TonhubPaymentInvoiceRecord | null>;
  createPendingInvoice: (input: {
    externalId?: string | null;
    amountCents: number;
    currency: string;
    network: TonNetwork;
    depositAddress: TonUniqueDepositAddress;
    reference: string;
    quote: TonhubRateQuote;
    metadata?: unknown;
    createdAt: Date;
    expiresAt: Date;
    priceLockedAt: Date;
    priceLockedUntil: Date;
  }) => Promise<TonhubPaymentInvoiceRecord>;
  markInvoiceExpired: (input: {
    invoiceId: string;
    expiredAt: Date;
  }) => Promise<TonhubPaymentInvoiceRecord | null>;
  markInvoicePartial: (input: {
    invoiceId: string;
    paidNano: string;
    partialPaymentStartedAt: Date;
    partialPaymentExpiresAt: Date;
    observedPayments: TonhubObservedPayment[];
    observedAt: Date;
  }) => Promise<TonhubPaymentInvoiceRecord | null>;
  markInvoicePaid: (input: {
    invoiceId: string;
    transactionId: string;
    paidNano: string;
    observedPayments: TonhubObservedPayment[];
    paidAt: Date;
  }) => Promise<TonhubPaymentInvoiceRecord | null>;
};

export function createPrismaTonhubPaymentRepository(db: PrismaLike): TonhubPaymentRepository {
  return {
    findInvoiceById: async (id) => findInvoiceWithOrder(db, id),
    findReusableInvoice: async ({ externalId, amountCents, currency }) => {
      if (!externalId) {
        return null;
      }

      const legacyInvoice = await db.tonhubPaymentInvoice.findFirst({
        where: {
          externalId,
          orderId: null,
        },
        orderBy: { createdAt: "desc" },
        include: { order: true },
      });
      if (legacyInvoice) {
        const normalized = normalizeInvoice(legacyInvoice);
        if (
          (amountCents !== undefined && normalized.fiatAmountCents !== amountCents) ||
          (currency !== undefined && normalized.fiatCurrency !== currency)
        ) {
          throw new TonhubOrderTermsMismatchError();
        }
        await db.$transaction((tx) => ensureInvoiceOrder(tx, normalized));
      }

      const orderValue = await db.tonhubPaymentOrder.findUnique({ where: { externalId } });
      if (orderValue) {
        const order = normalizeOrder(orderValue)!;
        assertOrderTerms(order, { amountCents, currency });
        if (["RECOVERY", "CANCELLED", "FAILED"].includes(order.status)) {
          throw new TonhubOrderNotRetryableError(order.status);
        }
        const invoice = await db.tonhubPaymentInvoice.findFirst({
          where: {
            orderId: order.id,
            status: { in: order.status === "PAID" ? ["PAID"] : [...reusableAttemptStatuses] },
          },
          orderBy: { createdAt: "desc" },
          include: { order: true },
        });
        if (invoice) {
          return normalizeInvoice(invoice);
        }
        if (order.status === "PAID") {
          throw new TonhubOrderNotRetryableError(order.status);
        }
        return null;
      }

      return null;
    },
    createPendingInvoice: async (input) => {
      try {
        return await db.$transaction(async (tx) => {
          const fiatAmountMicros = fiatCentsToMicros(input.amountCents);
          const orderData = {
            externalId: input.externalId || null,
            fiatAmountMicros,
            fiatCurrency: input.currency,
            creditedFiatMicros: "0",
            overpaymentFiatMicros: "0",
            status: "PENDING",
            expiresAt: input.expiresAt,
            metadata: toInputJson(input.metadata ?? null),
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
          };
          const order = normalizeOrder(input.externalId
            ? await tx.tonhubPaymentOrder.upsert({
                where: { externalId: input.externalId },
                create: orderData,
                update: {},
              })
            : await tx.tonhubPaymentOrder.create({ data: orderData }))!;

          assertOrderTerms(order, input);

          const existingAttempt = await tx.tonhubPaymentInvoice.findFirst({
            where: {
              orderId: order.id,
              status: { in: [...reusableAttemptStatuses] },
            },
            orderBy: { createdAt: "desc" },
            include: { order: true },
          });
          if (existingAttempt) {
            return normalizeInvoice(existingAttempt);
          }

          if (["RECOVERY", "CANCELLED", "FAILED", "PAID"].includes(order.status)) {
            throw new TonhubOrderNotRetryableError(order.status);
          }

          await tx.tonhubPaymentOrder.updateMany({
            where: {
              id: order.id,
              status: { in: ["PENDING", "EXPIRED"] },
            },
            data: {
              status: "PENDING",
              creditedFiatMicros: "0",
              overpaymentFiatMicros: "0",
              paidAt: null,
              expiresAt: input.expiresAt,
              cancelledAt: null,
            },
          });

          const invoice = await tx.tonhubPaymentInvoice.create({
            data: {
              externalId: null,
              orderId: order.id,
              network: input.network,
              asset: gramAsset.symbol,
              checkoutAsset: gramAsset.symbol,
              assetKind: "NATIVE",
              assetDecimals: 9,
              fiatAmountCents: input.amountCents,
              fiatAmountMicros,
              creditedFiatMicros: "0",
              remainingFiatMicros: fiatAmountMicros,
              fiatCurrency: input.currency,
              address: input.depositAddress.address,
              addressRaw: input.depositAddress.addressRaw,
              addressStrategy: input.depositAddress.addressStrategy,
              walletVersion: input.depositAddress.walletVersion,
              walletWorkchain: input.depositAddress.walletWorkchain,
              walletContext: input.depositAddress.walletContext,
              walletNetworkGlobalId: input.depositAddress.walletNetworkGlobalId,
              walletPublicKeyHash: input.depositAddress.walletPublicKeyHash,
              amountNano: input.quote.amountNano,
              paidNano: "0",
              amountAtomic: input.quote.amountNano,
              paidAmountAtomic: "0",
              reference: input.reference,
              status: "PENDING",
              providerName: "ton-direct",
              expiresAt: input.expiresAt,
              priceLockedAt: input.priceLockedAt,
              priceLockedUntil: input.priceLockedUntil,
              scanPriorityAt: input.createdAt,
              metadata: toInputJson(input.metadata ?? null),
              payload: toInputJson({
                quote: {
                  ...input.quote,
                  updatedAt: input.quote.updatedAt?.toISOString() ?? null,
                  fetchedAt: input.quote.fetchedAt.toISOString(),
                },
              }),
              createdAt: input.createdAt,
              updatedAt: input.createdAt,
            },
            include: { order: true },
          });

          await tx.tonhubDepositAddress.create({
            data: {
              network: input.network,
              address: input.depositAddress.address,
              addressRaw: input.depositAddress.addressRaw,
              walletVersion: input.depositAddress.walletVersion,
              walletWorkchain: input.depositAddress.walletWorkchain,
              walletContext: input.depositAddress.walletContext,
              walletNetworkGlobalId: input.depositAddress.walletNetworkGlobalId,
              walletPublicKeyHash: input.depositAddress.walletPublicKeyHash,
              invoiceKind: "tonhub-payment",
              invoiceId: invoice.id,
              status: "ACTIVE",
              assignedAt: input.createdAt,
            },
          });

          return normalizeInvoice(invoice);
        });
      } catch (error) {
        if (!input.externalId || !isConcurrentOrderAttemptConflict(error)) {
          throw error;
        }

        const order = await db.tonhubPaymentOrder.findUnique({
          where: { externalId: input.externalId },
        });
        if (!order) {
          throw error;
        }
        assertOrderTerms(normalizeOrder(order)!, input);
        const concurrentAttempt = await db.tonhubPaymentInvoice.findFirst({
          where: {
            orderId: order.id,
            status: { in: [...reusableAttemptStatuses] },
          },
          orderBy: { createdAt: "desc" },
          include: { order: true },
        });
        if (!concurrentAttempt) {
          throw error;
        }
        return normalizeInvoice(concurrentAttempt);
      }
    },
    markInvoiceExpired: async ({ invoiceId, expiredAt }) => db.$transaction(async (tx) => {
      const found = await findInvoiceWithOrder(tx, invoiceId);
      if (!found || !activeAttemptStatuses.includes(found.status as typeof activeAttemptStatuses[number])) {
        return null;
      }
      const current = await ensureInvoiceOrder(tx, found);
      const result = await tx.tonhubPaymentInvoice.updateMany({
        where: {
          id: invoiceId,
          status: { in: [...activeAttemptStatuses] },
          version: current.version ?? 0,
        },
        data: {
          status: "EXPIRED",
          observedAt: expiredAt,
          settlementReason: "ATTEMPT_EXPIRED",
          scanPriorityAt: null,
          version: { increment: 1 },
        },
      });
      if (!result.count) {
        return findInvoiceWithOrder(tx, invoiceId);
      }

      const invoice = await findInvoiceWithOrder(tx, invoiceId);
      if (!invoice) {
        return null;
      }
      if (invoice.orderId) {
        await syncOrderFromAttempts(tx, {
          orderId: invoice.orderId,
          fiatAmountMicros: invoice.fiatAmountMicros ?? fiatCentsToMicros(invoice.fiatAmountCents),
          nextStatus: "EXPIRED",
          expiresAt: expiredAt,
        });
      }
      await tx.tonhubDepositAddress.updateMany({
        where: { invoiceId },
        data: { status: "EXPIRED" },
      });
      return findInvoiceWithOrder(tx, invoiceId);
    }),
    markInvoicePartial: async (input) => db.$transaction(async (tx) => {
      const found = await findInvoiceWithOrder(tx, input.invoiceId);
      if (!found || !activeAttemptStatuses.includes(found.status as typeof activeAttemptStatuses[number])) {
        return null;
      }
      const current = await ensureInvoiceOrder(tx, found, { preferInvoice: true });

      const fiatAmountMicros = current.fiatAmountMicros ?? fiatCentsToMicros(current.fiatAmountCents);
      const creditedFiatMicros = calculateFiatCreditMicros({
        fiatAmountMicros,
        amountAtomic: current.amountAtomic ?? current.amountNano,
        paidAmountAtomic: input.paidNano,
      });
      const remainingFiatMicros = (
        BigInt(fiatAmountMicros) - BigInt(creditedFiatMicros)
      ).toString();
      const result = await tx.tonhubPaymentInvoice.updateMany({
        where: {
          id: input.invoiceId,
          status: { in: [...activeAttemptStatuses] },
          version: current.version ?? 0,
        },
        data: {
          status: "PARTIAL",
          paidNano: input.paidNano,
          paidAmountAtomic: input.paidNano,
          creditedFiatMicros,
          remainingFiatMicros,
          firstMovementAt: current.firstMovementAt ?? input.partialPaymentStartedAt,
          partialPaymentStartedAt: input.partialPaymentStartedAt,
          partialPaymentExpiresAt: input.partialPaymentExpiresAt,
          observedPayments: toInputJson(input.observedPayments),
          observedAt: input.observedAt,
          scanPriorityAt: input.observedAt,
          version: { increment: 1 },
        },
      });
      if (!result.count) {
        const latest = await findInvoiceWithOrder(tx, input.invoiceId);
        if (
          latest &&
          ["EXPIRED", "CANCELLED", "FAILED"].includes(latest.status) &&
          BigInt(input.paidNano) > BigInt(latest.paidAmountAtomic ?? latest.paidNano ?? "0")
        ) {
          const recovered = await tx.tonhubPaymentInvoice.updateMany({
            where: {
              id: input.invoiceId,
              status: latest.status,
              version: latest.version ?? 0,
            },
            data: {
              status: "FAILED",
              paidNano: input.paidNano,
              paidAmountAtomic: input.paidNano,
              creditedFiatMicros,
              remainingFiatMicros,
              firstMovementAt: latest.firstMovementAt ?? input.partialPaymentStartedAt,
              partialPaymentStartedAt: latest.partialPaymentStartedAt ?? input.partialPaymentStartedAt,
              partialPaymentExpiresAt: latest.partialPaymentExpiresAt ?? input.partialPaymentExpiresAt,
              observedPayments: toInputJson(input.observedPayments),
              observedAt: input.observedAt,
              settlementReason: "CONCURRENT_PAYMENT_RECOVERY",
              scanPriorityAt: null,
              version: { increment: 1 },
            },
          });
          if (recovered.count) {
            await tx.tonhubDepositAddress.updateMany({
              where: { invoiceId: input.invoiceId },
              data: { status: "FAILED" },
            });
            if (latest.orderId) {
              await syncOrderFromAttempts(tx, {
                orderId: latest.orderId,
                fiatAmountMicros,
                nextStatus: "FAILED",
                expiresAt: input.partialPaymentExpiresAt,
                forceRecovery: true,
              });
            }
          }
        }
        return findInvoiceWithOrder(tx, input.invoiceId);
      }

      if (current.orderId) {
        await syncOrderFromAttempts(tx, {
          orderId: current.orderId,
          fiatAmountMicros,
          nextStatus: "PARTIAL",
          expiresAt: input.partialPaymentExpiresAt,
        });
      }
      return findInvoiceWithOrder(tx, input.invoiceId);
    }),
    markInvoicePaid: async (input) => db.$transaction(async (tx) => {
      const found = await findInvoiceWithOrder(tx, input.invoiceId);
      if (!found || !activeAttemptStatuses.includes(found.status as typeof activeAttemptStatuses[number])) {
        return null;
      }
      const current = await ensureInvoiceOrder(tx, found, { preferInvoice: true });
      const fiatAmountMicros = current.fiatAmountMicros ?? fiatCentsToMicros(current.fiatAmountCents);
      const result = await tx.tonhubPaymentInvoice.updateMany({
        where: {
          id: input.invoiceId,
          status: { in: [...activeAttemptStatuses] },
          version: current.version ?? 0,
        },
        data: {
          status: "PAID",
          paidNano: input.paidNano,
          paidAmountAtomic: input.paidNano,
          firstMovementAt: current.firstMovementAt ?? input.paidAt,
          creditedFiatMicros: fiatAmountMicros,
          remainingFiatMicros: "0",
          observedTransactionHash: input.transactionId,
          observedAt: input.paidAt,
          observedPayments: toInputJson(input.observedPayments),
          settlementReason: "FIAT_OBLIGATION_SATISFIED",
          scanPriorityAt: null,
          version: { increment: 1 },
        },
      });
      if (!result.count) {
        const latest = await findInvoiceWithOrder(tx, input.invoiceId);
        if (
          latest &&
          ["EXPIRED", "CANCELLED", "FAILED"].includes(latest.status) &&
          BigInt(input.paidNano) > BigInt(latest.paidAmountAtomic ?? latest.paidNano ?? "0")
        ) {
          const recovered = await tx.tonhubPaymentInvoice.updateMany({
            where: {
              id: input.invoiceId,
              status: latest.status,
              version: latest.version ?? 0,
            },
            data: {
              status: "FAILED",
              paidNano: input.paidNano,
              paidAmountAtomic: input.paidNano,
              firstMovementAt: latest.firstMovementAt ?? input.paidAt,
              creditedFiatMicros: fiatAmountMicros,
              remainingFiatMicros: "0",
              observedTransactionHash: input.transactionId,
              observedAt: input.paidAt,
              observedPayments: toInputJson(input.observedPayments),
              settlementReason: "CONCURRENT_PAYMENT_RECOVERY",
              scanPriorityAt: null,
              version: { increment: 1 },
            },
          });
          if (recovered.count) {
            await tx.tonhubDepositAddress.updateMany({
              where: { invoiceId: input.invoiceId },
              data: { status: "FAILED", paidAt: input.paidAt },
            });
            if (latest.orderId) {
              await syncOrderFromAttempts(tx, {
                orderId: latest.orderId,
                fiatAmountMicros,
                nextStatus: "FAILED",
                paidAt: input.paidAt,
                forceRecovery: true,
              });
            }
            await tx.tonhubPaymentTransaction.create({
              data: {
                invoiceId: input.invoiceId,
                providerName: "ton-direct",
                providerTransactionId: input.transactionId,
                status: "PAID",
                amountNano: input.paidNano,
                asset: gramAsset.symbol,
                payload: toInputJson({ observedPayments: input.observedPayments }),
              },
            });
          }
        }
        return findInvoiceWithOrder(tx, input.invoiceId);
      }

      if (current.orderId) {
        await syncOrderFromAttempts(tx, {
          orderId: current.orderId,
          fiatAmountMicros,
          nextStatus: "PAID",
          paidAt: input.paidAt,
        });
      }
      await tx.tonhubDepositAddress.updateMany({
        where: { invoiceId: input.invoiceId },
        data: {
          status: "PAID",
          paidAt: input.paidAt,
        },
      });
      await tx.tonhubPaymentTransaction.create({
        data: {
          invoiceId: input.invoiceId,
          providerName: "ton-direct",
          providerTransactionId: input.transactionId,
          status: "PAID",
          amountNano: input.paidNano,
          asset: gramAsset.symbol,
          payload: toInputJson({ observedPayments: input.observedPayments }),
        },
      });

      return findInvoiceWithOrder(tx, input.invoiceId);
    }),
  };
}

export const prismaTonhubPaymentRepository = createPrismaTonhubPaymentRepository(
  prisma as unknown as PrismaLike,
);
