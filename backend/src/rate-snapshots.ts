import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { intEnv, parseFiatCurrency, type FiatCurrency } from "./config";
import { fetchTonFiatRate, type TonFiatRate } from "./rates";
import { parsePaymentAsset, paymentAssets, type PaymentAssetSymbol } from "../../shared/payment-assets";

export type RateSnapshotSource = "coingecko" | "usd-peg";

export type RateSnapshotDraft = {
  asset: PaymentAssetSymbol;
  baseCurrency: PaymentAssetSymbol;
  quoteCurrency: FiatCurrency;
  price: string;
  source: RateSnapshotSource;
  observedAt: Date;
  fetchedAt: Date;
  payload: unknown;
};

export type RateSnapshotRecord = RateSnapshotDraft & {
  id: string;
  createdAt: Date;
};

type DerivedComponentEvidence = {
  snapshotId: string;
  quoteCurrency: FiatCurrency;
  price: string;
  observedAt: string;
  fetchedAt: string;
  source: "coingecko";
};

type UsdtEurEvidence = {
  policy: "1 USDT = 1 USD";
  derivation: "GRAM/EUR divided by GRAM/USD";
  components: {
    gramEur: DerivedComponentEvidence;
    gramUsd: DerivedComponentEvidence;
  };
};

type PrismaLike = {
  $transaction: <T>(handler: (tx: PrismaLike) => Promise<T>) => Promise<T>;
  tonhubRateSnapshot: any;
};

export type RateSnapshotRepository = {
  recordMany: (drafts: RateSnapshotDraft[]) => Promise<RateSnapshotRecord[]>;
  findAt: (input: {
    asset: PaymentAssetSymbol;
    quoteCurrency: FiatCurrency;
    at: Date;
    maxAgeMs: number;
  }) => Promise<RateSnapshotRecord | null>;
};

function validDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

export function normalizeRatePrice(value: string) {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
    throw new Error("Rate price must be a positive decimal string.");
  }
  const [wholeInput, fractionInput = ""] = trimmed.split(".");
  const whole = wholeInput.replace(/^0+(?=\d)/, "");
  const fraction = fractionInput.replace(/0+$/, "");
  if (whole.length > 18 || fraction.length > 18) {
    throw new Error("Rate price must fit Decimal(36,18).");
  }
  const normalized = `${whole || "0"}${fraction ? `.${fraction}` : ""}`;
  if (BigInt(`${whole || "0"}${fraction.padEnd(18, "0")}`) <= BigInt(0)) {
    throw new Error("Rate price must be greater than zero.");
  }
  return normalized;
}

