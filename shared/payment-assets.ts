export type PaymentAssetSymbol = "GRAM" | "USDT";
export type PaymentAssetKind = "NATIVE" | "JETTON";
export type PaymentAssetPricingStrategy = "MARKET" | "USD_PEG";

export type PaymentAssetDefinition = Readonly<{
  symbol: PaymentAssetSymbol;
  label: string;
  network: "TON";
  kind: PaymentAssetKind;
  decimals: number;
  checkoutFractionDigits: number;
  pricingStrategy: PaymentAssetPricingStrategy;
  legacyAliases: readonly string[];
}>;

const definitions = {
  GRAM: Object.freeze({
    symbol: "GRAM",
    label: "GRAM (ex TON)",
    network: "TON",
    kind: "NATIVE",
    decimals: 9,
    checkoutFractionDigits: 2,
    pricingStrategy: "MARKET",
    legacyAliases: Object.freeze(["TON"]),
  }),
  USDT: Object.freeze({
    symbol: "USDT",
    label: "USD₮",
    network: "TON",
    kind: "JETTON",
    decimals: 6,
    checkoutFractionDigits: 2,
    pricingStrategy: "USD_PEG",
    legacyAliases: Object.freeze([]),
  }),
} as const satisfies Record<PaymentAssetSymbol, PaymentAssetDefinition>;

export const paymentAssets: Readonly<Record<PaymentAssetSymbol, PaymentAssetDefinition>> =
  Object.freeze(definitions);

const assetsByInput = new Map<string, PaymentAssetDefinition>();
for (const asset of Object.values(paymentAssets)) {
  assetsByInput.set(asset.symbol, asset);
  for (const alias of asset.legacyAliases) {
    assetsByInput.set(alias, asset);
  }
}

function atomicAmount(value: string | bigint) {
  if (typeof value === "bigint") {
    if (value < BigInt(0)) {
      throw new Error("Atomic amount must be a non-negative integer.");
    }
    return value;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error("Atomic amount must be a non-negative integer string.");
  }
  return BigInt(value);
}

function powerOfTen(exponent: number) {
  return BigInt(10) ** BigInt(exponent);
}

export function listPaymentAssets(): readonly PaymentAssetDefinition[] {
  return Object.freeze(Object.values(paymentAssets));
}

export function parsePaymentAsset(value: unknown): PaymentAssetDefinition {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Payment asset is required.");
  }
  const asset = assetsByInput.get(value.trim().toUpperCase());
  if (!asset) {
    throw new Error(`Unsupported payment asset: ${value.trim()}.`);
  }
  return asset;
}

export function assertPaymentAssetSnapshot(
  asset: PaymentAssetDefinition,
  snapshot: { kind?: string | null; decimals?: number | null },
) {
  if (snapshot.kind !== undefined && snapshot.kind !== null && snapshot.kind !== asset.kind) {
    throw new Error(`Stored ${asset.symbol} kind ${snapshot.kind} does not match registry kind ${asset.kind}.`);
  }
  if (
    snapshot.decimals !== undefined &&
    snapshot.decimals !== null &&
    snapshot.decimals !== asset.decimals
  ) {
    throw new Error(
      `Stored ${asset.symbol} decimals ${snapshot.decimals} do not match registry decimals ${asset.decimals}.`,
    );
  }
  return asset;
}

export function paymentUnitAtomic(assetInput: PaymentAssetDefinition | PaymentAssetSymbol) {
  const asset = typeof assetInput === "string" ? paymentAssets[assetInput] : assetInput;
  return powerOfTen(asset.decimals - asset.checkoutFractionDigits);
}

export function ceilAtomicToPaymentUnit(
  value: string | bigint,
  assetInput: PaymentAssetDefinition | PaymentAssetSymbol,
) {
  const amount = atomicAmount(value);
  if (amount === BigInt(0)) {
    return "0";
  }
  const step = paymentUnitAtomic(assetInput);
  return (((amount + step - BigInt(1)) / step) * step).toString();
}

export function parseAssetAmountToAtomic(
  value: string,
  assetInput: PaymentAssetDefinition | PaymentAssetSymbol,
) {
  const asset = typeof assetInput === "string" ? paymentAssets[assetInput] : assetInput;
  const trimmed = value.trim();
  const pattern = new RegExp(`^\\d+(?:\\.\\d{1,${asset.decimals}})?$`);
  if (!pattern.test(trimmed)) {
    throw new Error(`${asset.label} amount must be a positive decimal with up to ${asset.decimals} fractional digits.`);
  }
  const [wholeText, fractionalText = ""] = trimmed.split(".");
  const amount = BigInt(wholeText) * powerOfTen(asset.decimals) +
    BigInt(fractionalText.padEnd(asset.decimals, "0"));
  if (amount <= BigInt(0)) {
    throw new Error(`${asset.label} amount must be greater than zero.`);
  }
  return amount.toString();
}

export function formatAssetAmount(
  value: string | bigint,
  assetInput: PaymentAssetDefinition | PaymentAssetSymbol,
  options: { fixedFractionDigits?: number } = {},
) {
  const asset = typeof assetInput === "string" ? paymentAssets[assetInput] : assetInput;
  const amount = atomicAmount(value);
  const unit = powerOfTen(asset.decimals);
  const whole = amount / unit;
  const fractional = amount % unit;
  const fullFraction = fractional.toString().padStart(asset.decimals, "0");
  let fractionalText: string;

  if (options.fixedFractionDigits === undefined) {
    fractionalText = fullFraction.replace(/0+$/, "");
  } else {
    const digits = options.fixedFractionDigits;
    if (!Number.isInteger(digits) || digits < 0 || digits > asset.decimals) {
      throw new Error(`Fraction digits for ${asset.symbol} must be between 0 and ${asset.decimals}.`);
    }
    if (/[^0]/.test(fullFraction.slice(digits))) {
      throw new Error(`Atomic amount cannot be represented exactly with ${digits} ${asset.symbol} fraction digits.`);
    }
    fractionalText = fullFraction.slice(0, digits);
  }

  return `${whole.toString()}${fractionalText ? `.${fractionalText}` : ""} ${asset.label}`;
}

export function formatCheckoutAssetAmount(
  value: string | bigint,
  assetInput: PaymentAssetDefinition | PaymentAssetSymbol,
) {
  const asset = typeof assetInput === "string" ? paymentAssets[assetInput] : assetInput;
  return formatAssetAmount(ceilAtomicToPaymentUnit(value, asset), asset, {
    fixedFractionDigits: asset.checkoutFractionDigits,
  });
}
