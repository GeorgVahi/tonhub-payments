import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { Address, SendMode, comment, internal } from "@ton/core";
import { TonClient, WalletContractV5R1 } from "@ton/ton";
import { prisma } from "../../backend/src/db";
import {
  formatNanoTon,
  maskValue,
  type TonNetwork
} from "../../backend/src/ton/direct-payments";
import { tonPublicKeyHash } from "../../backend/src/ton/deposit-addresses";
import { reconcileAutomaticAssetSweeps } from "../../backend/src/automatic-sweeps";
import { resumableFailedNativeGramSweepStatus } from "../../shared/native-gram-sweep-state";

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
  assetSweepId?: string | null;
  assetSweepStatus?: string | null;
  assetSweepAmountAtomic?: string | null;
  assetSweepReserveAtomic?: string | null;
  assetSweepRecipientAddress?: string | null;
  assetSweepSeqno?: number | null;
  assetSweepStartedAt?: Date | null;
  assetSweepSentAt?: Date | null;
  assetSweepTransactionHash?: string | null;
  assetSweepConfirmedAt?: Date | null;
  assetSweepLeaseOwner?: string | null;
  orderId?: string | null;
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
    now: Date;
    retryBefore: Date;
  }) => Promise<TonDepositSweepRecord[]>;
  claimSweepCandidate: (input: {
    id: string;
    now: Date;
    assetSweepId?: string | null;
    leaseOwner?: string;
  }) => Promise<TonDepositSweepRecord | null>;
  markSweepReady?: (input: {
    id: string;
    assetSweepId: string;
    leaseOwner: string;
    amountNano: string;
    reserveNano: string;
    recipientAddress: string;
    seqno: number;
    startedAt: Date;
  }) => Promise<void>;
  markSweepSent: (input: {
    id: string;
    assetSweepId?: string | null;
    leaseOwner?: string;
    amountNano: string;
    reserveNano: string;
    recipientAddress: string;
    seqno: number | null;
    sentAt: Date;
  }) => Promise<void>;
  markSweepFailed: (input: {
    id: string;
    assetSweepId?: string | null;
    leaseOwner?: string;
    error: string;
    failedAt: Date;
  }) => Promise<void>;
  markSweepConfirmed?: (input: {
    id: string;
    assetSweepId: string;
    leaseOwner: string;
    confirmedAt: Date;
    confirmation: TonNativeSweepConfirmation;
  }) => Promise<void>;
  deferAssetSweep?: (input: {
    assetSweepId: string;
    leaseOwner: string;
    retryAt: Date;
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
    seqno?: number;
  }) => Promise<{
    seqno: number | null;
  }>;
  getWalletSeqno?: (wallet: WalletContractV5R1) => Promise<number>;
  findSweepTransfer?: (input: {
    wallet: WalletContractV5R1;
    recipientAddress: Address;
    amountNano: bigint;
    comment: string;
    notBefore: Date;
  }) => Promise<TonNativeSweepConfirmation | null>;
  waitForWalletSeqno: (wallet: WalletContractV5R1, previousSeqno: number) => Promise<boolean>;
};

export type TonNativeSweepConfirmation = {
  transactionHash: string;
  transactionLt: string;
  blockchainAt: Date;
};

function matchingNativeSweepConfirmations(input: {
  transactions: any[];
  walletAddress: Address;
  recipientAddress: Address;
  amountNano: bigint;
  comment: string;
  notBefore: Date;
}) {
  const expectedBodyHash = comment(input.comment).hash().toString("hex");
  const notBeforeSeconds = Math.floor(input.notBefore.getTime() / 1000);
  return input.transactions.flatMap((transaction) => {
    if (
      transaction.now < notBeforeSeconds ||
      transaction.description.type !== "generic" ||
      transaction.description.aborted !== false ||
      transaction.description.actionPhase?.success !== true ||
      !transaction.outMessages.values().some((message: any) =>
        message.info.type === "internal" &&
        message.info.src.equals(input.walletAddress) &&
        message.info.dest.equals(input.recipientAddress) &&
        message.info.value.coins === input.amountNano &&
        message.body.hash().toString("hex") === expectedBodyHash
      )
    ) {
      return [];
    }
    return [{
      transactionHash: transaction.hash().toString("hex"),
      transactionLt: transaction.lt.toString(),
      blockchainAt: new Date(transaction.now * 1000)
    } satisfies TonNativeSweepConfirmation];
  });
}

