import { Buffer } from "node:buffer";
import { Address, SendMode, internal } from "@ton/core";
import { TonClient, WalletContractV5R1 } from "@ton/ton";
import { prisma } from "../../backend/src/db";
import {
  formatNanoTon,
  maskValue,
  type TonNetwork
} from "../../backend/src/ton/direct-payments";
import { tonPublicKeyHash } from "../../backend/src/ton/deposit-addresses";

export type TonDepositSweepStatus =
  | "NOT_STARTED"
  | "SWEEPING"
  | "SENT"
  | "CONFIRMED"
  | "FAILED";

const defaultSweepReserveNano = BigInt("50000000");
const defaultMinSweepNano = BigInt("1000000");
const defaultSweepRetryMs = 60_000;
const maxStoredErrorLength = 1000;

const tonDepositSweepRecordSelect = {
  id: true,
  network: true,
  address: true,
  addressRaw: true,
  walletVersion: true,
  walletWorkchain: true,
  walletContext: true,
  walletNetworkGlobalId: true,
  walletPublicKeyHash: true,
  invoiceKind: true,
  invoiceId: true,
  status: true,
  paidAt: true,
  sweepStatus: true,
  sweepAmountNano: true,
  sweepReserveNano: true,
  sweepRecipientAddress: true,
  sweepTransactionHash: true,
  sweepSeqno: true,
  sweepStartedAt: true,
  sweepSentAt: true,
  sweepConfirmedAt: true,
  sweepLastError: true,
  sweepAttempts: true
};

export type TonDepositSweepRecord = {
  id: string;
  network: string;
  address: string;
  addressRaw: string;
  walletVersion: string;
  walletWorkchain: number;
  walletContext: number;
  walletNetworkGlobalId: number;
  walletPublicKeyHash: string;
  invoiceKind: string;
  invoiceId: string | null;
  status: string;
  paidAt: Date | null;
  sweepStatus: string;
  sweepAmountNano: string | null;
  sweepReserveNano: string | null;
  sweepRecipientAddress: string | null;
  sweepTransactionHash: string | null;
  sweepSeqno: number | null;
  sweepStartedAt: Date | null;
  sweepSentAt: Date | null;
  sweepConfirmedAt: Date | null;
  sweepLastError: string | null;
  sweepAttempts: number;
};

export type TonDepositSweepConfig = {
  network: TonNetwork;
  publicKey: Buffer;
  publicKeyHash: string;
  secretKey: Buffer;
  secretKeyEnvName: string;
  recipientAddress: string;
  recipientAddressRaw: string;
  recipientAddressEnvName: string;
  reserveNano: bigint;
  minSweepNano: bigint;
  jsonRpcEndpoint: string;
  apiKey?: string;
  apiKeyEnvName?: string;
};

export type TonDepositSweepRepository = {
  listSweepCandidates: (input: {
    network: TonNetwork;
    limit: number;
    retryBefore: Date;
  }) => Promise<TonDepositSweepRecord[]>;
  claimSweepCandidate: (input: {
    id: string;
    now: Date;
  }) => Promise<TonDepositSweepRecord | null>;
  markSweepSent: (input: {
    id: string;
    amountNano: string;
    reserveNano: string;
    recipientAddress: string;
    seqno: number | null;
    sentAt: Date;
  }) => Promise<void>;
  markSweepFailed: (input: {
    id: string;
    error: string;
    failedAt: Date;
  }) => Promise<void>;
};

export type TonDepositSweepBlockchain = {
  getBalance: (address: Address) => Promise<bigint>;
  sendSweepTransfer: (input: {
    wallet: WalletContractV5R1;
    secretKey: Buffer;
    recipientAddress: Address;
    amountNano: bigint;
    comment: string;
  }) => Promise<{
    seqno: number | null;
  }>;
};

export type TonDepositSweepOutcome =
  | {
      status: "sent";
      depositAddressId: string;
      addressMasked: string;
      amountNano: string;
      amountTon: string;
      balanceNano: string;
      reserveNano: string;
      recipientAddressMasked: string;
      seqno: number | null;
    }
  | {
      status: "insufficient-balance";
      depositAddressId: string;
      addressMasked: string;
      balanceNano: string;
      reserveNano: string;
      minSweepNano: string;
      error: string;
    }
  | {
      status: "failed";
      depositAddressId: string;
      addressMasked: string;
      error: string;
    }
  | {
      status: "claimed-by-other";
      depositAddressId: string;
      addressMasked: string;
    };

