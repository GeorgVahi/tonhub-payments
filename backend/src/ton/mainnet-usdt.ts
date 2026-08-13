import { paymentAssets } from "../../../shared/payment-assets";
import {
  createVerifiedJettonAdapter,
  type VerifiedJettonAdapterDependencies,
  type VerifiedJettonConfig,
} from "./internal-testnet-jetton";
import { canonicalTonAddress } from "./gram-shadow-scanner";
import {
  officialMainnetUsdtMasterAddress,
  officialMainnetUsdtMasterFriendlyAddress,
} from "./jetton-identities";

if (
  canonicalTonAddress(officialMainnetUsdtMasterFriendlyAddress) !==
  officialMainnetUsdtMasterAddress
) {
  throw new Error("The compiled official mainnet USDT master address is invalid.");
}
export {
  officialMainnetUsdtMasterAddress,
  officialMainnetUsdtMasterFriendlyAddress,
};

export type MainnetUsdtAdapterConfig = VerifiedJettonConfig & {
  network: "mainnet";
};

function parseEnabled(value: unknown) {
  const normalized = String(value ?? "false").trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false" || normalized === "") {
    return false;
  }
  throw new Error("TON_USDT_MAINNET_ADAPTER_ENABLED must be true or false.");
}

export function resolveMainnetUsdtAdapterConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): MainnetUsdtAdapterConfig | null {
  if (!parseEnabled(env.TON_USDT_MAINNET_ADAPTER_ENABLED)) {
    return null;
  }
  return {
    enabled: true,
    network: "mainnet",
    masterAddress: officialMainnetUsdtMasterAddress,
    decimals: 6,
  };
}

export function createMainnetUsdtAdapter(
  dependencies: Omit<VerifiedJettonAdapterDependencies, "config"> & {
    config: MainnetUsdtAdapterConfig;
  },
) {
  if (
    dependencies.config.network !== "mainnet" ||
    dependencies.config.enabled !== true ||
    dependencies.config.decimals !== paymentAssets.USDT.decimals ||
    canonicalTonAddress(dependencies.config.masterAddress) !== officialMainnetUsdtMasterAddress
  ) {
    throw new Error("The mainnet USDT adapter requires the compiled official USDT identity.");
  }
  return createVerifiedJettonAdapter(dependencies, {
    name: "mainnet USDT adapter",
    evidence: "official-usdt",
  });
}
