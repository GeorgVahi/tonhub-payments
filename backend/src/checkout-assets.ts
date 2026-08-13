import { parsePaymentAsset, paymentAssets, type PaymentAssetSymbol } from "../../shared/payment-assets";
import type { TonNetwork } from "./ton/direct-payments";

export type CheckoutAssetPolicy = {
  usdtMainnetEnabled: boolean;
  usdtMainnetCanaryEnabled: boolean;
  usdtMainnetCanaryExternalIds: readonly string[];
  defaultAsset: PaymentAssetSymbol;
  checkoutAssets: PaymentAssetSymbol[];
  defaultAssetByNetwork: Record<TonNetwork, PaymentAssetSymbol>;
  checkoutAssetsByNetwork: Record<TonNetwork, PaymentAssetSymbol[]>;
};

const maxMainnetCanaryOrders = 20;

function booleanEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  name: string,
) {
  const value = String(env[name] ?? "false").trim().toLowerCase();
  if (value === "true") {
    return true;
  }
  if (value === "false" || value === "") {
    return false;
  }
  throw new Error(`${name} must be true or false.`);
}

function mainnetCanaryExternalIds(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  const raw = String(env.TON_USDT_MAINNET_CANARY_EXTERNAL_IDS ?? "").trim();
  if (!raw) return [];
  const values = raw.split(",").map((value) => value.trim());
  if (values.some((value) => !value)) {
    throw new Error("TON_USDT_MAINNET_CANARY_EXTERNAL_IDS must contain only non-empty comma-separated values.");
  }
  if (values.some((value) => value.length > 120)) {
    throw new Error("TON_USDT_MAINNET_CANARY_EXTERNAL_IDS values cannot exceed 120 characters.");
  }
  if (new Set(values).size !== values.length) {
    throw new Error("TON_USDT_MAINNET_CANARY_EXTERNAL_IDS values must be unique.");
  }
  if (values.length > maxMainnetCanaryOrders) {
    throw new Error(`TON_USDT_MAINNET_CANARY_EXTERNAL_IDS can contain at most ${maxMainnetCanaryOrders} orders.`);
  }
  return values;
}

export function resolveCheckoutAssetPolicy(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): CheckoutAssetPolicy {
  const checkoutRequested = booleanEnv(env, "TON_USDT_MAINNET_CHECKOUT_ENABLED");
  const observerEnabled = booleanEnv(env, "TON_USDT_MAINNET_ADAPTER_ENABLED");
  const movementSettlementEnabled = booleanEnv(env, "TON_MOVEMENT_SETTLEMENT_ENABLED");
  const canaryExternalIds = mainnetCanaryExternalIds(env);
  const settlementMode = String(env.TON_GRAM_SETTLEMENT_MODE ?? "ledger").trim().toLowerCase();
  if (!["ledger", "compare", "legacy"].includes(settlementMode)) {
    throw new Error("TON_GRAM_SETTLEMENT_MODE must be ledger, compare, or legacy.");
  }
  const runtimeReady = observerEnabled && movementSettlementEnabled && settlementMode !== "legacy";
  const usdtMainnetEnabled = checkoutRequested && runtimeReady;
  const usdtMainnetCanaryEnabled = canaryExternalIds.length > 0 && runtimeReady && settlementMode === "ledger";
  const mainnetAssets: PaymentAssetSymbol[] = usdtMainnetEnabled ? ["USDT", "GRAM"] : ["GRAM"];

  return {
    usdtMainnetEnabled,
    usdtMainnetCanaryEnabled,
    usdtMainnetCanaryExternalIds: Object.freeze([...canaryExternalIds]),
    defaultAsset: usdtMainnetEnabled ? "USDT" : "GRAM",
    checkoutAssets: mainnetAssets,
    defaultAssetByNetwork: {
      testnet: "GRAM",
      mainnet: usdtMainnetEnabled ? "USDT" : "GRAM",
    },
    checkoutAssetsByNetwork: {
      testnet: ["GRAM"],
      mainnet: mainnetAssets,
    },
  };
}

export function isCheckoutAssetAvailable(
  assetInput: unknown,
  network: TonNetwork,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  externalId?: string,
) {
  const asset = parsePaymentAsset(assetInput);
  const policy = resolveCheckoutAssetPolicy(env);
  if (policy.checkoutAssetsByNetwork[network].includes(asset.symbol)) return true;
  return asset.symbol === "USDT" && network === "mainnet" &&
    policy.usdtMainnetCanaryEnabled && typeof externalId === "string" &&
    policy.usdtMainnetCanaryExternalIds.includes(externalId);
}

export function defaultCheckoutAssetForNetwork(
  network: TonNetwork,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
) {
  return resolveCheckoutAssetPolicy(env).defaultAssetByNetwork[network] ?? paymentAssets.GRAM.symbol;
}