function envValue(env: NodeJS.ProcessEnv, names: string[]) {
  for (const name of names) {
    const value = env[name]?.trim();

    if (value) {
      return {
        name,
        value
      };
    }
  }

  return null;
}

function networkEnvPrefix(network: TonNetwork) {
  return network === "mainnet" ? "TON_MAINNET" : "TON_TESTNET";
}

function tonCenterJsonRpcEndpoint(network: TonNetwork) {
  return network === "mainnet"
    ? "https://toncenter.com/api/v2/jsonRPC"
    : "https://testnet.toncenter.com/api/v2/jsonRPC";
}

function apiKeyEnvNames(network: TonNetwork) {
  return network === "mainnet"
    ? ["TON_MAINNET_API_KEY", "TON_API_KEY"]
    : ["TON_TESTNET_API_KEY", "TON_API_KEY"];
}

function parseNanoInteger(value: string, name: string) {
  const normalized = value.trim();

  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${name} must be a non-negative integer nanotons value.`);
  }

  return BigInt(normalized);
}

function truncateError(value: string) {
  return value.length > maxStoredErrorLength
    ? value.slice(0, maxStoredErrorLength)
    : value;
}

function errorMessage(error: unknown) {
  return truncateError(error instanceof Error ? error.message : String(error));
}

export function parseTonDepositSecretKey(value: string) {
  const normalized = value.trim();
  const hex = normalized.replace(/^0x/i, "");
  const secretKey = /^[0-9a-f]{128}$/i.test(hex)
    ? Buffer.from(hex, "hex")
    : Buffer.from(normalized.replace(/-/g, "+").replace(/_/g, "/"), "base64");

  if (secretKey.length !== 64) {
    throw new Error("TON deposit secret key must decode to 64 bytes.");
  }

  return secretKey;
}

export function tonPublicKeyFromSecretKey(secretKey: Buffer) {
  if (secretKey.length !== 64) {
    throw new Error("TON deposit secret key must be 64 bytes.");
  }

  return Buffer.from(secretKey.subarray(32, 64));
}

export function resolveTonDepositSweepConfig(
  network: TonNetwork,
  env: NodeJS.ProcessEnv = process.env
): TonDepositSweepConfig {
  const prefix = networkEnvPrefix(network);
  const secretKeyValue = envValue(env, [
    `${prefix}_DEPOSIT_SECRET_KEY`,
    "TON_DEPOSIT_SECRET_KEY"
  ]);

  if (!secretKeyValue) {
    throw new Error(
      `${network}: set \`${prefix}_DEPOSIT_SECRET_KEY\` or \`TON_DEPOSIT_SECRET_KEY\` in the sweep worker env.`
    );
  }

  const recipientValue = envValue(env, [
    `${prefix}_SWEEP_RECIPIENT_ADDRESS`,
    "TON_SWEEP_RECIPIENT_ADDRESS"
  ]);

  if (!recipientValue) {
    throw new Error(
      `${network}: set \`${prefix}_SWEEP_RECIPIENT_ADDRESS\` or \`TON_SWEEP_RECIPIENT_ADDRESS\` in the sweep worker env.`
    );
  }

  const secretKey = parseTonDepositSecretKey(secretKeyValue.value);
  const publicKey = tonPublicKeyFromSecretKey(secretKey);
  const publicKeyHash = tonPublicKeyHash(publicKey);
  const recipientAddress = Address.parse(recipientValue.value);
  const reserveValue = envValue(env, [
    `${prefix}_SWEEP_RESERVE_NANO`,
    "TON_SWEEP_RESERVE_NANO"
  ]);
  const minSweepValue = envValue(env, [
    `${prefix}_SWEEP_MIN_NANO`,
    "TON_SWEEP_MIN_NANO"
  ]);
  const apiKey = envValue(env, apiKeyEnvNames(network));

  return {
    network,
    publicKey,
    publicKeyHash,
    secretKey,
    secretKeyEnvName: secretKeyValue.name,
    recipientAddress: recipientValue.value,
    recipientAddressRaw: recipientAddress.toRawString(),
    recipientAddressEnvName: recipientValue.name,
    reserveNano: reserveValue
      ? parseNanoInteger(reserveValue.value, reserveValue.name)
      : defaultSweepReserveNano,
    minSweepNano: minSweepValue
      ? parseNanoInteger(minSweepValue.value, minSweepValue.name)
      : defaultMinSweepNano,
    jsonRpcEndpoint: tonCenterJsonRpcEndpoint(network),
    apiKey: apiKey?.value,
    apiKeyEnvName: apiKey?.name
  };
}