export async function findExactTonNativeSweepTransfer(input: {
  fetchPage: (cursor: { lt: string; hash: string } | null, limit: number) => Promise<any[]>;
  walletAddress: Address;
  recipientAddress: Address;
  amountNano: bigint;
  comment: string;
  notBefore: Date;
  pageSize?: number;
  maxPages?: number;
}) {
  const pageSize = input.pageSize ?? 100;
  const maxPages = input.maxPages ?? 20;
  const notBeforeSeconds = Math.floor(input.notBefore.getTime() / 1000);
  const matches: TonNativeSweepConfirmation[] = [];
  const seen = new Set<string>();
  let cursor: { lt: string; hash: string } | null = null;
  let reachedBoundary = false;
  for (let page = 0; page < maxPages; page += 1) {
    const transactions = await input.fetchPage(cursor, pageSize);
    if (transactions.length === 0) {
      reachedBoundary = true;
      break;
    }
    const fresh = transactions.filter((transaction) => {
      const hash = transaction.hash().toString("hex");
      if (seen.has(hash)) return false;
      seen.add(hash);
      return true;
    });
    matches.push(...matchingNativeSweepConfirmations({
      transactions: fresh,
      walletAddress: input.walletAddress,
      recipientAddress: input.recipientAddress,
      amountNano: input.amountNano,
      comment: input.comment,
      notBefore: input.notBefore
    }));
    const oldest = transactions.at(-1)!;
    if (oldest.now < notBeforeSeconds || transactions.length < pageSize) {
      reachedBoundary = true;
      break;
    }
    const next = {
      lt: oldest.lt.toString(),
      hash: oldest.hash().toString("base64")
    };
    if (cursor && cursor.lt === next.lt && cursor.hash === next.hash) {
      throw new Error("TON provider native sweep pagination cursor did not advance.");
    }
    cursor = next;
  }
  if (!reachedBoundary) {
    throw new Error("TON provider native sweep confirmation pagination cap was exhausted.");
  }
  if (matches.length > 1) {
    throw new Error("TON provider returned ambiguous native sweep confirmation evidence.");
  }
  return matches[0] ?? null;
}

export type TonWalletSigningLease = {
  acquire: (input: {
    network: TonNetwork;
    addressRaw: string;
    owner: string;
    now: Date;
    leaseMs: number;
  }) => Promise<boolean>;
  release: (input: {
    network: TonNetwork;
    addressRaw: string;
    owner: string;
  }) => Promise<void>;
};

const walletSigningStreamType = "TON_WALLET_OUT";
const activeAssetSweepStatuses = [
  "QUEUED",
  "GAS_CHECK",
  "GAS_TOPUP_REQUIRED",
  "GAS_TOPUP_SENT",
  "READY",
  "SENT",
  "FAILED"
];

