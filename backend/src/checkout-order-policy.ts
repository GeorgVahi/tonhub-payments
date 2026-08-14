import { parseFiatCurrency, type FiatCurrency } from "./config";

export type TonhubCheckoutOrderPolicy = Readonly<{
  minimumOrderFiatMicros: string;
  gramDiscountMaxFiatMicros: string;
  intermediateSweepTriggerBps: number;
  intermediateSweepMinFiatMicros: string;
  maxAutomaticSweepsPerAsset: number;
}>;

function exactIntegerEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const raw = String(env[name] ?? fallback).trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function centsToMicros(value: number) {
  return (BigInt(value) * BigInt(10_000)).toString();
}

export function resolveCheckoutOrderPolicy(
  currencyInput: FiatCurrency | string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): TonhubCheckoutOrderPolicy {
  const currency = parseFiatCurrency(currencyInput);
  const minimumOrderCents = exactIntegerEnv(env, `TON_MIN_ORDER_${currency}_CENTS`, 1_000, 1, 100_000_000);
  const gramDiscountMaxCents = exactIntegerEnv(
    env,
    `TON_GRAM_DISCOUNT_${currency}_CENTS`,
    100,
    0,
    100_000_000,
  );
  if (gramDiscountMaxCents >= minimumOrderCents) {
    throw new Error(`TON_GRAM_DISCOUNT_${currency}_CENTS must be less than TON_MIN_ORDER_${currency}_CENTS.`);
  }
  const intermediateSweepMinCents = exactIntegerEnv(
    env,
    `TON_INTERMEDIATE_SWEEP_MIN_${currency}_CENTS`,
    10_000,
    1,
    100_000_000,
  );

  return Object.freeze({
    minimumOrderFiatMicros: centsToMicros(minimumOrderCents),
    gramDiscountMaxFiatMicros: centsToMicros(gramDiscountMaxCents),
    intermediateSweepTriggerBps: exactIntegerEnv(
      env,
      "TON_INTERMEDIATE_SWEEP_TRIGGER_BPS",
      9_000,
      1,
      10_000,
    ),
    intermediateSweepMinFiatMicros: centsToMicros(intermediateSweepMinCents),
    maxAutomaticSweepsPerAsset: exactIntegerEnv(
      env,
      "TON_MAX_AUTOMATIC_SWEEPS_PER_ASSET",
      2,
      1,
      2,
    ),
  });
}
