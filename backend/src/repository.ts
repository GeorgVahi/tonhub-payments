import { prisma } from "./db";
import type { TonUniqueDepositAddress } from "./ton/deposit-addresses";
import type {
  TonhubObservedPayment,
  TonhubPaymentInvoiceRecord,
  TonhubRateQuote
} from "./types";
import type { TonNetwork } from "./ton/direct-payments";

type PrismaLike = {
  $transaction: <T>(handler: (tx: any) => Promise<T>) => Promise<T>;
  tonhubPaymentInvoice: any;
  tonhubDepositAddress: any;
  tonhubPaymentTransaction: any;
};

const db = prisma as unknown as PrismaLike;

function normalizeInvoice(value: unknown): TonhubPaymentInvoiceRecord {
  return value as TonhubPaymentInvoiceRecord;
}

function toInputJson(value: unknown) {
  return value as any;
}

export type TonhubPaymentRepository = {
  findInvoiceById: (id: string) => Promise<TonhubPaymentInvoiceRecord | null>;
  findReusableInvoice: (input: {
    externalId?: string | null;
    network: TonNetwork;
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

export const prismaTonhubPaymentRepository: TonhubPaymentRepository = {
  findInvoiceById: async (id) => {
    const invoice = await db.tonhubPaymentInvoice.findUnique({ where: { id } });
    return invoice ? normalizeInvoice(invoice) : null;
  },
  findReusableInvoice: async ({ externalId, network }) => {
    if (!externalId) {
      return null;
    }

    const invoice = await db.tonhubPaymentInvoice.findFirst({
      where: {
        externalId,
        network,
        status: {
          in: ["PENDING", "PARTIAL"]
        }
      },
      orderBy: {
        createdAt: "desc"
      }
    });

    return invoice ? normalizeInvoice(invoice) : null;
  },
  createPendingInvoice: async (input) =>
    db.$transaction(async (tx) => {
      const invoice = await tx.tonhubPaymentInvoice.create({
        data: {
          externalId: input.externalId || null,
          network: input.network,
          asset: "TON",
          fiatAmountCents: input.amountCents,
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
          reference: input.reference,
          status: "PENDING",
          providerName: "ton-direct",
          expiresAt: input.expiresAt,
          priceLockedAt: input.priceLockedAt,
          priceLockedUntil: input.priceLockedUntil,
          metadata: toInputJson(input.metadata ?? null),
          payload: toInputJson({
            quote: {
              ...input.quote,
              updatedAt: input.quote.updatedAt?.toISOString() ?? null,
              fetchedAt: input.quote.fetchedAt.toISOString()
            }
          })
        }
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
          assignedAt: input.createdAt
        }
      });

      return normalizeInvoice(invoice);
    }),
  markInvoiceExpired: async ({ invoiceId, expiredAt }) => {
    const result = await db.tonhubPaymentInvoice.updateMany({
      where: {
        id: invoiceId,
        status: {
          in: ["PENDING", "PARTIAL"]
        }
      },
      data: {
        status: "EXPIRED",
        observedAt: expiredAt
      }
    });

    if (!result.count) {
      return null;
    }

    return db.$transaction(async (tx) => {
      await tx.tonhubDepositAddress.updateMany({
        where: {
          invoiceId
        },
        data: {
          status: "EXPIRED"
        }
      });
      return normalizeInvoice(await tx.tonhubPaymentInvoice.findUnique({ where: { id: invoiceId } }));
    });
  },
  markInvoicePartial: async (input) => {
    const result = await db.tonhubPaymentInvoice.updateMany({
      where: {
        id: input.invoiceId,
        status: {
          in: ["PENDING", "PARTIAL"]
        }
      },
      data: {
        status: "PARTIAL",
        paidNano: input.paidNano,
        partialPaymentStartedAt: input.partialPaymentStartedAt,
        partialPaymentExpiresAt: input.partialPaymentExpiresAt,
        observedPayments: toInputJson(input.observedPayments),
        observedAt: input.observedAt
      }
    });

    if (!result.count) {
      return null;
    }

    const invoice = await db.tonhubPaymentInvoice.findUnique({ where: { id: input.invoiceId } });
    return invoice ? normalizeInvoice(invoice) : null;
  },
  markInvoicePaid: async (input) =>
    db.$transaction(async (tx) => {
      const result = await tx.tonhubPaymentInvoice.updateMany({
        where: {
          id: input.invoiceId,
          status: {
            in: ["PENDING", "PARTIAL"]
          }
        },
        data: {
          status: "PAID",
          paidNano: input.paidNano,
          observedTransactionHash: input.transactionId,
          observedAt: input.paidAt,
          observedPayments: toInputJson(input.observedPayments)
        }
      });

      if (!result.count) {
        return null;
      }

      await tx.tonhubDepositAddress.updateMany({
        where: {
          invoiceId: input.invoiceId
        },
        data: {
          status: "PAID",
          paidAt: input.paidAt
        }
      });
      await tx.tonhubPaymentTransaction.create({
        data: {
          invoiceId: input.invoiceId,
          providerName: "ton-direct",
          providerTransactionId: input.transactionId,
          status: "PAID",
          amountNano: input.paidNano,
          asset: "TON",
          payload: toInputJson({
            observedPayments: input.observedPayments
          })
        }
      });

      return normalizeInvoice(await tx.tonhubPaymentInvoice.findUnique({ where: { id: input.invoiceId } }));
    })
};