export const prismaTonWalletSigningLease: TonWalletSigningLease = {
  acquire: async (input) => {
    await (prisma as any).tonhubScanCursor.createMany({
      data: {
        network: input.network,
        streamType: walletSigningStreamType,
        scopeKey: input.addressRaw
      },
      skipDuplicates: true
    });
    const result = await (prisma as any).tonhubScanCursor.updateMany({
      where: {
        network: input.network,
        streamType: walletSigningStreamType,
        scopeKey: input.addressRaw,
        OR: [
          { leaseOwner: input.owner },
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lte: input.now } }
        ]
      },
      data: {
        leaseOwner: input.owner,
        leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs)
      }
    });
    return result.count === 1;
  },
  release: async (input) => {
    await (prisma as any).tonhubScanCursor.updateMany({
      where: {
        network: input.network,
        streamType: walletSigningStreamType,
        scopeKey: input.addressRaw,
        leaseOwner: input.owner
      },
      data: { leaseOwner: null, leaseExpiresAt: null }
    });
  }
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
    }
  | {
      status: "confirmed";
      depositAddressId: string;
      addressMasked: string;
      amountNano: string;
      reserveNano: string;
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
    getWalletSeqno: (wallet) => client.open(wallet).getSeqno(),
    sendSweepTransfer: async (input) => {
      const opened = client.open(input.wallet);
      const seqno = input.seqno ?? await opened.getSeqno();

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
    },
    findSweepTransfer: async (input) => {
      return findExactTonNativeSweepTransfer({
        fetchPage: (cursor, limit) => client.getTransactions(input.wallet.address, {
          limit,
          archival: true,
          ...(cursor ? { lt: cursor.lt, hash: cursor.hash, inclusive: false } : {})
        }),
        walletAddress: input.wallet.address,
        recipientAddress: input.recipientAddress,
        amountNano: input.amountNano,
        comment: input.comment,
        notBefore: input.notBefore
      });
    },
    waitForWalletSeqno: async (wallet, previousSeqno) => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        if (await client.open(wallet).getSeqno() > previousSeqno) {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      return false;
    }
  };
}

function assetSweepDepositRecord(sweep: any): TonDepositSweepRecord {
  if (!sweep?.depositAddress) {
    throw new Error("GRAM asset sweep has no deposit address.");
  }
  return {
    ...sweep.depositAddress,
    assetSweepId: sweep.id,
    assetSweepStatus: sweep.status,
    assetSweepAmountAtomic: sweep.amountAtomic,
    assetSweepReserveAtomic: sweep.reserveAtomic,
    assetSweepRecipientAddress: sweep.recipientAddress,
    assetSweepSeqno: sweep.seqno,
    assetSweepStartedAt: sweep.startedAt,
    assetSweepSentAt: sweep.sentAt,
    assetSweepTransactionHash: sweep.transactionHash,
    assetSweepConfirmedAt: sweep.confirmedAt,
    assetSweepLeaseOwner: sweep.leaseOwner,
    orderId: sweep.orderId
  };
}

