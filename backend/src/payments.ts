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
  buildTonJettonTransferLink,
  ceilNanoTonToPaymentUnit,
  createTonInvoiceReference,
  fetchTonTransactions,
  findTonInvoicePayments,
  formatNanoTon,
  formatPaymentNanoTon,
  gramAsset,
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
import { canonicalTonTransactionHash } from "./ton/gram-shadow-scanner";
import { ceilTonAmountNanoFromFiat, fetchTonFiatRate } from "./rates";
import {
  TonhubOrderNotRetryableError,
  TonhubOrderTermsMismatchError,
  prismaTonhubPaymentRepository,
  type TonhubPaymentRepository
} from "./repository";
import type {
  TonhubObservedPayment,
  TonhubPaymentInvoiceRecord,
  TonhubRateQuote
} from "./types";
import { resolveTonApiConfig } from "./ton/direct-payments";
import {
  assertPaymentAssetSnapshot,
  ceilAtomicToPaymentUnit,
  formatAssetAmount,
  formatCheckoutAssetAmount,
  parsePaymentAsset,
  paymentAssets,
} from "../../shared/payment-assets";
import {
  compareGramSettlementMatches,
  parseGramSettlementMode,
  prismaGramLedgerSettlementSource,
  type GramLedgerSettlementSource,
  type GramSettlementComparison,
  type GramSettlementMode,
} from "./gram-ledger-source";
import { calculateActivationThresholdFiatMicros } from "./movement-ledger";
import { mixedAssetSettlement, type MixedSettlementResult } from "./mixed-settlement";
import { isCheckoutAssetAvailable } from "./checkout-assets";
import {
  prismaRateSnapshotRepository,
  rateSnapshotMaxAgeMs,
  type RateSnapshotRecord,
} from "./rate-snapshots";
import { officialMainnetUsdtMasterFriendlyAddress } from "./ton/mainnet-usdt";

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
  findRateSnapshot: (input: {
    asset: "USDT";
    quoteCurrency: FiatCurrency;
    at: Date;
    maxAgeMs: number;
  }) => Promise<RateSnapshotRecord | null>;
  rateSnapshotMaxAgeMs: () => number;
  checkoutAssetAvailable: (asset: "GRAM" | "USDT", network: TonNetwork) => boolean;
  createTonDepositAddress: (input: { network: TonNetwork }) => TonUniqueDepositAddress;
  createTonInvoiceReference: (prefix?: string) => string;
  gramLedgerSource: GramLedgerSettlementSource;
  gramSettlementMode: () => GramSettlementMode;
  reportGramSettlementComparison: (comparison: GramSettlementComparison) => void;
  mixedAssetSettlement: {
    settleInvoice: (input: {
      invoiceId: string;
      now: Date;
      maxRateAgeMs?: number;
      partialPaymentTtlHours?: number;
    }) => Promise<MixedSettlementResult>;
  };
  movementSettlementEnabled: () => boolean;
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
  asset: z.preprocess(
    (value) => typeof value === "string" ? value.trim().toUpperCase() : value,
    z.enum(["GRAM", "TON", "USDT"]).optional(),
  ),
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

function partialMerchantNetworkFeeFiatMicros(currency: FiatCurrency) {
  const envName = `TON_PARTIAL_MERCHANT_NETWORK_FEE_${currency}_MICROS`;
  const value = process.env[envName]?.trim() || "0";
  if (!/^\d+$/.test(value)) {
    throw new Error(`${envName} must be a non-negative integer string.`);
  }
  return BigInt(value).toString();
}

