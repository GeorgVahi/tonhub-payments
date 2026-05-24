import type { FiatCurrency } from "./config";

export type TonFiatRate = {
  source: "coingecko";
  currency: FiatCurrency;
  fiatPerTon: number;
  updatedAt: Date | null;
  fetchedAt: Date;
};

const rateCache = new Map<FiatCurrency, TonFiatRate & { expiresAt: number }>();
const rateCacheMs = 60_000;

export async function fetchTonFiatRate(
  currency: FiatCurrency,
  fetchImpl: typeof fetch = fetch
): Promise<TonFiatRate> {
  const now = Date.now();
  const cached = rateCache.get(currency);

  if (cached && cached.expiresAt > now) {
    return {
      source: cached.source,
      currency: cached.currency,
      fiatPerTon: cached.fiatPerTon,
      updatedAt: cached.updatedAt,
      fetchedAt: cached.fetchedAt
    };
  }

  const url = new URL("https://api.coingecko.com/api/v3/simple/price");
  url.searchParams.set("ids", "the-open-network");
  url.searchParams.set("vs_currencies", currency.toLowerCase());
  url.searchParams.set("include_last_updated_at", "true");

  const response = await fetchImpl(url, {
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`CoinGecko TON/${currency} request failed: ${response.status}`);
  }

  const body = await response.json().catch(() => null) as {
    "the-open-network"?: Record<string, unknown>;
  } | null;
  const token = body?.["the-open-network"];
  const price = token?.[currency.toLowerCase()];

  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
    throw new Error(`CoinGecko TON/${currency} response did not include a valid price.`);
  }

  const lastUpdatedAt = token?.last_updated_at;
  const fetchedAt = new Date();
  const updatedAt = typeof lastUpdatedAt === "number" ? new Date(lastUpdatedAt * 1000) : null;
  const rate: TonFiatRate & { expiresAt: number } = {
    source: "coingecko",
    currency,
    fiatPerTon: price,
    updatedAt,
    fetchedAt,
    expiresAt: now + rateCacheMs
  };

  rateCache.set(currency, rate);

  return {
    source: rate.source,
    currency: rate.currency,
    fiatPerTon: rate.fiatPerTon,
    updatedAt: rate.updatedAt,
    fetchedAt: rate.fetchedAt
  };
}

export function ceilTonAmountNanoFromFiat(input: {
  amountCents: number;
  fiatPerTon: number;
}) {
  const amountNano = Math.ceil((input.amountCents * 10_000_000) / input.fiatPerTon);

  if (!Number.isFinite(amountNano) || amountNano <= 0) {
    throw new Error("Unable to calculate TON amount from fiat price.");
  }

  return BigInt(amountNano).toString();
}