export function createTonSweepBlockchainClient(
  config: TonDepositSweepConfig
): TonDepositSweepBlockchain {
  const client = new TonClient({
    endpoint: config.jsonRpcEndpoint,
    apiKey: config.apiKey
  });

  return {
    getBalance: (address) => client.getBalance(address),
    sendSweepTransfer: async (input) => {
      const opened = client.open(input.wallet);
      const seqno = await opened.getSeqno();

      await opened.sendTransfer({
        seqno,
        secretKey: input.secretKey,
        sendMode: (SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS) as SendMode,
        messages: [
          internal({
            to: input.recipientAddress,
            value: input.amountNano,
            bounce: false,
            body: input.comment
          })
        ]
      });

      return {
        seqno
      };
    }
  };
}

export const prismaTonDepositSweepRepository: TonDepositSweepRepository = {
  listSweepCandidates: (input) =>
    (prisma as any).tonhubDepositAddress.findMany({
      where: {
        network: input.network,
        status: "PAID",
        walletVersion: "v5r1",
        OR: [
          {
            sweepStatus: "NOT_STARTED"
          },
          {
            sweepStatus: "FAILED",
            OR: [
              {
                sweepStartedAt: null
              },
              {
                sweepStartedAt: {
                  lt: input.retryBefore
                }
              }
            ]
          }
        ]
      },
      orderBy: [
        {
          paidAt: "asc"
        },
        {
          createdAt: "asc"
        }
      ],
      take: input.limit,
      select: tonDepositSweepRecordSelect
    }),
  claimSweepCandidate: async (input) => {
    const result = await (prisma as any).tonhubDepositAddress.updateMany({
      where: {
        id: input.id,
        status: "PAID",
        sweepStatus: {
          in: ["NOT_STARTED", "FAILED"]
        }
      },
      data: {
        sweepStatus: "SWEEPING",
        sweepStartedAt: input.now,
        sweepLastError: null,
        sweepAttempts: {
          increment: 1
        }
      }
    });

    if (result.count === 0) {
      return null;
    }

    return (prisma as any).tonhubDepositAddress.findUnique({
      where: {
        id: input.id
      },
      select: tonDepositSweepRecordSelect
    });
  },
  markSweepSent: async (input) => {
    await (prisma as any).tonhubDepositAddress.update({
      where: {
        id: input.id
      },
      data: {
        sweepStatus: "SENT",
        sweepAmountNano: input.amountNano,
        sweepReserveNano: input.reserveNano,
        sweepRecipientAddress: input.recipientAddress,
        sweepSeqno: input.seqno,
        sweepSentAt: input.sentAt,
        sweepLastError: null
      }
    });
  },
  markSweepFailed: async (input) => {
    await (prisma as any).tonhubDepositAddress.update({
      where: {
        id: input.id
      },
      data: {
        sweepStatus: "FAILED",
        sweepLastError: truncateError(input.error),
        updatedAt: input.failedAt
      }
    });
  }
};

function buildWalletForDepositRecord(input: {
  record: TonDepositSweepRecord;
  config: TonDepositSweepConfig;
}) {
  const { record, config } = input;

  if (record.network !== config.network) {
    throw new Error(`Sweep config network ${config.network} does not match deposit network ${record.network}.`);
  }

  if (record.walletVersion !== "v5r1") {
    throw new Error(`Unsupported TON deposit wallet version: ${record.walletVersion}.`);
  }

  if (record.walletPublicKeyHash !== config.publicKeyHash) {
    throw new Error("TON deposit secret key does not match this deposit address public key hash.");
  }

  const wallet = WalletContractV5R1.create({
    publicKey: config.publicKey,
    workchain: record.walletWorkchain,
    walletId: {
      networkGlobalId: record.walletNetworkGlobalId,
      context: record.walletContext
    }
  });
  const reconstructedRaw = wallet.address.toRawString();

  if (reconstructedRaw !== record.addressRaw) {
    throw new Error("TON deposit wallet metadata does not reconstruct the stored deposit address.");
  }

  return wallet;
}