function expandScientificDecimal(value: string) {
  const [coefficient, exponentText] = value.toLowerCase().split("e");
  if (exponentText === undefined) {
    return value;
  }
  const exponent = Number.parseInt(exponentText, 10);
  const [whole, fraction = ""] = coefficient.split(".");
  const digits = `${whole}${fraction}`;
  const decimalIndex = whole.length + exponent;
  if (decimalIndex <= 0) {
    return `0.${"0".repeat(-decimalIndex)}${digits}`;
  }
  if (decimalIndex >= digits.length) {
    return `${digits}${"0".repeat(decimalIndex - digits.length)}`;
  }
  return `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

export function finiteNumberToRatePrice(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Rate price must be a positive finite number.");
  }
  return normalizeRatePrice(expandScientificDecimal(value.toString()));
}

function decimalParts(value: string) {
  const normalized = normalizeRatePrice(value);
  const [whole, fraction = ""] = normalized.split(".");
  return {
    coefficient: BigInt(`${whole}${fraction}`),
    scale: fraction.length,
  };
}

export function divideRatePrices(numerator: string, denominator: string, fractionDigits = 18) {
  if (!Number.isInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 18) {
    throw new Error("Rate division precision must be between 0 and 18 digits.");
  }
  const left = decimalParts(numerator);
  const right = decimalParts(denominator);
  const scaledNumerator = left.coefficient * (BigInt(10) ** BigInt(right.scale + fractionDigits));
  const scaledDenominator = right.coefficient * (BigInt(10) ** BigInt(left.scale));
  const rounded = (scaledNumerator + scaledDenominator / BigInt(2)) / scaledDenominator;
  const unit = BigInt(10) ** BigInt(fractionDigits);
  const whole = rounded / unit;
  const fraction = (rounded % unit).toString().padStart(fractionDigits, "0").replace(/0+$/, "");
  return normalizeRatePrice(`${whole.toString()}${fraction ? `.${fraction}` : ""}`);
}

function objectValue(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function parseEvidenceDate(value: unknown, field: string) {
  if (typeof value !== "string") {
    throw new Error(`USDT/EUR provenance ${field} must be an ISO timestamp.`);
  }
  const parsed = new Date(value);
  if (!validDate(parsed) || parsed.toISOString() !== value) {
    throw new Error(`USDT/EUR provenance ${field} must be an ISO timestamp.`);
  }
  return parsed;
}

function parseDerivedComponent(
  value: unknown,
  quoteCurrency: FiatCurrency,
  field: string,
): DerivedComponentEvidence {
  const component = objectValue(value, `USDT/EUR provenance ${field} is required.`);
  if (typeof component.snapshotId !== "string" || !component.snapshotId.trim()) {
    throw new Error(`USDT/EUR provenance ${field}.snapshotId is required.`);
  }
  if (component.quoteCurrency !== quoteCurrency || component.source !== "coingecko") {
    throw new Error(`USDT/EUR provenance ${field} must reference GRAM/${quoteCurrency} from coingecko.`);
  }
  const price = normalizeRatePrice(String(component.price ?? ""));
  const observedAt = parseEvidenceDate(component.observedAt, `${field}.observedAt`);
  const fetchedAt = parseEvidenceDate(component.fetchedAt, `${field}.fetchedAt`);
  if (observedAt.getTime() > fetchedAt.getTime()) {
    throw new Error(`USDT/EUR provenance ${field} observedAt cannot be later than fetchedAt.`);
  }
  return {
    snapshotId: component.snapshotId,
    quoteCurrency,
    price,
    observedAt: observedAt.toISOString(),
    fetchedAt: fetchedAt.toISOString(),
    source: "coingecko",
  };
}

function parseUsdtEurEvidence(value: unknown): UsdtEurEvidence {
  const payload = objectValue(value, "USDT/EUR provenance payload is required.");
  if (
    payload.policy !== "1 USDT = 1 USD" ||
    payload.derivation !== "GRAM/EUR divided by GRAM/USD"
  ) {
    throw new Error("USDT/EUR provenance policy and derivation are required.");
  }
  const components = objectValue(payload.components, "USDT/EUR provenance components are required.");
  const gramEur = parseDerivedComponent(components.gramEur, "EUR", "gramEur");
  const gramUsd = parseDerivedComponent(components.gramUsd, "USD", "gramUsd");
  if (gramEur.snapshotId === gramUsd.snapshotId) {
    throw new Error("USDT/EUR provenance must reference two distinct component snapshots.");
  }
  return {
    policy: "1 USDT = 1 USD",
    derivation: "GRAM/EUR divided by GRAM/USD",
    components: { gramEur, gramUsd },
  };
}

function validateDraft(draft: RateSnapshotDraft) {
  const asset = parsePaymentAsset(draft.asset);
  if (draft.baseCurrency !== asset.symbol) {
    throw new Error(`Rate base currency for ${asset.symbol} must equal the asset symbol.`);
  }
  if (draft.quoteCurrency !== "USD" && draft.quoteCurrency !== "EUR") {
    throw new Error("Rate quote currency must be EUR or USD.");
  }
  if (!validDate(draft.observedAt) || !validDate(draft.fetchedAt)) {
    throw new Error("Rate timestamps must be valid dates.");
  }
  if (draft.observedAt.getTime() > draft.fetchedAt.getTime()) {
    throw new Error("Rate observedAt cannot be later than fetchedAt.");
  }
  if (draft.source !== "coingecko" && draft.source !== "usd-peg") {
    throw new Error(`Unsupported rate source: ${draft.source}.`);
  }
  const expectedSource: RateSnapshotSource = asset.pricingStrategy === "MARKET"
    ? "coingecko"
    : "usd-peg";
  if (draft.source !== expectedSource) {
    throw new Error(`Rate source for ${asset.symbol} must be ${expectedSource}.`);
  }
  const price = normalizeRatePrice(draft.price);
  let payload = draft.payload;
  if (asset.symbol === "USDT" && draft.quoteCurrency === "USD") {
    const peg = objectValue(draft.payload, "USDT/USD peg policy payload is required.");
    if (price !== "1" || peg.policy !== "1 USDT = 1 USD") {
      throw new Error("USDT/USD snapshots must enforce the exact 1 USDT = 1 USD policy.");
    }
  }
  if (asset.symbol === "USDT" && draft.quoteCurrency === "EUR") {
    const evidence = parseUsdtEurEvidence(draft.payload);
    const componentObservedAt = Math.max(
      Date.parse(evidence.components.gramEur.observedAt),
      Date.parse(evidence.components.gramUsd.observedAt),
    );
    const componentFetchedAt = Math.max(
      Date.parse(evidence.components.gramEur.fetchedAt),
      Date.parse(evidence.components.gramUsd.fetchedAt),
    );
    if (draft.observedAt.getTime() !== componentObservedAt) {
      throw new Error("USDT/EUR observedAt must equal the newer component observation.");
    }
    if (draft.fetchedAt.getTime() < componentFetchedAt) {
      throw new Error("USDT/EUR fetchedAt cannot be earlier than its components.");
    }
    if (price !== divideRatePrices(evidence.components.gramEur.price, evidence.components.gramUsd.price)) {
      throw new Error("USDT/EUR price must equal the recorded GRAM cross-rate.");
    }
    payload = evidence;
  }
  return {
    ...draft,
    asset: asset.symbol,
    baseCurrency: asset.symbol,
    price,
    payload,
  };
}

export function normalizeRateSnapshotRecord(value: any): RateSnapshotRecord {
  const draft = validateDraft({
    asset: value.asset,
    baseCurrency: value.baseCurrency,
    quoteCurrency: value.quoteCurrency,
    price: value.price.toString(),
    source: value.source,
    observedAt: value.observedAt,
    fetchedAt: value.fetchedAt,
    payload: value.payload ?? null,
  });
  if (typeof value.id !== "string" || !validDate(value.createdAt)) {
    throw new Error("Stored rate snapshot has invalid identity or creation time.");
  }
  return {
    ...draft,
    id: value.id,
    createdAt: value.createdAt,
  };
}

function snapshotKey(value: Pick<RateSnapshotDraft, "asset" | "baseCurrency" | "quoteCurrency" | "source" | "observedAt">) {
  return [value.asset, value.baseCurrency, value.quoteCurrency, value.source, value.observedAt.toISOString()].join(":");
}

function derivedEvidence(draft: RateSnapshotDraft) {
  return draft.asset === "USDT" && draft.quoteCurrency === "EUR"
    ? parseUsdtEurEvidence(draft.payload)
    : null;
}

function componentEvidence(record: RateSnapshotRecord): DerivedComponentEvidence {
  if (record.asset !== "GRAM" || record.source !== "coingecko") {
    throw new Error("USDT/EUR can only derive from stored GRAM market snapshots.");
  }
  return {
    snapshotId: record.id,
    quoteCurrency: record.quoteCurrency,
    price: record.price,
    observedAt: record.observedAt.toISOString(),
    fetchedAt: record.fetchedAt.toISOString(),
    source: "coingecko",
  };
}

async function assertDerivedComponents(tx: PrismaLike, drafts: RateSnapshotDraft[]) {
  const evidence = drafts.map(derivedEvidence).filter((value): value is UsdtEurEvidence => value !== null);
  if (evidence.length === 0) {
    return;
  }
  const componentIds = Array.from(new Set(evidence.flatMap(({ components }) => [
    components.gramEur.snapshotId,
    components.gramUsd.snapshotId,
  ])));
  const rows = await tx.tonhubRateSnapshot.findMany({
    where: { OR: componentIds.map((id) => ({ id })) },
  });
  const byId = new Map<string, RateSnapshotRecord>(
    rows.map((row: any) => [row.id, normalizeRateSnapshotRecord(row)]),
  );
  for (const item of evidence) {
    for (const component of [item.components.gramEur, item.components.gramUsd]) {
      const stored = byId.get(component.snapshotId);
      if (
        !stored ||
        stored.asset !== "GRAM" ||
        stored.quoteCurrency !== component.quoteCurrency ||
        stored.source !== component.source ||
        stored.price !== component.price ||
        stored.observedAt.toISOString() !== component.observedAt ||
        stored.fetchedAt.toISOString() !== component.fetchedAt
      ) {
        throw new Error(`USDT/EUR component snapshot does not match stored evidence: ${component.snapshotId}.`);
      }
    }
  }
}

export function createPrismaRateSnapshotRepository(db: PrismaLike): RateSnapshotRepository {
  return {
    recordMany: async (inputDrafts) => {
      if (inputDrafts.length === 0) {
        return [];
      }
      const drafts = inputDrafts.map(validateDraft);
      const uniqueDrafts = Array.from(new Map(drafts.map((draft) => [snapshotKey(draft), draft])).values());
      return db.$transaction(async (tx) => {
        await tx.tonhubRateSnapshot.createMany({
          data: uniqueDrafts.map((draft) => ({
            ...draft,
            payload: draft.payload === null || draft.payload === undefined
              ? Prisma.DbNull
              : draft.payload as Prisma.InputJsonValue,
          })),
          skipDuplicates: true,
        });
        const stored = await tx.tonhubRateSnapshot.findMany({
          where: {
            OR: uniqueDrafts.map((draft) => ({
              asset: draft.asset,
              baseCurrency: draft.baseCurrency,
              quoteCurrency: draft.quoteCurrency,
              source: draft.source,
              observedAt: draft.observedAt,
            })),
          },
        });
        const storedRecords: RateSnapshotRecord[] = (stored as any[])
          .map((value) => normalizeRateSnapshotRecord(value));
        await assertDerivedComponents(tx, storedRecords);
        const byKey = new Map<string, RateSnapshotRecord>(
          storedRecords.map((value) => [snapshotKey(value), value]),
        );
        return uniqueDrafts.map((draft) => {
          const record = byKey.get(snapshotKey(draft));
          if (!record) {
            throw new Error(`Rate snapshot was not persisted: ${snapshotKey(draft)}.`);
          }
          return record;
        });
      });
    },
    findAt: async ({ asset: assetInput, quoteCurrency, at, maxAgeMs }) => {
      const asset = parsePaymentAsset(assetInput);
      const quote = parseFiatCurrency(quoteCurrency);
      if (!validDate(at)) {
        throw new Error("Rate lookup time must be a valid date.");
      }
      if (!Number.isInteger(maxAgeMs) || maxAgeMs < 0) {
        throw new Error("Rate maxAgeMs must be a non-negative integer.");
      }
      const value = await db.tonhubRateSnapshot.findFirst({
        where: {
          asset: asset.symbol,
          baseCurrency: asset.symbol,
          quoteCurrency: quote,
          source: asset.pricingStrategy === "MARKET" ? "coingecko" : "usd-peg",
          observedAt: { lte: at },
        },
        orderBy: [{ observedAt: "desc" }, { fetchedAt: "desc" }, { createdAt: "desc" }],
      });
      if (!value) {
        return null;
      }
      const record = normalizeRateSnapshotRecord(value);
      return at.getTime() - record.observedAt.getTime() <= maxAgeMs ? record : null;
    },
  };
}

export const prismaRateSnapshotRepository = createPrismaRateSnapshotRepository(
  prisma as unknown as PrismaLike,
);

export function rateSnapshotMaxAgeMs() {
  return intEnv("TON_RATE_SNAPSHOT_MAX_AGE_SECONDS", 300, { min: 30, max: 3600 }) * 1000;
}

type RefreshError = {
  asset: PaymentAssetSymbol;
  quoteCurrency: FiatCurrency;
  error: string;
};

export async function refreshPaymentRateSnapshots(input: {
  repository?: RateSnapshotRepository;
  fetchGramRate?: (currency: FiatCurrency) => Promise<TonFiatRate>;
  currencies?: readonly FiatCurrency[];
  now?: () => Date;
  maxProviderAgeMs?: number;
}) {
  const repository = input.repository ?? prismaRateSnapshotRepository;
  const fetchGramRate = input.fetchGramRate ?? ((currency) => fetchTonFiatRate(currency));
  const currencies = Array.from(new Set(
    (input.currencies ?? ["USD", "EUR"]).map((currency) => parseFiatCurrency(currency)),
  ));
  const requested = new Set(currencies);
  const marketCurrencies = new Set(currencies);
  if (requested.has("EUR")) {
    marketCurrencies.add("USD");
  }
  const now = input.now ?? (() => new Date());
  const maxProviderAgeMs = input.maxProviderAgeMs ?? rateSnapshotMaxAgeMs();
  if (!Number.isInteger(maxProviderAgeMs) || maxProviderAgeMs < 0) {
    throw new Error("maxProviderAgeMs must be a non-negative integer.");
  }
  const errors: RefreshError[] = [];
  const gramRates = new Map<FiatCurrency, { rate: TonFiatRate; price: string }>();

  const fetchedRates = await Promise.all(Array.from(marketCurrencies, async (currency) => {
    try {
      const rate = await fetchGramRate(currency);
      if (rate.source !== "coingecko" || rate.currency !== currency) {
        throw new Error(`provider returned a mismatched ${rate.currency} rate`);
      }
      const observedAt = rate.updatedAt ?? rate.fetchedAt;
      if (!validDate(observedAt) || !validDate(rate.fetchedAt)) {
        throw new Error("provider returned invalid timestamps");
      }
      if (observedAt.getTime() > rate.fetchedAt.getTime()) {
        throw new Error("provider observedAt is later than fetchedAt");
      }
      return { currency, rate, price: finiteNumberToRatePrice(rate.fiatPerTon) };
    } catch (error) {
      errors.push({
        asset: paymentAssets.GRAM.symbol,
        quoteCurrency: currency,
        error: error instanceof Error ? error.message : "unknown rate provider error",
      });
      return null;
    }
  }));
  const refreshedAt = now();
  if (!validDate(refreshedAt)) {
    throw new Error("Rate refresh time must be a valid date.");
  }
  for (const result of fetchedRates) {
    if (!result) {
      continue;
    }
    const observedAt = result.rate.updatedAt ?? result.rate.fetchedAt;
    if (result.rate.fetchedAt.getTime() > refreshedAt.getTime()) {
      errors.push({
        asset: paymentAssets.GRAM.symbol,
        quoteCurrency: result.currency,
        error: "provider fetchedAt is later than refresh completion",
      });
      continue;
    }
    if (refreshedAt.getTime() - observedAt.getTime() > maxProviderAgeMs) {
      errors.push({
        asset: paymentAssets.GRAM.symbol,
        quoteCurrency: result.currency,
        error: `provider rate is older than ${maxProviderAgeMs}ms`,
      });
      continue;
    }
    gramRates.set(result.currency, { rate: result.rate, price: result.price });
  }

  const gramDrafts: RateSnapshotDraft[] = [];
  for (const currency of marketCurrencies) {
    const gramRate = gramRates.get(currency);
    if (gramRate) {
      const { rate, price } = gramRate;
      gramDrafts.push({
        asset: paymentAssets.GRAM.symbol,
        baseCurrency: paymentAssets.GRAM.symbol,
        quoteCurrency: currency,
        price,
        source: "coingecko",
        observedAt: rate.updatedAt ?? rate.fetchedAt,
        fetchedAt: rate.fetchedAt,
        payload: {
          provider: "coingecko",
          providerAssetId: "the-open-network",
        },
      });
    }
  }
  const gramSnapshots = await repository.recordMany(gramDrafts);
  const gramSnapshotsByCurrency = new Map(
    gramSnapshots.map((snapshot) => [snapshot.quoteCurrency, snapshot]),
  );
  const pegDrafts: RateSnapshotDraft[] = [];

  if (requested.has("USD")) {
    pegDrafts.push({
      asset: paymentAssets.USDT.symbol,
      baseCurrency: paymentAssets.USDT.symbol,
      quoteCurrency: "USD",
      price: "1",
      source: "usd-peg",
      observedAt: refreshedAt,
      fetchedAt: refreshedAt,
      payload: { policy: "1 USDT = 1 USD" },
    });
  }

  if (requested.has("EUR")) {
    const gramEur = gramSnapshotsByCurrency.get("EUR");
    const gramUsd = gramSnapshotsByCurrency.get("USD");
    if (gramEur && gramUsd) {
      const eurPrice = gramEur.price;
      const usdPrice = gramUsd.price;
      const observedAt = new Date(Math.max(
        gramEur.observedAt.getTime(),
        gramUsd.observedAt.getTime(),
      ));
      pegDrafts.push({
        asset: paymentAssets.USDT.symbol,
        baseCurrency: paymentAssets.USDT.symbol,
        quoteCurrency: "EUR",
        price: divideRatePrices(eurPrice, usdPrice),
        source: "usd-peg",
        observedAt,
        fetchedAt: refreshedAt,
        payload: {
          policy: "1 USDT = 1 USD",
          derivation: "GRAM/EUR divided by GRAM/USD",
          components: {
            gramEur: componentEvidence(gramEur),
            gramUsd: componentEvidence(gramUsd),
          },
        },
      });
    } else {
      errors.push({
        asset: paymentAssets.USDT.symbol,
        quoteCurrency: "EUR",
        error: "USD/EUR cross-rate inputs are unavailable",
      });
    }
  }

  const pegSnapshots = await repository.recordMany(pegDrafts);
  const snapshots = [...gramSnapshots, ...pegSnapshots];
  return {
    ok: errors.length === 0,
    snapshots,
    errors,
  };
}
