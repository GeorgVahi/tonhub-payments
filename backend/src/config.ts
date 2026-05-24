import { parseTonNetwork, type TonNetwork } from "./ton/direct-payments";

export type FiatCurrency = "EUR" | "USD";

export function parseFiatCurrency(value: unknown): FiatCurrency {
  const normalized = String(value || "EUR").trim().toUpperCase();

  if (normalized === "EUR" || normalized === "USD") {
    return normalized;
  }

  throw new Error("Currency must be EUR or USD.");
}

export function parseAllowedNetworks(value?: string | null): TonNetwork[] {
  const raw = (value || "testnet").split(",").map((item) => item.trim()).filter(Boolean);
  const networks = raw.map((item) => parseTonNetwork(item));
  return Array.from(new Set(networks));
}

export function resolveAllowedNetworks(env: NodeJS.ProcessEnv = process.env) {
  return parseAllowedNetworks(env.TON_ALLOWED_NETWORKS || env.TON_NETWORK || "testnet");
}

export function resolveDefaultNetwork(env: NodeJS.ProcessEnv = process.env): TonNetwork {
  const fallback = resolveAllowedNetworks(env)[0] ?? "testnet";
  return parseTonNetwork(env.TON_DEFAULT_NETWORK || env.TON_NETWORK || fallback);
}

export function assertNetworkAllowed(network: TonNetwork, env: NodeJS.ProcessEnv = process.env) {
  const allowed = resolveAllowedNetworks(env);

  if (!allowed.includes(network)) {
    throw new Error(`TON network ${network} is not enabled. Set TON_ALLOWED_NETWORKS to include it.`);
  }
}

export function intEnv(name: string, fallback: number, input: { min: number; max: number }) {
  const raw = process.env[name]?.trim();
  const value = raw ? Number.parseInt(raw, 10) : fallback;

  if (!Number.isInteger(value) || value < input.min || value > input.max) {
    throw new Error(`${name} must be an integer between ${input.min} and ${input.max}.`);
  }

  return value;
}

export function parseFiatAmountToCents(value: string | number) {
  const raw = String(value).trim().replace(",", ".");

  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw new Error("Amount must be a positive decimal with up to 2 fractional digits.");
  }

  const [wholeText, fractionText = ""] = raw.split(".");
  const cents = Number.parseInt(wholeText, 10) * 100 + Number.parseInt(fractionText.padEnd(2, "0"), 10);

  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new Error("Amount must be greater than zero.");
  }

  return cents;
}

export function formatFiatCents(amountCents: number, currency: FiatCurrency) {
  return `${(amountCents / 100).toFixed(2)} ${currency}`;
}