export async function sweepTonDepositAddress(input: {
  record: TonDepositSweepRecord;
  config: TonDepositSweepConfig;
  repository?: TonDepositSweepRepository;
  blockchain?: TonDepositSweepBlockchain;
  now?: () => Date;
}): Promise<TonDepositSweepOutcome> {
  const repository = input.repository ?? prismaTonDepositSweepRepository;
  const blockchain = input.blockchain ?? createTonSweepBlockchainClient(input.config);
  const now = input.now ?? (() => new Date());
  const addressMasked = maskValue(input.record.address);
  const claimed = await repository.claimSweepCandidate({
    id: input.record.id,
    now: now()
  });

  if (!claimed) {
    return {
      status: "claimed-by-other",
      depositAddressId: input.record.id,
      addressMasked
    };
  }

  try {
    const wallet = buildWalletForDepositRecord({
      record: claimed,
      config: input.config
    });
    const recipientAddress = Address.parse(input.config.recipientAddress);
    const balanceNano = await blockchain.getBalance(wallet.address);
    const amountNano = balanceNano - input.config.reserveNano;

    if (amountNano <= BigInt(0) || amountNano < input.config.minSweepNano) {
      const error = `TON deposit balance ${formatNanoTon(balanceNano.toString())} does not exceed sweep reserve ${formatNanoTon(input.config.reserveNano.toString())}.`;
      await repository.markSweepFailed({
        id: claimed.id,
        error,
        failedAt: now()
      });

      return {
        status: "insufficient-balance",
        depositAddressId: claimed.id,
        addressMasked,
        balanceNano: balanceNano.toString(),
        reserveNano: input.config.reserveNano.toString(),
        minSweepNano: input.config.minSweepNano.toString(),
        error
      };
    }

    const sent = await blockchain.sendSweepTransfer({
      wallet,
      secretKey: input.config.secretKey,
      recipientAddress,
      amountNano,
      comment: `Tonhub payment sweep ${claimed.id}`
    });
    const sentAt = now();

    await repository.markSweepSent({
      id: claimed.id,
      amountNano: amountNano.toString(),
      reserveNano: input.config.reserveNano.toString(),
      recipientAddress: input.config.recipientAddress,
      seqno: sent.seqno,
      sentAt
    });

    return {
      status: "sent",
      depositAddressId: claimed.id,
      addressMasked,
      amountNano: amountNano.toString(),
      amountTon: formatNanoTon(amountNano.toString()),
      balanceNano: balanceNano.toString(),
      reserveNano: input.config.reserveNano.toString(),
      recipientAddressMasked: maskValue(input.config.recipientAddress),
      seqno: sent.seqno
    };
  } catch (error) {
    const message = errorMessage(error);
    await repository.markSweepFailed({
      id: claimed.id,
      error: message,
      failedAt: now()
    });

    return {
      status: "failed",
      depositAddressId: claimed.id,
      addressMasked,
      error: message
    };
  }
}

export async function runTonDepositSweepBatch(input: {
  network: TonNetwork;
  limit?: number;
  retryAfterMs?: number;
  config?: TonDepositSweepConfig;
  repository?: TonDepositSweepRepository;
  blockchain?: TonDepositSweepBlockchain;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  const config = input.config ?? resolveTonDepositSweepConfig(input.network);
  const repository = input.repository ?? prismaTonDepositSweepRepository;
  const blockchain = input.blockchain ?? createTonSweepBlockchainClient(config);
  const retryBefore = new Date(now().getTime() - (input.retryAfterMs ?? defaultSweepRetryMs));
  const candidates = await repository.listSweepCandidates({
    network: input.network,
    limit: input.limit ?? 10,
    retryBefore
  });
  const outcomes: TonDepositSweepOutcome[] = [];

  for (const record of candidates) {
    outcomes.push(
      await sweepTonDepositAddress({
        record,
        config,
        repository,
        blockchain,
        now
      })
    );
  }

  return {
    network: input.network,
    candidates: candidates.length,
    outcomes,
    sent: outcomes.filter((outcome) => outcome.status === "sent").length,
    failed: outcomes.filter((outcome) =>
      outcome.status === "failed" || outcome.status === "insufficient-balance"
    ).length
  };
}
