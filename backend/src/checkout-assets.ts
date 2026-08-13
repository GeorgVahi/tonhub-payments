import { parsePaymentAsset, paymentAssets, type PaymentAssetSymbol } from "../../shared/payment-assets";
import type { TonNetwork } from "./ton/direct-payments";

export type CheckoutAssetPolicy = {
  usdtMainnetEnabled: boolean;
  defaultAsset: PaymentAssetSymbol;
  checkoutAssets: PaymentAssetSymbol[];
  defaultAssetByNetwork: Record<TonNetwork, PaymentAssetSymbol>;
  checkoutAssetsByNetwork: Record<TonNetwork, PaymentAssetSymbol[]>;
};

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

export function resolveCheckoutAssetPolicy(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): CheckoutAssetPolicy {
  const checkoutRequested = booleanEnv(env, "TON_USDT_MAINNET_CHECKOUT_ENABLED");
  const observerEnabled = booleanEnv(env, "TON_USDT_MAINNET_ADAPTER_ENABLED");
  const movementSettlementEnabled = booleanEnv(env, "TON_MOVEMENT_SETTLEMENT_ENABLED");
  const settlementMode = String(env.TON_GRAM_SETTLEMENT_MODE ?? "ledger").trim().toLowerCase();
  if (!["ledger", "compare", "legacy"].includes(settlementMode)) {
    throw new Error("TON_GRAM_SETTLEMENT_MODE must be ledger, compare, or legacy.");
  }
  const usdtMainnetEnabled = checkoutRequested && observerEnabled && movementSettlementEnabled && settlementMode !== "legacy";
  const mainnetAssets: PaymentAssetSymbol[] = usdtMainnetEnabled ? ["USDT", "GRAM"] : ["GRAM"];

  return {
    usdtMainnetEnabled,
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
) {
  const asset = parsePaymentAsset(assetInput);
  return resolveCheckoutAssetPolicy(env).checkoutAssetsByNetwork[network].includes(asset.symbol);
}

export function defaultCheckoutAssetForNetwork(
  network: TonNetwork,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
) {
  return resolveCheckoutAssetPolicy(env).defaultAssetByNetwork[network] ?? paymentAssets.GRAM.symbol;
}
