import { z } from "zod";
import {
  assertNetworkAllowed,
  formatFiatCents,
  intEnv,
  parseFiatAmountToCents,
  parseFiatCurrency,
  resolveDefaultNetwork,
  type FiatCurrency
} from "./config";
import {
  buildTonTransferLink,
  createTonInvoiceReference,
  fetchTonTransactions,
  findTonInvoicePayments,
  formatNanoTon,
  maskValue,
  parseTonNetwork,
  type TonCenterTransactionsResponse,
  type TonInvoiceMatch,
  type TonNetwork,
  type TonReadConfig
} from "./ton/direct-payments";
import {
  createTonV5R1DepositAddressFromEnv,
  type TonUniqueDepositAddress
} from "./ton/deposit-addresses";
import { findTonDepositAddressPayments } from "./ton/matching";
import { ceilTonAmountNanoFromFiat, fetchTonFiatRate } from "./rates";
import {
  prismaTonhubPaymentRepository,
  type TonhubPaymentRepository
} from "./repository";
import type {
  TonhubObservedPayment,
  TonhubPaymentInvoiceRecord,
  TonhubRateQuote
} from "./types";
import { resolveTonApiConfig } from "./ton/direct-payments";

type TonhubPaymentDependencies = {
  repository: TonhubPaymentRepository;
  now: () => Date;
  resolveTonApiConfig: (network: TonNetwork) => TonReadConfig;
  fetchTonTransactions: (input: {
    config: TonReadConfig;
    limit: number;
    startUtime?: number;
    endUtime?: number;
  }) => Promise<TonCenterTransactionsResponse>;
  fetchTonFiatRate: (currency: FiatCurrency) => Promise<{
    fiatPerTon: number;
    updatedAt: Date | null;
    fetchedAt: Date;
  }>;
  createTonDepositAddress: (input: { network: TonNetwork }) => TonUniqueDepositAddress;
  createTonInvoiceReference: (prefix?: string) => string;
};

type PaymentResponse =
  | {
      status: 200;
      body: Record<string, unknown>;
    }
  | {
      status: 400 | 404 | 409 | 410 | 503;
      body: Record<string, unknown>;
    };

const createInvoiceSchema = z.object({
  amount: z.union([z.string(), z.number()]),
  currency: z.string().optional(),
  network: z.string().optional(),
  externalId: z.string().trim().min(1).max(120).optional(),
  metadata: z.unknown().optional()
});

const transactionLimit = 1000;

function addMinutes(date: Date, minutes: number) {
  const next = new Date(date);
  next.setUTCMinutes(next.getUTCMinutes() + minutes);
  return next;
}

function addHours(date: Date, hours: number) {
  const next = new Date(date);
  next.setUTCHours(next.getUTCHours() + hours);
  return next;
}

function toUnixSeconds(date: Date) {
  return Math.floor(date.getTime() / 1000);
}

function minDate(left: Date, right: Date) {
  return left.getTime() <= right.getTime() ? left : right;
}

function invoiceTtlMinutes() {
  return intEnv("TON_INVOICE_TTL_MINUTES", 60, {
    min: 1,
    max: 24 * 60
  });
}

function partialPaymentTtlHours() {
  return intEnv("TON_PARTIAL_PAYMENT_TTL_HOURS", 24, {
    min: 1,
    max: 7 * 24
  });
}

function invoiceLockUntil(invoice: TonhubPaymentInvoiceRecord) {
  return invoice.priceLockedUntil ?? invoice.expiresAt ?? addMinutes(invoice.createdAt, invoiceTtlMinutes());
}

function invoicePartialUntil(invoice: TonhubPaymentInvoiceRecord) {
  if (invoice.partialPaymentExpiresAt) {
    return invoice.partialPaymentExpiresAt;
  }

  if (invoice.partialPaymentStartedAt) {
    return addHours(invoice.partialPaymentStartedAt, partialPaymentTtlHours());
  }

  return null;
}

function transactionIdentity(match: TonInvoiceMatch) {
  return match.transaction.hash || match.transaction.lt || null;
}