function movementSettlementEnabled() {
  const value = process.env.TON_MOVEMENT_SETTLEMENT_ENABLED?.trim().toLowerCase() || "false";
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error("TON_MOVEMENT_SETTLEMENT_ENABLED must be true or false.");
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
  return canonicalTonTransactionHash(match.transaction.hash) || match.transaction.hash || match.transaction.lt || null;
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
  const amountFormatted = formatNanoTon(match.amountNano);

  return {
    transactionId,
    asset: paymentAssets.GRAM.symbol,
    assetDecimals: paymentAssets.GRAM.decimals,
    amountAtomic: match.amountNano,
    amountFormatted,
    amountNano: match.amountNano,
    amountGram: amountFormatted,
    amountTon: amountFormatted,
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

  const storedTransactionId = typeof value.transactionId === "string" && value.transactionId
    ? value.transactionId
    : null;
  const transactionId = canonicalTonTransactionHash(storedTransactionId) ?? storedTransactionId;
  const amountNano = validNanoAmount(value.amountAtomic)
    ? value.amountAtomic
    : validNanoAmount(value.amountNano)
      ? value.amountNano
      : null;

  if (!transactionId || !amountNano) {
    return null;
  }

  let asset;
  try {
    asset = parsePaymentAsset(typeof value.asset === "string" ? value.asset : paymentAssets.GRAM.symbol);
  } catch {
    return null;
  }
  const amountFormatted = formatAssetAmount(amountNano, asset);

  return {
    transactionId,
    asset: asset.symbol,
    assetDecimals: asset.decimals,
    amountAtomic: amountNano,
    amountFormatted,
    ...(asset.symbol === paymentAssets.GRAM.symbol
      ? {
          amountNano,
          amountGram: amountFormatted,
          amountTon: amountFormatted,
        }
      : {}),
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

function canonicalStoredAtomic(value: unknown) {
  return typeof value === "string" && /^\d+$/.test(value)
    ? BigInt(value).toString()
    : null;
}

function strictStoredObservedPaymentMatches(invoice: TonhubPaymentInvoiceRecord): TonInvoiceMatch[] {
  const paidNano = canonicalStoredAtomic(invoice.paidNano);
  const paidAmountAtomic = invoice.paidAmountAtomic === null || invoice.paidAmountAtomic === undefined
    ? null
    : canonicalStoredAtomic(invoice.paidAmountAtomic);
  if (!paidNano || (invoice.paidAmountAtomic !== null && invoice.paidAmountAtomic !== undefined && !paidAmountAtomic)) {
    throw new Error(`GRAM invoice ${invoice.id} has malformed persisted paid amount.`);
  }
  if (paidAmountAtomic !== null && paidAmountAtomic !== paidNano) {
    throw new Error(`GRAM invoice ${invoice.id} has inconsistent persisted paid amounts.`);
  }
  const persistedPaidAtomic = paidAmountAtomic ?? paidNano;
  if (invoice.observedPayments === null || invoice.observedPayments === undefined) {
    if (persistedPaidAtomic === "0") {
      return [];
    }
    throw new Error(`GRAM invoice ${invoice.id} has paid amount without stored payment evidence.`);
  }
  if (!Array.isArray(invoice.observedPayments)) {
    throw new Error(`GRAM invoice ${invoice.id} has malformed stored payment evidence.`);
  }

  const matches = new Map<string, TonInvoiceMatch>();
  const facts = new Map<string, string>();
  for (const value of invoice.observedPayments) {
    const payment = normalizeStoredObservedPayment(value);
    if (!payment || !isRecord(value)) {
      throw new Error(`GRAM invoice ${invoice.id} has malformed stored payment evidence.`);
    }
    const transactionId = canonicalTonTransactionHash(payment.transactionId);
    const hasAmountAtomic = value.amountAtomic !== null && value.amountAtomic !== undefined;
    const hasAmountNano = value.amountNano !== null && value.amountNano !== undefined;
    const amountAtomic = canonicalStoredAtomic(value.amountAtomic);
    const amountNano = canonicalStoredAtomic(value.amountNano);
    const normalizedAmount = amountAtomic ?? amountNano;
    if (
      !transactionId ||
      !normalizedAmount ||
      normalizedAmount === "0" ||
      (hasAmountAtomic && !amountAtomic) ||
      (hasAmountNano && !amountNano) ||
      (amountAtomic !== null && amountNano !== null && amountAtomic !== amountNano)
    ) {
      throw new Error(`GRAM invoice ${invoice.id} has malformed stored payment evidence.`);
    }
    const asset = parsePaymentAsset(typeof value.asset === "string" ? value.asset : "GRAM");
    if (
      asset.symbol !== "GRAM" ||
      (value.assetDecimals !== undefined && value.assetDecimals !== null && value.assetDecimals !== 9) ||
      value.status !== "observed"
    ) {
      throw new Error(`GRAM invoice ${invoice.id} has non-GRAM stored payment evidence.`);
    }
    if (typeof value.createdAt !== "string") {
      throw new Error(`GRAM invoice ${invoice.id} has malformed stored payment evidence.`);
    }
    const createdAt = new Date(value.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      throw new Error(`GRAM invoice ${invoice.id} has malformed stored payment evidence.`);
    }
    const immutableFacts = `${normalizedAmount}:${createdAt.toISOString()}`;
    const existingFacts = facts.get(transactionId);
    if (existingFacts !== undefined && existingFacts !== immutableFacts) {
      throw new Error(`GRAM invoice ${invoice.id} has conflicting stored payment evidence.`);
    }
    if (existingFacts === undefined) {
      facts.set(transactionId, immutableFacts);
      matches.set(transactionId, {
        transaction: { hash: transactionId },
        comment: payment.comment,
        amountNano: normalizedAmount,
        createdAt: createdAt.toISOString(),
        status: "observed",
      });
    }
  }

  const storedTotal = [...matches.values()].reduce(
    (sum, match) => sum + BigInt(match.amountNano),
    BigInt(0),
  ).toString();
  if (storedTotal !== persistedPaidAtomic) {
    throw new Error(`GRAM invoice ${invoice.id} stored payment evidence does not match its paid amount.`);
  }
  return [...matches.values()];
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
    .reduce((sum, payment) => sum + BigInt(payment.amountAtomic ?? payment.amountNano ?? "0"), BigInt(0))
    .toString();
}

function subtractNano(left: string, right: string) {
  const result = BigInt(left) - BigInt(right);
  return result > BigInt(0) ? result.toString() : "0";
}

function formatFiatMicros(value: string | null | undefined, currency: FiatCurrency) {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }
  const micros = BigInt(value);
  const whole = micros / BigInt(1_000_000);
  const fraction = (micros % BigInt(1_000_000)).toString().padStart(6, "0");
  const trimmed = fraction.replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${trimmed} ${currency}`;
}

function ceilAssetAtomicFromFiat(input: {
  amountCents: number;
  fiatPerAsset: string;
  asset: typeof paymentAssets.USDT;
}) {
  const normalized = input.fiatPerAsset.trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    throw new Error("Checkout rate must be a positive decimal string.");
  }
  const [whole, fraction = ""] = normalized.split(".");
  const coefficient = BigInt(`${whole}${fraction}`);
  if (coefficient <= BigInt(0)) {
    throw new Error("Checkout rate must be greater than zero.");
  }
  const scale = BigInt(10) ** BigInt(fraction.length);
  const numerator = BigInt(input.amountCents) * (BigInt(10) ** BigInt(input.asset.decimals)) * scale;
  const denominator = BigInt(100) * coefficient;
  const exactAtomic = (numerator + denominator - BigInt(1)) / denominator;
  return ceilAtomicToPaymentUnit(exactAtomic, input.asset);
}

function extractQuote(invoice: TonhubPaymentInvoiceRecord): TonhubRateQuote | null {
  if (!isRecord(invoice.payload) || !isRecord(invoice.payload.quote)) {
    return null;
  }

  const quote = invoice.payload.quote;
  const asset = assertPaymentAssetSnapshot(
    parsePaymentAsset(typeof quote.asset === "string" ? quote.asset : paymentAssets.GRAM.symbol),
    { decimals: typeof quote.assetDecimals === "number" ? quote.assetDecimals : undefined },
  );
  const fiatAmountCents = typeof quote.fiatAmountCents === "number" ? quote.fiatAmountCents : null;
  const fiatAmount = typeof quote.fiatAmount === "number" ? quote.fiatAmount : null;
  const fiatCurrency = quote.fiatCurrency === "EUR" || quote.fiatCurrency === "USD" ? quote.fiatCurrency : null;
  const fiatPerAsset = typeof quote.fiatPerAsset === "number"
    ? quote.fiatPerAsset
    : asset.symbol === paymentAssets.GRAM.symbol && typeof quote.fiatPerGram === "number"
      ? quote.fiatPerGram
      : asset.symbol === paymentAssets.GRAM.symbol && typeof quote.fiatPerTon === "number"
        ? quote.fiatPerTon
        : null;
  const rawAmountAtomic = typeof quote.amountAtomic === "string" && validNanoAmount(quote.amountAtomic)
    ? quote.amountAtomic
    : typeof quote.amountNano === "string" && validNanoAmount(quote.amountNano)
      ? quote.amountNano
      : null;
  const amountNano = rawAmountAtomic
    ? ceilAtomicToPaymentUnit(rawAmountAtomic, asset)
    : null;
  const updatedAt = typeof quote.updatedAt === "string" && quote.updatedAt ? new Date(quote.updatedAt) : null;
  const fetchedAt = typeof quote.fetchedAt === "string" ? new Date(quote.fetchedAt) : null;

  if (
    fiatAmountCents === null ||
    fiatAmount === null ||
    !fiatCurrency ||
    fiatPerAsset === null ||
    !Number.isFinite(fiatPerAsset) ||
    fiatPerAsset <= 0 ||
    !amountNano ||
    !fetchedAt ||
    Number.isNaN(fetchedAt.getTime()) ||
    (updatedAt && Number.isNaN(updatedAt.getTime()))
  ) {
    return null;
  }

  const amountFormatted = formatCheckoutAssetAmount(amountNano, asset);

  return {
    source: quote.source === "usd-peg" ? "usd-peg" : "coingecko",
    rateSnapshotId: typeof quote.rateSnapshotId === "string" ? quote.rateSnapshotId : null,
    asset: asset.symbol,
    assetDecimals: asset.decimals,
    fiatPerAsset,
    amountAtomic: amountNano,
    amountFormatted,
    fiatAmountCents,
    fiatAmount,
    fiatCurrency,
    ...(asset.symbol === paymentAssets.GRAM.symbol
      ? {
          fiatPerGram: fiatPerAsset,
          fiatPerTon: fiatPerAsset,
          amountNano,
          amountGram: amountFormatted,
          amountTon: amountFormatted,
        }
      : {}),
    updatedAt,
    fetchedAt
  };
}

function serializeQuote(quote: TonhubRateQuote | null) {
  if (!quote) {
    return null;
  }
  const asset = assertPaymentAssetSnapshot(parsePaymentAsset(quote.asset), {
    decimals: quote.assetDecimals,
  });
  const amountAtomic = quote.amountAtomic;
  return {
        source: quote.source,
        rateSnapshotId: quote.rateSnapshotId ?? null,
        asset: asset.symbol,
        assetDecimals: asset.decimals,
        fiatAmountCents: quote.fiatAmountCents,
        fiatAmount: quote.fiatAmount,
        fiatCurrency: quote.fiatCurrency,
        fiatPerGram: asset.symbol === paymentAssets.GRAM.symbol ? quote.fiatPerGram ?? quote.fiatPerAsset : null,
        fiatPerTon: asset.symbol === paymentAssets.GRAM.symbol ? quote.fiatPerTon ?? quote.fiatPerAsset : null,
        fiatPerAsset: quote.fiatPerAsset,
        amountAtomic,
        amountFormatted: formatCheckoutAssetAmount(amountAtomic, asset),
        amountNano: asset.symbol === paymentAssets.GRAM.symbol ? quote.amountNano ?? amountAtomic : null,
        amountGram: asset.symbol === paymentAssets.GRAM.symbol
          ? quote.amountGram ?? formatCheckoutAssetAmount(amountAtomic, asset)
          : null,
        amountTon: asset.symbol === paymentAssets.GRAM.symbol
          ? quote.amountTon ?? formatCheckoutAssetAmount(amountAtomic, asset)
          : null,
        updatedAt: quote.updatedAt?.toISOString() ?? null,
        fetchedAt: quote.fetchedAt.toISOString()
      };
}

function serializeInvoice(invoice: TonhubPaymentInvoiceRecord, quote = extractQuote(invoice)) {
  const asset = assertPaymentAssetSnapshot(parsePaymentAsset(invoice.checkoutAsset ?? invoice.asset), {
    kind: invoice.assetKind,
    decimals: invoice.assetDecimals,
  });
  const paidNano = invoice.paidAmountAtomic ?? (invoice.paidNano || "0");
  const expectedAmountNano = ceilAtomicToPaymentUnit(invoice.amountAtomic ?? invoice.amountNano, asset);
  const fiatLedger = invoice.activationThresholdFiatMicros !== null &&
    invoice.activationThresholdFiatMicros !== undefined &&
    /^\d+$/.test(invoice.activationThresholdFiatMicros) &&
    BigInt(invoice.activationThresholdFiatMicros) > BigInt(0);
  const fiatAmountMicros = invoice.fiatAmountMicros && /^\d+$/.test(invoice.fiatAmountMicros)
    ? BigInt(invoice.fiatAmountMicros)
    : null;
  const remainingFiatMicros = invoice.remainingFiatMicros && /^\d+$/.test(invoice.remainingFiatMicros)
    ? BigInt(invoice.remainingFiatMicros)
    : null;
  const remainingExactNano = fiatLedger && fiatAmountMicros && remainingFiatMicros !== null
    ? (
        (BigInt(expectedAmountNano) * remainingFiatMicros + fiatAmountMicros - BigInt(1)) /
        fiatAmountMicros
      ).toString()
    : subtractNano(expectedAmountNano, paidNano);
  const remainingNano = remainingExactNano === "0"
    ? "0"
    : ceilAtomicToPaymentUnit(remainingExactNano, asset);
  const payableNano = remainingNano === "0" ? expectedAmountNano : remainingNano;
  const amountFormatted = formatCheckoutAssetAmount(payableNano, asset);
  const expectedAmountFormatted = formatCheckoutAssetAmount(expectedAmountNano, asset);
  const paidAmountFormatted = formatAssetAmount(paidNano, asset);
  const remainingAmountFormatted = formatCheckoutAssetAmount(remainingNano, asset);
  const amountGram = asset.symbol === paymentAssets.GRAM.symbol ? amountFormatted : null;
  const expectedAmountGram = asset.symbol === paymentAssets.GRAM.symbol ? expectedAmountFormatted : null;
  const paidGram = asset.symbol === paymentAssets.GRAM.symbol ? paidAmountFormatted : null;
  const remainingGram = asset.symbol === paymentAssets.GRAM.symbol ? remainingAmountFormatted : null;
  const fiatCurrency = parseFiatCurrency(invoice.fiatCurrency);

  return {
    id: invoice.id,
    orderId: invoice.orderId ?? null,
    externalId: invoice.externalId,
    network: invoice.network,
    asset: asset.symbol,
    assetKind: asset.kind,
    assetDecimals: asset.decimals,
    fiatAmountCents: invoice.fiatAmountCents,
    fiatAmount: invoice.fiatAmountCents / 100,
    fiatCurrency: invoice.fiatCurrency,
    fiatAmountFormatted: formatFiatCents(invoice.fiatAmountCents, fiatCurrency),
    creditedFiatMicros: invoice.creditedFiatMicros ?? "0",
    creditedFiatFormatted: formatFiatMicros(invoice.creditedFiatMicros ?? "0", fiatCurrency),
    remainingFiatMicros: invoice.remainingFiatMicros ?? null,
    remainingFiatFormatted: formatFiatMicros(invoice.remainingFiatMicros, fiatCurrency),
    activationThresholdFiatMicros: invoice.activationThresholdFiatMicros ?? null,
    settlementBasis: fiatLedger ? "fiat-ledger" : "asset-atomic",
    address: invoice.address,
    addressMasked: maskValue(invoice.address),
    addressStrategy: invoice.addressStrategy,
    amountNano: asset.symbol === paymentAssets.GRAM.symbol ? payableNano : null,
    amountGram,
    amountTon: amountGram,
    amountAtomic: payableNano,
    amountFormatted,
    expectedAmountNano: asset.symbol === paymentAssets.GRAM.symbol ? expectedAmountNano : null,
    expectedAmountGram,
    expectedAmountTon: expectedAmountGram,
    expectedAmountAtomic: expectedAmountNano,
    expectedAmountFormatted,
    paidNano: asset.symbol === paymentAssets.GRAM.symbol ? paidNano : null,
    paidGram,
    paidTon: paidGram,
    paidAmountAtomic: paidNano,
    paidAmountFormatted,
    remainingNano: asset.symbol === paymentAssets.GRAM.symbol ? remainingNano : null,
    remainingGram,
    remainingTon: remainingGram,
    remainingAmountAtomic: remainingNano,
    remainingAmountFormatted,
    reference: invoice.reference,
    deeplink: asset.kind === "NATIVE"
      ? buildTonTransferLink({
          address: invoice.address,
          amountNano: payableNano,
          comment: invoice.addressStrategy === "unique-address" ? undefined : invoice.reference
        })
      : asset.symbol === paymentAssets.USDT.symbol &&
          invoice.network === "mainnet" &&
          invoice.addressStrategy === "unique-address"
        ? buildTonJettonTransferLink({
            address: invoice.address,
            amountAtomic: payableNano,
            jettonMasterAddress: officialMainnetUsdtMasterFriendlyAddress,
          })
        : null,
    status: invoice.status,
    createdAt: invoice.createdAt.toISOString(),
    expiresAt: invoice.expiresAt?.toISOString() ?? null,
    priceLockedAt: invoice.priceLockedAt?.toISOString() ?? invoice.createdAt.toISOString(),
    priceLockedUntil: invoice.priceLockedUntil?.toISOString() ?? invoice.expiresAt?.toISOString() ?? null,
    partialPaymentStartedAt: invoice.partialPaymentStartedAt?.toISOString() ?? null,
    partialPaymentExpiresAt: invoice.partialPaymentExpiresAt?.toISOString() ?? null,
    observedPayments: storedObservedPayments(invoice),
    quote: serializeQuote(quote),
    order: invoice.order
      ? {
          id: invoice.order.id,
          externalId: invoice.order.externalId,
          fiatAmountMicros: invoice.order.fiatAmountMicros,
          fiatCurrency: invoice.order.fiatCurrency,
          creditedFiatMicros: invoice.order.creditedFiatMicros,
          overpaymentFiatMicros: invoice.order.overpaymentFiatMicros,
          status: invoice.order.status,
          paidAt: invoice.order.paidAt?.toISOString() ?? null,
          expiresAt: invoice.order.expiresAt?.toISOString() ?? null
        }
      : null,
    metadata: invoice.metadata ?? null
  };
}

function serializeMatch(match: TonInvoiceMatch | null) {
  return match
    ? {
        transactionHashMasked: maskValue(match.transaction.hash || match.transaction.lt || "unknown"),
        asset: paymentAssets.GRAM.symbol,
        assetDecimals: paymentAssets.GRAM.decimals,
        amountAtomic: match.amountNano,
        amountFormatted: formatAssetAmount(match.amountNano, paymentAssets.GRAM),
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
    findRateSnapshot: (input) => prismaRateSnapshotRepository.findAt(input),
    rateSnapshotMaxAgeMs,
    checkoutAssetAvailable: (asset, network) => isCheckoutAssetAvailable(asset, network),
    createTonDepositAddress: ({ network }) => createTonV5R1DepositAddressFromEnv({ network }),
    createTonInvoiceReference,
    gramLedgerSource: prismaGramLedgerSettlementSource,
    gramSettlementMode: () => parseGramSettlementMode(process.env.TON_GRAM_SETTLEMENT_MODE),
    reportGramSettlementComparison: (comparison) => {
      console.log(`[tonhub-settlement-compare] ${JSON.stringify(comparison)}`);
    },
    mixedAssetSettlement,
    movementSettlementEnabled,
    ...overrides
  };
}

type SettleResult =
  | {
      state: "paid";
      invoice: TonhubPaymentInvoiceRecord;
      transactionsScanned: number;
      match: TonInvoiceMatch | null;
    }
  | {
      state: "pending" | "expired" | "not-payable" | "invalid-network";
      invoice: TonhubPaymentInvoiceRecord;
      transactionsScanned: number;
      match: TonInvoiceMatch | null;
    };

function gramSettlementWindow(invoice: TonhubPaymentInvoiceRecord, now: Date) {
  const lockUntil = invoiceLockUntil(invoice);
  const existingPartialUntil = invoicePartialUntil(invoice);
  const searchLimit = existingPartialUntil ?? addHours(lockUntil, partialPaymentTtlHours());
  return {
    searchLimit,
    searchEnd: minDate(now, searchLimit),
  };
}

function legacyGramMatches(input: {
  invoice: TonhubPaymentInvoiceRecord;
  transactions: NonNullable<TonCenterTransactionsResponse["transactions"]>;
  notAfter: Date;
}) {
  return (input.invoice.addressStrategy === "unique-address"
    ? findTonDepositAddressPayments({
        transactions: input.transactions,
        notBefore: input.invoice.createdAt,
        notAfter: input.notAfter,
      })
    : findTonInvoicePayments({
        transactions: input.transactions,
        expectedComment: input.invoice.reference,
        notBefore: input.invoice.createdAt,
        notAfter: input.notAfter,
      })).sort(compareMatchesByCreatedAt);
}

function reportGramComparison(
  deps: TonhubPaymentDependencies,
  comparison: GramSettlementComparison,
) {
  try {
    deps.reportGramSettlementComparison(comparison);
  } catch (error) {
    console.error(
      `[tonhub-settlement-compare] reporter failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function hasActiveAllocationPolicy(invoice: TonhubPaymentInvoiceRecord) {
  const value = invoice.activationThresholdFiatMicros;
  if (value === null || value === undefined) {
    return false;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invoice ${invoice.id} has malformed activationThresholdFiatMicros.`);
  }
  return BigInt(value) > BigInt(0);
}

export async function settleTonhubInvoiceWithConfiguredSource(input: {
  invoice: TonhubPaymentInvoiceRecord;
  dependencies?: Partial<TonhubPaymentDependencies>;
}): Promise<SettleResult> {
  const deps = resolveDependencies(input.dependencies);
  const mode = deps.gramSettlementMode();
  const useAllocationSettlement = hasActiveAllocationPolicy(input.invoice);
  if (mode === "legacy") {
    if (useAllocationSettlement) {
      throw new Error(`Invoice ${input.invoice.id} uses fiat-ledger settlement and cannot fall back to legacy atomic mutation.`);
    }
    return settleTonhubInvoice({ invoice: input.invoice, dependencies: deps });
  }
  const network = input.invoice.network === "testnet" || input.invoice.network === "mainnet"
    ? input.invoice.network
    : null;
  if (!network) {
    if (useAllocationSettlement) {
      throw new Error(`Invoice ${input.invoice.id} uses fiat-ledger settlement with an invalid network.`);
    }
    return settleTonhubInvoice({ invoice: input.invoice, dependencies: deps });
  }
  if (input.invoice.status !== "PENDING" && input.invoice.status !== "PARTIAL") {
    return {
      state: "not-payable",
      invoice: input.invoice,
      transactionsScanned: 0,
      match: null,
    };
  }
  const storedPaymentMatches = mode === "ledger" && !useAllocationSettlement
    ? strictStoredObservedPaymentMatches(input.invoice)
    : [];

  const now = deps.now();
  const { searchLimit, searchEnd } = gramSettlementWindow(input.invoice, now);
  let observationError: string | undefined;
  let scanAddress = input.invoice.address;
  try {
    scanAddress = (await deps.gramLedgerSource.resolveTarget({
      invoiceId: input.invoice.id,
      network,
    })).address;
  } catch (error) {
    observationError = error instanceof Error ? error.message : String(error);
    if (mode === "ledger" || useAllocationSettlement) {
      throw error;
    }
  }
  const transactions = (await deps.fetchTonTransactions({
    config: {
      ...deps.resolveTonApiConfig(network),
      address: scanAddress,
    },
    limit: transactionLimit,
    startUtime: toUnixSeconds(input.invoice.createdAt),
    endUtime: toUnixSeconds(searchEnd) + 60,
  })).transactions ?? [];
  const legacy = legacyGramMatches({
    invoice: input.invoice,
    transactions,
    notAfter: searchLimit,
  });
  let ledger: TonInvoiceMatch[] = [];
  let allocationSettlement: MixedSettlementResult | null = null;
  try {
    if (observationError) {
      throw new Error(observationError);
    }
    await deps.gramLedgerSource.observeTransactions({
      invoiceId: input.invoice.id,
      network,
      notBefore: input.invoice.createdAt,
      notAfter: searchEnd,
      transactions,
    });
    ledger = await deps.gramLedgerSource.listMatches({
      invoiceId: input.invoice.id,
      network,
      notBefore: input.invoice.createdAt,
      notAfter: searchEnd,
    });
    if (mode === "ledger" && !useAllocationSettlement) {
      const storedCompatibility = compareGramSettlementMatches({
        invoiceId: input.invoice.id,
        legacy: storedPaymentMatches,
        ledger,
      });
      if (storedCompatibility.onlyLegacy.length || storedCompatibility.conflicting.length) {
        throw new Error(
          `GRAM ledger cannot verify ${storedCompatibility.onlyLegacy.length + storedCompatibility.conflicting.length} stored payment(s) for invoice ${input.invoice.id}.`,
        );
      }
    }
    if (useAllocationSettlement) {
      allocationSettlement = await deps.mixedAssetSettlement.settleInvoice({
        invoiceId: input.invoice.id,
        now,
        partialPaymentTtlHours: partialPaymentTtlHours(),
      });
    }
  } catch (error) {
    observationError = error instanceof Error ? error.message : String(error);
    if (mode === "ledger" || useAllocationSettlement) {
      throw error;
    }
  }

  const comparison = compareGramSettlementMatches({
    invoiceId: input.invoice.id,
    legacy,
    ledger,
    observationError,
  });
  if (mode === "compare" || !comparison.equivalent) {
    reportGramComparison(deps, comparison);
  }
  if (allocationSettlement) {
    const settledInvoice = allocationSettlement.invoice;
    const lastMatch = ledger[ledger.length - 1] ?? null;
    if (settledInvoice.order?.status === "PAID" || settledInvoice.status === "PAID") {
      return {
        state: "paid",
        invoice: settledInvoice,
        transactionsScanned: transactions.length,
        match: lastMatch,
      };
    }
    if (settledInvoice.status === "PENDING" || settledInvoice.status === "PARTIAL") {
      return {
        state: "pending",
        invoice: settledInvoice,
        transactionsScanned: transactions.length,
        match: lastMatch,
      };
    }
    if (settledInvoice.status === "EXPIRED") {
      return {
        state: "expired",
        invoice: settledInvoice,
        transactionsScanned: transactions.length,
        match: lastMatch,
      };
    }
    return {
      state: "not-payable",
      invoice: settledInvoice,
      transactionsScanned: transactions.length,
      match: lastMatch,
    };
  }
  return settleTonhubInvoice({
    invoice: input.invoice,
    dependencies: deps,
    transactions,
    matches: mode === "ledger" ? ledger : legacy,
    now,
  });
}

export async function settleTonhubInvoice(input: {
  invoice: TonhubPaymentInvoiceRecord;
  dependencies?: Partial<TonhubPaymentDependencies>;
  transactions?: TonCenterTransactionsResponse["transactions"];
  matches?: TonInvoiceMatch[];
  now?: Date;
}): Promise<SettleResult> {
  const deps = resolveDependencies(input.dependencies);
  const now = input.now ?? deps.now();
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
  const matches = (input.matches ?? (invoice.addressStrategy === "unique-address"
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
      }))).sort(compareMatchesByCreatedAt);
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

      if (!expiredInvoice) {
        return {
          state: "not-payable",
          invoice,
          transactionsScanned: transactions.length,
          match: null
        };
      }

      if (expiredInvoice.status === "PAID") {
        return {
          state: "paid",
          invoice: expiredInvoice,
          transactionsScanned: transactions.length,
          match: null
        };
      }

      if (expiredInvoice.status === "PENDING" || expiredInvoice.status === "PARTIAL") {
        return {
          state: "pending",
          invoice: expiredInvoice,
          transactionsScanned: transactions.length,
          match: null
        };
      }

      if (expiredInvoice.status !== "EXPIRED") {
        return {
          state: "not-payable",
          invoice: expiredInvoice,
          transactionsScanned: transactions.length,
          match: null
        };
      }

      return {
        state: "expired",
        invoice: expiredInvoice,
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

  const expectedAmountNano = ceilNanoTonToPaymentUnit(invoice.amountNano);

  if (BigInt(paidNano) >= BigInt(expectedAmountNano)) {
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

    if (paidInvoice.status !== "PAID") {
      return {
        state: paidInvoice.status === "PENDING" || paidInvoice.status === "PARTIAL"
          ? "pending"
          : "not-payable",
        invoice: paidInvoice,
        transactionsScanned: transactions.length,
        match: lastEligibleMatch
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

      if (!expiredInvoice) {
        return {
          state: "not-payable",
          invoice,
          transactionsScanned: transactions.length,
          match: null
        };
      }

      if (expiredInvoice.status === "PAID") {
        return {
          state: "paid",
          invoice: expiredInvoice,
          transactionsScanned: transactions.length,
          match: lastEligibleMatch
        };
      }

      if (expiredInvoice.status === "PENDING" || expiredInvoice.status === "PARTIAL") {
        return {
          state: "pending",
          invoice: expiredInvoice,
          transactionsScanned: transactions.length,
          match: lastEligibleMatch
        };
      }

      if (expiredInvoice.status !== "EXPIRED") {
        return {
          state: "not-payable",
          invoice: expiredInvoice,
          transactionsScanned: transactions.length,
          match: null
        };
      }

      return {
        state: "expired",
        invoice: expiredInvoice,
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

    if (!partialInvoice) {
      return {
        state: "not-payable",
        invoice,
        transactionsScanned: transactions.length,
        match: null
      };
    }

    if (partialInvoice.status === "PAID") {
      return {
        state: "paid",
        invoice: partialInvoice,
        transactionsScanned: transactions.length,
        match: lastEligibleMatch
      };
    }

    if (partialInvoice.status !== "PENDING" && partialInvoice.status !== "PARTIAL") {
      return {
        state: "not-payable",
        invoice: partialInvoice,
        transactionsScanned: transactions.length,
        match: null
      };
    }

    return {
      state: "pending",
      invoice: partialInvoice,
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
    const asset = parsePaymentAsset(parsed.data.asset ?? paymentAssets.GRAM.symbol);
    assertNetworkAllowed(network);

    const reusableInvoice = await deps.repository.findReusableInvoice({
      externalId: parsed.data.externalId,
      network,
      amountCents,
      currency
    });

    if (reusableInvoice) {
      if (reusableInvoice.status === "PAID") {
        return {
          status: 200,
          body: {
            ok: true,
            reused: true,
            finalized: true,
            invoice: serializeInvoice(reusableInvoice),
            transactionsScanned: 0,
            match: null
          }
        };
      }

      const settled = await settleTonhubInvoiceWithConfiguredSource({
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

    if (!deps.checkoutAssetAvailable(asset.symbol, network)) {
      return {
        status: 400,
        body: {
          errorCode: "TON_INVOICE_ASSET_UNAVAILABLE",
          error: `${asset.label} is not available for ${network} checkout.`,
        },
      };
    }

    const createdAt = deps.now();
    let quote: TonhubRateQuote;
    if (asset.symbol === paymentAssets.USDT.symbol) {
      const snapshot = await deps.findRateSnapshot({
        asset: "USDT",
        quoteCurrency: currency,
        at: createdAt,
        maxAgeMs: deps.rateSnapshotMaxAgeMs(),
      });
      if (!snapshot) {
        throw new Error(`No fresh USDT/${currency} rate snapshot is available.`);
      }
      const amountAtomic = ceilAssetAtomicFromFiat({
        amountCents,
        fiatPerAsset: snapshot.price,
        asset: paymentAssets.USDT,
      });
      quote = {
        source: "usd-peg",
        rateSnapshotId: snapshot.id,
        asset: paymentAssets.USDT.symbol,
        assetDecimals: paymentAssets.USDT.decimals,
        fiatPerAsset: Number(snapshot.price),
        amountAtomic,
        amountFormatted: formatCheckoutAssetAmount(amountAtomic, paymentAssets.USDT),
        fiatAmountCents: amountCents,
        fiatAmount: amountCents / 100,
        fiatCurrency: currency,
        updatedAt: snapshot.observedAt,
        fetchedAt: snapshot.fetchedAt,
      };
    } else {
      const rate = await deps.fetchTonFiatRate(currency);
      const amountNano = ceilTonAmountNanoFromFiat({
        amountCents,
        fiatPerTon: rate.fiatPerTon
      });
      quote = {
        source: "coingecko",
        asset: paymentAssets.GRAM.symbol,
        assetDecimals: paymentAssets.GRAM.decimals,
        fiatPerAsset: rate.fiatPerTon,
        amountAtomic: amountNano,
        amountFormatted: formatPaymentNanoTon(amountNano),
        fiatAmountCents: amountCents,
        fiatAmount: amountCents / 100,
        fiatCurrency: currency,
        fiatPerGram: rate.fiatPerTon,
        fiatPerTon: rate.fiatPerTon,
        amountNano,
        amountGram: formatPaymentNanoTon(amountNano),
        amountTon: formatPaymentNanoTon(amountNano),
        updatedAt: rate.updatedAt,
        fetchedAt: rate.fetchedAt
      };
    }
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
      priceLockedUntil: addMinutes(createdAt, invoiceTtlMinutes()),
      activationThresholdFiatMicros: deps.movementSettlementEnabled()
        ? calculateActivationThresholdFiatMicros({
            orderFiatMicros: (BigInt(amountCents) * BigInt(10_000)).toString(),
            merchantNetworkFeeFiatMicros: partialMerchantNetworkFeeFiatMicros(currency),
          })
        : "0",
    });

    return {
      status: 200,
      body: {
        ok: true,
        invoice: serializeInvoice(invoice, quote)
      }
    };
  } catch (error) {
    if (error instanceof TonhubOrderTermsMismatchError || error instanceof TonhubOrderNotRetryableError) {
      return {
        status: 409,
        body: {
          errorCode: error.code,
          error: error.message
        }
      };
    }

    return {
      status: 503,
      body: {
        errorCode: "TON_INVOICE_CREATE_FAILED",
        error: error instanceof Error ? error.message : `Unable to create ${gramAsset.label} invoice.`
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

    const settled = await settleTonhubInvoiceWithConfiguredSource({
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
        error: error instanceof Error ? error.message : `Unable to check ${gramAsset.label} invoice.`
      }
    };
  }
}

