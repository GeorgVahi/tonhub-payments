import { createHash, randomInt } from "node:crypto";
import { WalletContractV5R1 } from "@ton/ton";
import type { TonNetwork } from "./direct-payments";

export type TonAddressStrategy = "shared-comment" | "unique-address";
export type TonDepositWalletVersion = "v5r1";

export type TonDepositAddressConfig = {
  network: TonNetwork;
  publicKey: Buffer;
  publicKeyHash: string;
  walletVersion: TonDepositWalletVersion;
  walletWorkchain: number;
  walletNetworkGlobalId: number;
};

export type TonUniqueDepositAddress = {
  addressStrategy: "unique-address";
  network: TonNetwork;
  address: string;
  addressRaw: string;
  walletVersion: TonDepositWalletVersion;
  walletWorkchain: number;
  walletContext: number;
  walletNetworkGlobalId: number;
  walletPublicKeyHash: string;
};

const walletContextMax = 0x7fffffff;

function envValue(env: NodeJS.ProcessEnv, names: string[]) {
  for (const name of names) {
    const value = env[name]?.trim();

    if (value) {
      return value;
    }
  }

  return null;
}

export function tonNetworkGlobalId(network: TonNetwork) {
  return network === "mainnet" ? -239 : -3;
}

export function createTonWalletContext() {
  return randomInt(1, walletContextMax);
}

export function parseTonDepositPublicKey(value: string) {
  const normalized = value.trim();
  const hex = normalized.replace(/^0x/i, "");
  const publicKey = /^[0-9a-f]{64}$/i.test(hex)
    ? Buffer.from(hex, "hex")
    : Buffer.from(normalized.replace(/-/g, "+").replace(/_/g, "/"), "base64");

  if (publicKey.length !== 32) {
    throw new Error("TON deposit public key must decode to 32 bytes.");
  }

  return publicKey;
}

export function tonPublicKeyHash(publicKey: Buffer) {
  return createHash("sha256").update(publicKey).digest("hex");
}

export function resolveTonDepositAddressConfig(
  network: TonNetwork,
  env: NodeJS.ProcessEnv = process.env
): TonDepositAddressConfig {
  const publicKeyValue = envValue(
    env,
    network === "mainnet"
      ? ["TON_MAINNET_DEPOSIT_PUBLIC_KEY", "TON_DEPOSIT_PUBLIC_KEY"]
      : ["TON_TESTNET_DEPOSIT_PUBLIC_KEY", "TON_DEPOSIT_PUBLIC_KEY"]
  );

  if (!publicKeyValue) {
    throw new Error(
      `${network}: set \`TON_${network.toUpperCase()}_DEPOSIT_PUBLIC_KEY\` or \`TON_DEPOSIT_PUBLIC_KEY\`.`
    );
  }

  const workchainText = env.TON_DEPOSIT_WALLET_WORKCHAIN?.trim() || "0";
  const walletWorkchain = Number.parseInt(workchainText, 10);

  if (!Number.isInteger(walletWorkchain)) {
    throw new Error("TON_DEPOSIT_WALLET_WORKCHAIN must be an integer.");
  }

  const publicKey = parseTonDepositPublicKey(publicKeyValue);

  return {
    network,
    publicKey,
    publicKeyHash: tonPublicKeyHash(publicKey),
    walletVersion: "v5r1",
    walletWorkchain,
    walletNetworkGlobalId: tonNetworkGlobalId(network)
  };
}

export function createTonV5R1DepositAddress(input: {
  network: TonNetwork;
  publicKey: Buffer;
  walletContext?: number;
  walletWorkchain?: number;
  walletNetworkGlobalId?: number;
}) {
  const walletContext = input.walletContext ?? createTonWalletContext();

  if (!Number.isInteger(walletContext) || walletContext < 1 || walletContext > walletContextMax) {
    throw new Error("TON V5R1 wallet context must be a 31-bit positive integer.");
  }

  const walletWorkchain = input.walletWorkchain ?? 0;
  const walletNetworkGlobalId = input.walletNetworkGlobalId ?? tonNetworkGlobalId(input.network);
  const wallet = WalletContractV5R1.create({
    publicKey: input.publicKey,
    workchain: walletWorkchain,
    walletId: {
      networkGlobalId: walletNetworkGlobalId,
      context: walletContext
    }
  });

  return {
    addressStrategy: "unique-address",
    network: input.network,
    address: wallet.address.toString({
      urlSafe: true,
      bounceable: false,
      testOnly: input.network === "testnet"
    }),
    addressRaw: wallet.address.toRawString(),
    walletVersion: "v5r1",
    walletWorkchain,
    walletContext,
    walletNetworkGlobalId,
    walletPublicKeyHash: tonPublicKeyHash(input.publicKey)
  } satisfies TonUniqueDepositAddress;
}

export function createTonV5R1DepositAddressFromConfig(input: {
  config: TonDepositAddressConfig;
  walletContext?: number;
}) {
  return createTonV5R1DepositAddress({
    network: input.config.network,
    publicKey: input.config.publicKey,
    walletContext: input.walletContext,
    walletWorkchain: input.config.walletWorkchain,
    walletNetworkGlobalId: input.config.walletNetworkGlobalId
  });
}

export function createTonV5R1DepositAddressFromEnv(input: {
  network: TonNetwork;
  env?: NodeJS.ProcessEnv;
  walletContext?: number;
}) {
  return createTonV5R1DepositAddressFromConfig({
    config: resolveTonDepositAddressConfig(input.network, input.env),
    walletContext: input.walletContext
  });
}