export const prismaTonDepositSweepRepository: TonDepositSweepRepository = {
  listSweepCandidates: async (input) => {
    const automaticSweeps = await (prisma as any).tonhubAssetSweep.findMany({
      where: {
        asset: "GRAM",
        assetKind: "NATIVE",
        automaticSequence: { not: null },
        status: { in: ["QUEUED", "READY", "SENT"] },
        depositAddress: { network: input.network, walletVersion: "v5r1" },
        OR: [
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lte: input.now } }
        ]
      },
      orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: input.limit,
      include: { depositAddress: { select: tonDepositSweepRecordSelect } }
    });
    if (automaticSweeps.length >= input.limit) {
      return automaticSweeps.map(assetSweepDepositRecord);
    }
    const legacy = await (prisma as any).tonhubDepositAddress.findMany({
      where: {
        network: input.network,
        status: "PAID",
        walletVersion: "v5r1",
        sweeps: {
          none: {
            asset: { in: ["GRAM", "USDT"] },
            status: { in: activeAssetSweepStatuses }
          }
        },
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
      take: input.limit - automaticSweeps.length,
      select: tonDepositSweepRecordSelect
    });
    return [...automaticSweeps.map(assetSweepDepositRecord), ...legacy];
  },
  claimSweepCandidate: async (input) => {
    if (input.assetSweepId) {
      const current = await (prisma as any).tonhubAssetSweep.findUnique({
        where: { id: input.assetSweepId },
        include: { depositAddress: { select: tonDepositSweepRecordSelect } }
      });
      if (!current || !["QUEUED", "READY", "SENT", "FAILED"].includes(current.status)) {
        return null;
      }
      const leaseOwner = input.leaseOwner ?? `native-asset-sweep:${input.assetSweepId}`;
      const resumedStatus = current.status === "FAILED"
        ? resumableFailedNativeGramSweepStatus(current)
        : current.status === "QUEUED" ? "READY" : current.status;
      const claimed = await (prisma as any).tonhubAssetSweep.updateMany({
        where: {
          id: current.id,
          status: current.status,
          OR: [
            { leaseExpiresAt: null },
            { leaseExpiresAt: { lte: input.now } }
          ]
        },
        data: {
          status: resumedStatus,
          leaseOwner,
          leaseExpiresAt: new Date(input.now.getTime() + 60_000),
          startedAt: current.startedAt ?? input.now,
          lastError: null,
          attempts: { increment: 1 }
        }
      });
      if (claimed.count !== 1) return null;
      return assetSweepDepositRecord(await (prisma as any).tonhubAssetSweep.findUnique({
        where: { id: current.id },
        include: { depositAddress: { select: tonDepositSweepRecordSelect } }
      }));
    }
    const result = await (prisma as any).tonhubDepositAddress.updateMany({
      where: {
        id: input.id,
        status: "PAID",
        sweepStatus: {
          in: ["NOT_STARTED", "FAILED"]
        },
        sweeps: {
          none: {
            asset: { in: ["GRAM", "USDT"] },
            status: { in: activeAssetSweepStatuses }
          }
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
  markSweepReady: async (input) => {
    const updated = await (prisma as any).tonhubAssetSweep.updateMany({
      where: { id: input.assetSweepId, status: "READY", leaseOwner: input.leaseOwner },
      data: {
        amountAtomic: input.amountNano,
        reserveAtomic: input.reserveNano,
        recipientAddress: input.recipientAddress,
        seqno: input.seqno,
        startedAt: input.startedAt
      }
    });
    if (updated.count !== 1) throw new Error("GRAM asset sweep lost its READY lease.");
  },
  markSweepSent: async (input) => {
    if (input.assetSweepId) {
      const updated = await (prisma as any).tonhubAssetSweep.updateMany({
        where: { id: input.assetSweepId, status: "READY", leaseOwner: input.leaseOwner },
        data: {
          status: "SENT",
          amountAtomic: input.amountNano,
          reserveAtomic: input.reserveNano,
          recipientAddress: input.recipientAddress,
          seqno: input.seqno,
          sentAt: input.sentAt,
          lastError: null
        }
      });
      if (updated.count !== 1) throw new Error("GRAM asset sweep lost its broadcast lease.");
      return;
    }
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
    if (input.assetSweepId) {
      await (prisma as any).$transaction(async (tx: any) => {
        const sweep = await tx.tonhubAssetSweep.findUnique({ where: { id: input.assetSweepId } });
        const failed = await tx.tonhubAssetSweep.updateMany({
          where: {
            id: input.assetSweepId,
            leaseOwner: input.leaseOwner,
            status: { in: ["READY", "SENT"] }
          },
          data: {
            status: "FAILED",
            leaseOwner: null,
            leaseExpiresAt: new Date(input.failedAt.getTime() + defaultSweepRetryMs),
            lastError: truncateError(input.error)
          }
        });
        if (failed.count !== 1 || !sweep?.orderId || !sweep.invoiceId) return;
        await tx.tonhubRecoveryCase.upsert({
          where: { id: `asset-sweep:${sweep.id}` },
          create: {
            id: `asset-sweep:${sweep.id}`,
            orderId: sweep.orderId,
            invoiceId: sweep.invoiceId,
            reason: "GRAM_SWEEP_FAILED",
            title: "GRAM sweep requires recovery",
            details: {
              sweepId: sweep.id,
              depositAddressId: sweep.depositAddressId,
              error: truncateError(input.error),
              failedAt: input.failedAt.toISOString()
            }
          },
          update: {
            status: "OPEN",
            reason: "GRAM_SWEEP_FAILED",
            title: "GRAM sweep requires recovery",
            details: {
              sweepId: sweep.id,
              depositAddressId: sweep.depositAddressId,
              error: truncateError(input.error),
              failedAt: input.failedAt.toISOString()
            },
            resolvedBy: null,
            resolvedAt: null
          }
        });
      });
      return;
    }
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
  },
  markSweepConfirmed: async (input) => {
    await (prisma as any).$transaction(async (tx: any) => {
      const sweep = await tx.tonhubAssetSweep.findUnique({ where: { id: input.assetSweepId } });
      if (!sweep?.orderId || !sweep.invoiceId) {
        throw new Error("Automatic GRAM sweep lost order ownership.");
      }
      await tx.$queryRawUnsafe(
        `SELECT "id" FROM "TonhubPaymentOrder" WHERE "id" = $1 FOR UPDATE`,
        sweep.orderId
      );
      const updated = await tx.tonhubAssetSweep.updateMany({
        where: {
          id: sweep.id,
          status: "SENT",
          leaseOwner: input.leaseOwner
        },
        data: {
          status: "CONFIRMED",
          transactionHash: input.confirmation.transactionHash,
          confirmedAt: input.confirmedAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: null
        }
      });
      if (updated.count !== 1) throw new Error("GRAM sweep confirmation lost its lease.");
      const deposit = await tx.tonhubDepositAddress.findUnique({ where: { id: sweep.depositAddressId } });
      if (
        !deposit || !sweep.amountAtomic || !sweep.recipientAddress ||
        !/^\d+$/.test(input.confirmation.transactionLt)
      ) {
        throw new Error("Confirmed GRAM sweep has incomplete immutable chain evidence.");
      }
      await tx.tonhubPaymentMovement.createMany({
        data: [{
          fingerprint: `ton:${deposit.network}:native-out:${input.confirmation.transactionHash}:0`,
          depositAddressId: deposit.id,
          network: deposit.network,
          direction: "OUTGOING",
          asset: "GRAM",
          assetKind: "NATIVE",
          assetDecimals: 9,
          amountAtomic: sweep.amountAtomic,
          fromAddress: deposit.addressRaw,
          toAddress: sweep.recipientAddress,
          transactionHash: input.confirmation.transactionHash,
          transactionLt: input.confirmation.transactionLt,
          blockchainAt: input.confirmation.blockchainAt,
          rawPayload: {
            evidenceVersion: 1,
            provider: "ton-json-rpc-transactions",
            sweepId: sweep.id,
            exactNativeTransfer: true
          }
        }],
        skipDuplicates: true
      });
      const outgoingFingerprint = `ton:${deposit.network}:native-out:${input.confirmation.transactionHash}:0`;
      const outgoing = await tx.tonhubPaymentMovement.findUnique({
        where: { fingerprint: outgoingFingerprint }
      });
      const rawPayload = outgoing?.rawPayload;
      if (
        !outgoing || outgoing.depositAddressId !== deposit.id ||
        outgoing.network !== deposit.network || outgoing.direction !== "OUTGOING" ||
        outgoing.asset !== "GRAM" || outgoing.assetKind !== "NATIVE" ||
        outgoing.assetDecimals !== 9 || outgoing.amountAtomic !== sweep.amountAtomic ||
        Address.parse(outgoing.fromAddress).toRawString() !== Address.parse(deposit.addressRaw).toRawString() ||
        Address.parse(outgoing.toAddress).toRawString() !== Address.parse(sweep.recipientAddress).toRawString() ||
        outgoing.transactionHash !== input.confirmation.transactionHash ||
        outgoing.transactionLt !== input.confirmation.transactionLt ||
        outgoing.blockchainAt.getTime() !== input.confirmation.blockchainAt.getTime() ||
        outgoing.status !== "OBSERVED" ||
        !rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload) ||
        rawPayload.exactNativeTransfer !== true || rawPayload.sweepId !== sweep.id
      ) {
        throw new Error("Confirmed GRAM sweep conflicts with immutable outgoing ledger evidence.");
      }
      await tx.tonhubRecoveryCase.updateMany({
        where: { id: `asset-sweep:${sweep.id}`, status: { in: ["OPEN", "REVIEWED"] } },
        data: { status: "RESOLVED", resolvedBy: "system:gram-sweep", resolvedAt: input.confirmedAt }
      });
      await reconcileAutomaticAssetSweeps({
        tx,
        orderId: sweep.orderId,
        invoiceId: sweep.invoiceId,
        triggeredAt: input.confirmedAt
      });
    });
  },
  deferAssetSweep: async (input) => {
    await (prisma as any).tonhubAssetSweep.updateMany({
      where: { id: input.assetSweepId, leaseOwner: input.leaseOwner },
      data: { leaseOwner: null, leaseExpiresAt: input.retryAt }
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
  signingLease?: TonWalletSigningLease;
  signingLeaseMs?: number;
  now?: () => Date;
}): Promise<TonDepositSweepOutcome> {
  const repository = input.repository ?? prismaTonDepositSweepRepository;
  const blockchain = input.blockchain ?? createTonSweepBlockchainClient(input.config);
  const now = input.now ?? (() => new Date());
  const addressMasked = maskValue(input.record.address);
  const signingOwner = `native-sweep:${input.record.id}:${randomUUID()}`;
  const claimed = await repository.claimSweepCandidate({
    id: input.record.id,
    now: now(),
    assetSweepId: input.record.assetSweepId,
    leaseOwner: signingOwner
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
    if (input.signingLease && !await input.signingLease.acquire({
      network: input.config.network,
      addressRaw: claimed.addressRaw,
      owner: signingOwner,
      now: now(),
      leaseMs: input.signingLeaseMs ?? 60_000
    })) {
      if (claimed.assetSweepId && repository.deferAssetSweep) {
        await repository.deferAssetSweep({
          assetSweepId: claimed.assetSweepId,
          leaseOwner: signingOwner,
          retryAt: new Date(now().getTime() + defaultSweepRetryMs)
        });
        return {
          status: "claimed-by-other",
          depositAddressId: claimed.id,
          addressMasked
        };
      }
      throw new Error("TON deposit wallet is busy with another outgoing transfer.");
    }
    const isAutomaticAssetSweep = Boolean(claimed.assetSweepId);
    let confirmedAmountNano = claimed.assetSweepAmountAtomic ?? "0";
    let confirmedReserveNano = claimed.assetSweepReserveAtomic ?? input.config.reserveNano.toString();
    const confirmAutomaticSweep = async (confirmation: TonNativeSweepConfirmation) => {
      if (!claimed.assetSweepId || !repository.markSweepConfirmed) {
        throw new Error("GRAM asset sweep repository cannot persist confirmation.");
      }
      await repository.markSweepConfirmed({
        id: claimed.id,
        assetSweepId: claimed.assetSweepId,
        leaseOwner: signingOwner,
        confirmedAt: now(),
        confirmation
      });
      if (input.signingLease) {
        await input.signingLease.release({
          network: input.config.network,
          addressRaw: claimed.addressRaw,
          owner: signingOwner
        });
      }
      return {
        status: "confirmed" as const,
        depositAddressId: claimed.id,
        addressMasked,
        amountNano: confirmedAmountNano,
        reserveNano: confirmedReserveNano
      };
    };
    const hasPersistedPlanEvidence = isAutomaticAssetSweep && [
      claimed.assetSweepAmountAtomic,
      claimed.assetSweepReserveAtomic,
      claimed.assetSweepRecipientAddress,
      claimed.assetSweepSeqno,
    ].some((value) => value !== null && value !== undefined);
    const hasCompletePersistedPlan = isAutomaticAssetSweep &&
      Boolean(claimed.assetSweepAmountAtomic) &&
      claimed.assetSweepReserveAtomic !== null &&
      claimed.assetSweepReserveAtomic !== undefined &&
      Boolean(claimed.assetSweepRecipientAddress) &&
      claimed.assetSweepSeqno !== null &&
      claimed.assetSweepSeqno !== undefined;
    if (hasPersistedPlanEvidence && !hasCompletePersistedPlan) {
      throw new Error("Persisted GRAM sweep plan is incomplete.");
    }
    if (isAutomaticAssetSweep && hasCompletePersistedPlan) {
      if (
        claimed.assetSweepSeqno === null || claimed.assetSweepSeqno === undefined ||
        !claimed.assetSweepAmountAtomic || !claimed.assetSweepRecipientAddress
      ) {
        throw new Error("Persisted GRAM sweep plan is incomplete.");
      }
      const confirmationNotBefore = claimed.assetSweepStatus === "SENT"
        ? claimed.assetSweepSentAt
        : claimed.assetSweepStartedAt;
      if (!blockchain.findSweepTransfer || !confirmationNotBefore) {
        throw new Error("Persisted GRAM sweep plan lacks exact confirmation support.");
      }
      const confirmation = await blockchain.findSweepTransfer({
        wallet,
        recipientAddress: Address.parse(claimed.assetSweepRecipientAddress),
        amountNano: BigInt(claimed.assetSweepAmountAtomic),
        comment: `Tonhub automatic GRAM sweep ${claimed.assetSweepId}`,
        notBefore: confirmationNotBefore
      });
      if (confirmation) {
        if (claimed.assetSweepStatus === "READY") {
          await repository.markSweepSent({
            id: claimed.id,
            assetSweepId: claimed.assetSweepId,
            leaseOwner: signingOwner,
            amountNano: claimed.assetSweepAmountAtomic,
            reserveNano: claimed.assetSweepReserveAtomic!,
            recipientAddress: claimed.assetSweepRecipientAddress,
            seqno: claimed.assetSweepSeqno,
            sentAt: confirmation.blockchainAt
          });
        }
        return await confirmAutomaticSweep(confirmation);
      }
      if (claimed.assetSweepStatus === "READY" &&
        await blockchain.waitForWalletSeqno(wallet, claimed.assetSweepSeqno)) {
        throw new Error("Persisted READY GRAM sweep plan is ambiguous after wallet seqno advancement.");
      }
      if (claimed.assetSweepStatus === "SENT") {
        if (repository.deferAssetSweep && claimed.assetSweepId) {
          await repository.deferAssetSweep({
            assetSweepId: claimed.assetSweepId,
            leaseOwner: signingOwner,
            retryAt: new Date(now().getTime() + defaultSweepRetryMs)
          });
        }
        return {
          status: "sent",
          depositAddressId: claimed.id,
          addressMasked,
          amountNano: claimed.assetSweepAmountAtomic,
          amountTon: formatNanoTon(claimed.assetSweepAmountAtomic),
          balanceNano: claimed.assetSweepAmountAtomic,
          reserveNano: claimed.assetSweepReserveAtomic ?? input.config.reserveNano.toString(),
          recipientAddressMasked: maskValue(claimed.assetSweepRecipientAddress),
          seqno: claimed.assetSweepSeqno
        };
      }
    }
    const recipientAddressValue = claimed.assetSweepRecipientAddress ?? input.config.recipientAddress;
    const reserveNano = claimed.assetSweepReserveAtomic !== null && claimed.assetSweepReserveAtomic !== undefined
      ? BigInt(claimed.assetSweepReserveAtomic)
      : input.config.reserveNano;
    const recipientAddress = Address.parse(recipientAddressValue);
    const balanceNano = await blockchain.getBalance(wallet.address);
    const amountNano = claimed.assetSweepAmountAtomic
      ? BigInt(claimed.assetSweepAmountAtomic)
      : balanceNano - reserveNano;
    confirmedAmountNano = amountNano.toString();
    confirmedReserveNano = reserveNano.toString();

    if (claimed.assetSweepAmountAtomic && balanceNano < amountNano + reserveNano) {
      throw new Error("Persisted GRAM sweep plan exceeds the current wallet balance and reserve.");
    }

    if (amountNano <= BigInt(0) || amountNano < input.config.minSweepNano) {
      const error = `GRAM (ex TON) deposit balance ${formatNanoTon(balanceNano.toString())} does not exceed sweep reserve ${formatNanoTon(input.config.reserveNano.toString())}.`;
      await repository.markSweepFailed({
        id: claimed.id,
        assetSweepId: claimed.assetSweepId,
        leaseOwner: signingOwner,
        error,
        failedAt: now()
      });
      if (input.signingLease) {
        await input.signingLease.release({
          network: input.config.network,
          addressRaw: claimed.addressRaw,
          owner: signingOwner
        });
      }

      return {
        status: "insufficient-balance",
        depositAddressId: claimed.id,
        addressMasked,
        balanceNano: balanceNano.toString(),
        reserveNano: reserveNano.toString(),
        minSweepNano: input.config.minSweepNano.toString(),
        error
      };
    }

    let plannedSeqno = claimed.assetSweepSeqno ?? null;
    if (isAutomaticAssetSweep && plannedSeqno === null) {
      if (!blockchain.getWalletSeqno || !repository.markSweepReady || !claimed.assetSweepId) {
        throw new Error("GRAM asset sweep requires durable seqno planning support.");
      }
      plannedSeqno = await blockchain.getWalletSeqno(wallet);
      await repository.markSweepReady({
        id: claimed.id,
        assetSweepId: claimed.assetSweepId,
        leaseOwner: signingOwner,
        amountNano: amountNano.toString(),
        reserveNano: reserveNano.toString(),
        recipientAddress: recipientAddressValue,
        seqno: plannedSeqno,
        startedAt: now()
      });
    }
    const sweepComment = isAutomaticAssetSweep
      ? `Tonhub automatic GRAM sweep ${claimed.assetSweepId}`
      : `Tonhub payment sweep ${claimed.id}`;
    const sent = await blockchain.sendSweepTransfer({
      wallet,
      secretKey: input.config.secretKey,
      recipientAddress,
      amountNano,
      comment: sweepComment,
      ...(plannedSeqno !== null ? { seqno: plannedSeqno } : {})
    });
    if (isAutomaticAssetSweep && sent.seqno !== plannedSeqno) {
      throw new Error("GRAM sweep broadcast did not preserve the persisted wallet seqno plan.");
    }
    const sentAt = now();

    await repository.markSweepSent({
      id: claimed.id,
      assetSweepId: claimed.assetSweepId,
      leaseOwner: signingOwner,
      amountNano: amountNano.toString(),
      reserveNano: reserveNano.toString(),
      recipientAddress: recipientAddressValue,
      seqno: sent.seqno,
      sentAt
    });
    const confirmation = isAutomaticAssetSweep && blockchain.findSweepTransfer
      ? await blockchain.findSweepTransfer({
          wallet,
          recipientAddress,
          amountNano,
          comment: sweepComment,
          notBefore: sentAt
        })
      : null;
    const broadcastAccepted = !isAutomaticAssetSweep && input.signingLease && sent.seqno !== null
      ? await blockchain.waitForWalletSeqno(wallet, sent.seqno).catch(() => false)
      : false;
    if (isAutomaticAssetSweep && confirmation) {
      return await confirmAutomaticSweep(confirmation);
    }
    if (input.signingLease && broadcastAccepted) {
      await input.signingLease.release({
          network: input.config.network,
          addressRaw: claimed.addressRaw,
          owner: signingOwner
        });
    } else if (isAutomaticAssetSweep && repository.deferAssetSweep && claimed.assetSweepId) {
      await repository.deferAssetSweep({
        assetSweepId: claimed.assetSweepId,
        leaseOwner: signingOwner,
        retryAt: new Date(now().getTime() + defaultSweepRetryMs)
      });
    }

    return {
      status: "sent",
      depositAddressId: claimed.id,
      addressMasked,
      amountNano: amountNano.toString(),
      amountTon: formatNanoTon(amountNano.toString()),
      balanceNano: balanceNano.toString(),
      reserveNano: reserveNano.toString(),
      recipientAddressMasked: maskValue(recipientAddressValue),
      seqno: sent.seqno
    };
  } catch (error) {
    const message = errorMessage(error);
    await repository.markSweepFailed({
      id: claimed.id,
      assetSweepId: claimed.assetSweepId,
      leaseOwner: signingOwner,
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
  signingLease?: TonWalletSigningLease;
  signingLeaseMs?: number;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  const config = input.config ?? resolveTonDepositSweepConfig(input.network);
  const repository = input.repository ?? prismaTonDepositSweepRepository;
  const blockchain = input.blockchain ?? createTonSweepBlockchainClient(config);
  const signingLease = input.signingLease ?? prismaTonWalletSigningLease;
  const batchNow = now();
  const retryBefore = new Date(batchNow.getTime() - (input.retryAfterMs ?? defaultSweepRetryMs));
  const candidates = await repository.listSweepCandidates({
    network: input.network,
    limit: input.limit ?? 10,
    now: batchNow,
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
        signingLease,
        signingLeaseMs: input.signingLeaseMs,
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