function matchCreatedAtDate(match: TonInvoiceMatch) {
  if (!match.createdAt) {
    return null;
  }

  const date = new Date(match.createdAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

function compareMatchesByCreatedAt(left: TonInvoiceMatch, right: TonInvoiceMatch) {
  const leftMs = left.createdAt ? Date.parse(left.createdAt) : 0;
  const rightMs = right.createdAt ? Date.parse(right.createdAt) : 0;
  return leftMs - rightMs;
}

function observedPayment(match: TonInvoiceMatch): TonhubObservedPayment {
  const transactionId = transactionIdentity(match) || `${match.createdAt ?? "unknown"}:${match.amountNano}`;

  return {
    transactionId,
    amountNano: match.amountNano,
    amountTon: formatNanoTon(match.amountNano),
    createdAt: match.createdAt,
    status: match.status,
    comment: match.comment ?? ""
  };
}

function validNanoAmount(value: unknown): value is string {
  if (typeof value !== "string" || !value) {
    return false;
  }

  try {
    return BigInt(value) >= BigInt(0);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeStoredObservedPayment(value: unknown): TonhubObservedPayment | null {
  if (!isRecord(value)) {
    return null;
  }

  const transactionId = typeof value.transactionId === "string" && value.transactionId
    ? value.transactionId
    : null;
  const amountNano = validNanoAmount(value.amountNano) ? value.amountNano : null;

  if (!transactionId || !amountNano) {
    return null;
  }

  return {
    transactionId,
    amountNano,
    amountTon: typeof value.amountTon === "string" ? value.amountTon : formatNanoTon(amountNano),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
    status: "observed",
    comment: typeof value.comment === "string" ? value.comment : ""
  };
}

function storedObservedPayments(invoice: TonhubPaymentInvoiceRecord) {
  if (!Array.isArray(invoice.observedPayments)) {
    return [];
  }

  return invoice.observedPayments
    .map((payment) => normalizeStoredObservedPayment(payment))
    .filter((payment): payment is TonhubObservedPayment => Boolean(payment));
}

function observedPaymentsFromMatches(matches: TonInvoiceMatch[]) {
  const payments = new Map<string, TonhubObservedPayment>();

  for (const match of matches) {
    const payment = observedPayment(match);
    payments.set(payment.transactionId, payment);
  }

  return Array.from(payments.values());
}

function mergeObservedPayments(...groups: TonhubObservedPayment[][]) {
  const payments = new Map<string, TonhubObservedPayment>();

  for (const group of groups) {
    for (const payment of group) {
      payments.set(payment.transactionId, payment);
    }
  }

  return Array.from(payments.values()).sort((left, right) => {
    const leftMs = left.createdAt ? Date.parse(left.createdAt) : 0;
    const rightMs = right.createdAt ? Date.parse(right.createdAt) : 0;
    return leftMs - rightMs;
  });
}

function sumObservedPayments(payments: TonhubObservedPayment[]) {
  return payments
    .reduce((sum, payment) => sum + BigInt(payment.amountNano), BigInt(0))
    .toString();
}

function subtractNano(left: string, right: string) {
  const result = BigInt(left) - BigInt(right);
  return result > BigInt(0) ? result.toString() : "0";
}

function extractQuote(invoice: TonhubPaymentInvoiceRecord): TonhubRateQuote | null {
  if (!isRecord(invoice.payload) || !isRecord(invoice.payload.quote)) {
    return null;
  }

  const quote = invoice.payload.quote;
  const fiatAmountCents = typeof quote.fiatAmountCents === "number" ? quote.fiatAmountCents : null;
  const fiatAmount = typeof quote.fiatAmount === "number" ? quote.fiatAmount : null;
  const fiatCurrency = quote.fiatCurrency === "EUR" || quote.fiatCurrency === "USD" ? quote.fiatCurrency : null;
  const fiatPerTon = typeof quote.fiatPerTon === "number" ? quote.fiatPerTon : null;
  const amountNano = typeof quote.amountNano === "string" ? quote.amountNano : null;
  const amountTon = typeof quote.amountTon === "string" ? quote.amountTon : null;
  const updatedAt = typeof quote.updatedAt === "string" && quote.updatedAt ? new Date(quote.updatedAt) : null;
  const fetchedAt = typeof quote.fetchedAt === "string" ? new Date(quote.fetchedAt) : null;

  if (
    fiatAmountCents === null ||
    fiatAmount === null ||
    !fiatCurrency ||
    fiatPerTon === null ||
    !amountNano ||
    !amountTon ||
    !fetchedAt ||
    Number.isNaN(fetchedAt.getTime()) ||
    (updatedAt && Number.isNaN(updatedAt.getTime()))
  ) {
    return null;
  }

  return {
    source: "coingecko",
    fiatAmountCents,
    fiatAmount,
    fiatCurrency,
    fiatPerTon,
    amountNano,
    amountTon,
    updatedAt,
    fetchedAt
  };
}

function serializeQuote(quote: TonhubRateQuote | null) {
  return quote
    ? {
        source: quote.source,
        fiatAmountCents: quote.fiatAmountCents,
        fiatAmount: quote.fiatAmount,
        fiatCurrency: quote.fiatCurrency,
        fiatPerTon: quote.fiatPerTon,
        amountNano: quote.amountNano,
        amountTon: quote.amountTon,
        updatedAt: quote.updatedAt?.toISOString() ?? null,
        fetchedAt: quote.fetchedAt.toISOString()
      }
    : null;
}

function serializeInvoice(invoice: TonhubPaymentInvoiceRecord, quote = extractQuote(invoice)) {
  const paidNano = invoice.paidNano || "0";
  const remainingNano = subtractNano(invoice.amountNano, paidNano);
  const payableNano = remainingNano === "0" ? invoice.amountNano : remainingNano;

  return {
    id: invoice.id,
    externalId: invoice.externalId,
    network: invoice.network,
    asset: invoice.asset,
    fiatAmountCents: invoice.fiatAmountCents,
    fiatAmount: invoice.fiatAmountCents / 100,
    fiatCurrency: invoice.fiatCurrency,
    fiatAmountFormatted: formatFiatCents(invoice.fiatAmountCents, parseFiatCurrency(invoice.fiatCurrency)),
    address: invoice.address,
    addressMasked: maskValue(invoice.address),
    addressStrategy: invoice.addressStrategy,
    amountNano: payableNano,
    amountTon: formatNanoTon(payableNano),
    expectedAmountNano: invoice.amountNano,
    expectedAmountTon: formatNanoTon(invoice.amountNano),
    paidNano,
    paidTon: formatNanoTon(paidNano),
    remainingNano,
    remainingTon: formatNanoTon(remainingNano),
    reference: invoice.reference,
    deeplink: buildTonTransferLink({
      address: invoice.address,
      amountNano: payableNano,
      comment: invoice.reference
    }),
    status: invoice.status,
    createdAt: invoice.createdAt.toISOString(),
    expiresAt: invoice.expiresAt?.toISOString() ?? null,
    priceLockedAt: invoice.priceLockedAt?.toISOString() ?? invoice.createdAt.toISOString(),
    priceLockedUntil: invoice.priceLockedUntil?.toISOString() ?? invoice.expiresAt?.toISOString() ?? null,
    partialPaymentStartedAt: invoice.partialPaymentStartedAt?.toISOString() ?? null,
    partialPaymentExpiresAt: invoice.partialPaymentExpiresAt?.toISOString() ?? null,
    observedPayments: Array.isArray(invoice.observedPayments) ? invoice.observedPayments : [],
    quote: serializeQuote(quote),
    metadata: invoice.metadata ?? null
  };
}

function serializeMatch(match: TonInvoiceMatch | null) {
  return match
    ? {
        transactionHashMasked: maskValue(match.transaction.hash || match.transaction.lt || "unknown"),
        amountNano: match.amountNano,
        amountTon: formatNanoTon(match.amountNano),
        createdAt: match.createdAt,
        observedStatus: match.status,
        comment: match.comment
      }
    : null;
}

function resolveDependencies(
  overrides: Partial<TonhubPaymentDependencies> = {}
): TonhubPaymentDependencies {
  return {
    repository: prismaTonhubPaymentRepository,
    now: () => new Date(),
    resolveTonApiConfig,
    fetchTonTransactions: (input) => fetchTonTransactions(input),
    fetchTonFiatRate,
    createTonDepositAddress: ({ network }) => createTonV5R1DepositAddressFromEnv({ network }),
    createTonInvoiceReference,
    ...overrides
  };
}

type SettleResult =
  | {
      state: "paid";
      invoice: TonhubPaymentInvoiceRecord;
      transactionsScanned: number;
      match: TonInvoiceMatch;
    }
  | {
      state: "pending" | "expired" | "not-payable" | "invalid-network";
      invoice: TonhubPaymentInvoiceRecord;
      transactionsScanned: number;
      match: TonInvoiceMatch | null;
    };

export async function settleTonhubInvoice(input: {
  invoice: TonhubPaymentInvoiceRecord;
  dependencies?: Partial<TonhubPaymentDependencies>;
  transactions?: TonCenterTransactionsResponse["transactions"];
}): Promise<SettleResult> {
  const deps = resolveDependencies(input.dependencies);
  const now = deps.now();
  const invoice = input.invoice;

  if (invoice.status !== "PENDING" && invoice.status !== "PARTIAL") {
    return {
      state: "not-payable",
      invoice,
      transactionsScanned: 0,
      match: null
    };
  }

  const network = invoice.network === "testnet" || invoice.network === "mainnet"
    ? invoice.network
    : null;
  if (!network) {
    return {
      state: "invalid-network",
      invoice,
      transactionsScanned: 0,
      match: null
    };
  }

  const lockUntil = invoiceLockUntil(invoice);
  const existingPartialUntil = invoicePartialUntil(invoice);
  const storedPayments = storedObservedPayments(invoice);
  const searchLimit = existingPartialUntil ?? addHours(lockUntil, partialPaymentTtlHours());
  const searchEnd = minDate(now, searchLimit);
  const transactions = input.transactions ?? (await deps.fetchTonTransactions({
    config: {
      ...deps.resolveTonApiConfig(network),
      address: invoice.address
    },
    limit: transactionLimit,
    startUtime: toUnixSeconds(invoice.createdAt),
    endUtime: toUnixSeconds(searchEnd) + 60
  })).transactions ?? [];
  const matches = (invoice.addressStrategy === "unique-address"
    ? findTonDepositAddressPayments({
        transactions,
        notBefore: invoice.createdAt,
        notAfter: searchLimit
      })
    : findTonInvoicePayments({
        transactions,
        expectedComment: invoice.reference,
        notBefore: invoice.createdAt,
        notAfter: searchLimit
      })).sort(compareMatchesByCreatedAt);
  const observedMatches = matches.filter((match) => match.status === "observed");
  const partialStarter = invoice.partialPaymentStartedAt
    ? observedMatches.find((match) => {
        const matchDate = matchCreatedAtDate(match);
        return Boolean(matchDate && matchDate.getTime() <= invoice.partialPaymentStartedAt!.getTime());
      }) ?? observedMatches[0] ?? null
    : observedMatches.find((match) => {
        const matchDate = matchCreatedAtDate(match);
        return Boolean(matchDate && matchDate.getTime() <= lockUntil.getTime());
      }) ?? null;

  if (!partialStarter && storedPayments.length === 0) {
    if (lockUntil.getTime() < now.getTime()) {
      const expiredInvoice = await deps.repository.markInvoiceExpired({
        invoiceId: invoice.id,
        expiredAt: now
      });

      return {
        state: "expired",
        invoice: expiredInvoice ?? invoice,
        transactionsScanned: transactions.length,
        match: null
      };
    }

    return {
      state: "pending",
      invoice,
      transactionsScanned: transactions.length,
      match: matches[0] ?? null
    };
  }

  const starterDate = invoice.partialPaymentStartedAt ?? (partialStarter ? matchCreatedAtDate(partialStarter) : null) ?? now;
  const partialExpiresAt = existingPartialUntil ?? addHours(starterDate, partialPaymentTtlHours());
  const eligibleMatches = observedMatches.filter((match) => {
    const matchDate = matchCreatedAtDate(match);
    return Boolean(matchDate && matchDate.getTime() <= partialExpiresAt.getTime());
  });
  const observedPayments = mergeObservedPayments(storedPayments, observedPaymentsFromMatches(eligibleMatches));
  const paidNano = sumObservedPayments(observedPayments);
  const lastEligibleMatch = eligibleMatches[eligibleMatches.length - 1] ?? partialStarter;

  if (BigInt(paidNano) >= BigInt(invoice.amountNano)) {
    if (!lastEligibleMatch) {
      return {
        state: "pending",
        invoice,
        transactionsScanned: transactions.length,
        match: matches[0] ?? null
      };
    }

    const paidAt = matchCreatedAtDate(lastEligibleMatch) ?? now;
    const paidInvoice = await deps.repository.markInvoicePaid({
      invoiceId: invoice.id,
      transactionId: transactionIdentity(lastEligibleMatch) || invoice.reference,
      paidNano,
      observedPayments,
      paidAt
    });

    if (!paidInvoice) {
      return {
        state: "not-payable",
        invoice,
        transactionsScanned: transactions.length,
        match: null
      };
    }

    return {
      state: "paid",
      invoice: paidInvoice,
      transactionsScanned: transactions.length,
      match: lastEligibleMatch
    };
  }

  if (BigInt(paidNano) > BigInt(0)) {
    if (partialExpiresAt.getTime() < now.getTime()) {
      const expiredInvoice = await deps.repository.markInvoiceExpired({
        invoiceId: invoice.id,
        expiredAt: now
      });

      return {
        state: "expired",
        invoice: expiredInvoice ?? invoice,
        transactionsScanned: transactions.length,
        match: null
      };
    }

    const partialInvoice = await deps.repository.markInvoicePartial({
      invoiceId: invoice.id,
      paidNano,
      partialPaymentStartedAt: starterDate,
      partialPaymentExpiresAt: partialExpiresAt,
      observedPayments,
      observedAt: starterDate
    });

    return {
      state: "pending",
      invoice: partialInvoice ?? invoice,
      transactionsScanned: transactions.length,
      match: lastEligibleMatch ?? matches[0] ?? null
    };
  }

  return {
    state: "pending",
    invoice,
    transactionsScanned: transactions.length,
    match: matches[0] ?? null
  };
}

export async function createTonhubPaymentInvoice(
  body: unknown,
  dependencies: Partial<TonhubPaymentDependencies> = {}
): Promise<PaymentResponse> {
  const parsed = createInvoiceSchema.safeParse(body);
  if (!parsed.success) {
    return {
      status: 400,
      body: {
        errorCode: "INVALID_INVOICE_REQUEST",
        error: parsed.error.issues[0]?.message ?? "Invalid invoice request."
      }
    };
  }

  try {
    const deps = resolveDependencies(dependencies);
    const currency = parseFiatCurrency(parsed.data.currency);
    const amountCents = parseFiatAmountToCents(parsed.data.amount);
    const network = parseTonNetwork(parsed.data.network || resolveDefaultNetwork());
    assertNetworkAllowed(network);

    const reusableInvoice = await deps.repository.findReusableInvoice({
      externalId: parsed.data.externalId,
      network
    });

    if (reusableInvoice) {
      const settled = await settleTonhubInvoice({
        invoice: reusableInvoice,
        dependencies: deps
      });

      return {
        status: 200,
        body: {
          ok: true,
          reused: true,
          finalized: settled.state === "paid",
          invoice: serializeInvoice(settled.invoice),
          transactionsScanned: settled.transactionsScanned,
          match: serializeMatch(settled.match)
        }
      };
    }

    const createdAt = deps.now();
    const rate = await deps.fetchTonFiatRate(currency);
    const amountNano = ceilTonAmountNanoFromFiat({
      amountCents,
      fiatPerTon: rate.fiatPerTon
    });
    const quote: TonhubRateQuote = {
      source: "coingecko",
      fiatAmountCents: amountCents,
      fiatAmount: amountCents / 100,
      fiatCurrency: currency,
      fiatPerTon: rate.fiatPerTon,
      amountNano,
      amountTon: formatNanoTon(amountNano),
      updatedAt: rate.updatedAt,
      fetchedAt: rate.fetchedAt
    };
    const depositAddress = deps.createTonDepositAddress({ network });
    const invoice = await deps.repository.createPendingInvoice({
      externalId: parsed.data.externalId,
      amountCents,
      currency,
      network,
      depositAddress,
      reference: deps.createTonInvoiceReference(process.env.TON_INVOICE_REFERENCE_PREFIX || "TONHUB"),
      quote,
      metadata: parsed.data.metadata,
      createdAt,
      expiresAt: addMinutes(createdAt, invoiceTtlMinutes()),
      priceLockedAt: createdAt,
      priceLockedUntil: addMinutes(createdAt, invoiceTtlMinutes())
    });

    return {
      status: 200,
      body: {
        ok: true,
        invoice: serializeInvoice(invoice, quote)
      }
    };
  } catch (error) {
    return {
      status: 503,
      body: {
        errorCode: "TON_INVOICE_CREATE_FAILED",
        error: error instanceof Error ? error.message : "Unable to create TON invoice."
      }
    };
  }
}

export async function getTonhubPaymentInvoice(
  id: string,
  dependencies: Partial<TonhubPaymentDependencies> = {}
): Promise<PaymentResponse> {
  const deps = resolveDependencies(dependencies);
  const invoice = await deps.repository.findInvoiceById(id);

  if (!invoice) {
    return {
      status: 404,
      body: {
        errorCode: "TON_INVOICE_NOT_FOUND"
      }
    };
  }

  return {
    status: 200,
    body: {
      ok: true,
      invoice: serializeInvoice(invoice)
    }
  };
}

export async function checkTonhubPaymentInvoice(
  id: string,
  dependencies: Partial<TonhubPaymentDependencies> = {}
): Promise<PaymentResponse> {
  try {
    const deps = resolveDependencies(dependencies);
    const invoice = await deps.repository.findInvoiceById(id);

    if (!invoice) {
      return {
        status: 404,
        body: {
          errorCode: "TON_INVOICE_NOT_FOUND"
        }
      };
    }

    if (invoice.status === "PAID") {
      return {
        status: 200,
        body: {
          ok: true,
          finalized: true,
          invoice: serializeInvoice(invoice)
        }
      };
    }

    if (invoice.status !== "PENDING" && invoice.status !== "PARTIAL") {
      return {
        status: 409,
        body: {
          errorCode: "TON_INVOICE_NOT_PAYABLE",
          invoice: serializeInvoice(invoice)
        }
      };
    }

    const settled = await settleTonhubInvoice({
      invoice,
      dependencies: deps
    });

    if (settled.state === "expired") {
      return {
        status: 410,
        body: {
          errorCode: "TON_INVOICE_EXPIRED",
          invoice: serializeInvoice(settled.invoice),
          transactionsScanned: settled.transactionsScanned,
          match: null
        }
      };
    }

    if (settled.state === "invalid-network") {
      return {
        status: 409,
        body: {
          errorCode: "TON_INVOICE_NETWORK_INVALID",
          invoice: serializeInvoice(settled.invoice)
        }
      };
    }

    if (settled.state === "not-payable") {
      return {
        status: 409,
        body: {
          errorCode: "TON_INVOICE_NOT_PAYABLE",
          invoice: serializeInvoice(settled.invoice)
        }
      };
    }

    return {
      status: 200,
      body: {
        ok: true,
        found: settled.state === "paid",
        finalized: settled.state === "paid",
        invoice: serializeInvoice(settled.invoice),
        transactionsScanned: settled.transactionsScanned,
        match: serializeMatch(settled.match)
      }
    };
  } catch (error) {
    return {
      status: 503,
      body: {
        errorCode: "TON_INVOICE_CHECK_FAILED",
        error: error instanceof Error ? error.message : "Unable to check TON invoice."
      }
    };
  }
}

