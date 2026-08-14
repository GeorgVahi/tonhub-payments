import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  Address,
  beginCell,
  internal,
  SendMode,
  type Cell,
} from "@ton/core";
import { TonClient, WalletContractV5R1 } from "@ton/ton";
import { prisma } from "../../backend/src/db";
import { reconcileAutomaticAssetSweeps } from "../../backend/src/automatic-sweeps";
import {
  officialMainnetUsdtMasterAddress,
  resolveMainnetUsdtAdapterConfig,
} from "../../backend/src/ton/mainnet-usdt";
import {
  canonicalTonAddress,
  canonicalTonTransactionHash,
} from "../../backend/src/ton/gram-shadow-scanner";
import {
  parseTonDepositSecretKey,
  resolveTonDepositSweepConfig,
  tonPublicKeyFromSecretKey,
} from "./sweep";
import { resumableFailedUsdtSweepStatus } from "../../shared/mainnet-usdt-sweep-state";

export type MainnetUsdtSweepStatus =
  | "QUEUED"
  | "GAS_CHECK"
  | "GAS_TOPUP_REQUIRED"
  | "GAS_TOPUP_SENT"
  | "READY"
  | "SENT"
  | "CONFIRMED"
  | "FAILED";

const activeStatuses: MainnetUsdtSweepStatus[] = [
  "QUEUED",
  "GAS_CHECK",
  "GAS_TOPUP_REQUIRED",
  "GAS_TOPUP_SENT",
  "READY",
  "SENT",
];
const maxStoredErrorLength = 1000;
const uint64Max = (1n << 64n) - 1n;
const defaultGasTargetNano = 150_000_000n;
const defaultDepositReserveNano = 50_000_000n;
const defaultJettonTransferValueNano = 50_000_000n;
const defaultWalletFeeCushionNano = 50_000_000n;
const defaultForwardTonNano = 1n;
const gasTopupDeliveryMarginNano = 1_000_000n;

export type MainnetUsdtSweepConfig = {
  enabled: true;
  network: "mainnet";
  depositSecretKey: Buffer;
  depositPublicKey: Buffer;
  depositPublicKeyHash: string;
  recipientAddress: string;
  recipientAddressRaw: string;
  gasServiceSecretKey: Buffer;
  gasServicePublicKey: Buffer;
  gasServiceAddress: string;
  gasServiceAddressRaw: string;
  gasTargetNano: bigint;
  depositReserveNano: bigint;
  jettonTransferValueNano: bigint;
  walletFeeCushionNano: bigint;
  forwardTonNano: bigint;
  pollMs: number;
  retryMs: number;
  leaseMs: number;
  confirmationGraceMs: number;
  maxAttempts: number;
  jsonRpcEndpoint: string;
  tonCenterBaseUrl: string;
  apiKey?: string;
};

export type MainnetUsdtSweepRecord = {
  id: string;
  idempotencyKey: string;
  status: MainnetUsdtSweepStatus;
  asset: string;
  assetKind: string;
  amountAtomic: string | null;
  reserveAtomic: string | null;
  recipientAddress: string | null;
  transactionHash: string | null;
  seqno: number | null;
  queryId: string | null;
  gasTopupAmountNano: string | null;
  gasServiceAddress?: string | null;
  gasTopupSeqno: number | null;
  reserveTopupAmountNano: string | null;
  reserveTopupSeqno: number | null;
  gasServicePlanKey: string | null;
  attempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  startedAt: Date | null;
  sentAt: Date | null;
  confirmedAt: Date | null;
  lastError: string | null;
  depositAddressId: string;
  orderId: string | null;
  invoiceId: string | null;
  depositNetwork: string;
  depositAddress: string;
  depositAddressRaw: string;
  walletVersion: string;
  walletWorkchain: number;
  walletContext: number;
  walletNetworkGlobalId: number;
  walletPublicKeyHash: string;
  invoiceNetwork: string;
  invoiceAddress: string;
  invoiceAddressRaw: string;
  accountNetwork: string;
  accountAsset: string;
  accountAssetKind: string;
  accountAssetDecimals: number;
  jettonMasterAddress: string;
  jettonWalletAddress: string;
  accountStatus: string;
};

export type MainnetUsdtSweepConfirmation = {
  transactionHash: string;
  transactionLt: string;
  blockchainAt: Date;
};

export type MainnetUsdtSweepRepository = {
  listCandidates: (input: { now: Date; limit: number }) => Promise<MainnetUsdtSweepRecord[]>;
  claim: (input: {
    sweepId: string;
    workerId: string;
    now: Date;
    leaseMs: number;
  }) => Promise<MainnetUsdtSweepRecord | null>;
  transition: (input: {
    sweepId: string;
    leaseOwner: string;
    expectedStatuses: MainnetUsdtSweepStatus[];
    data: Partial<MainnetUsdtSweepRecord>;
  }) => Promise<MainnetUsdtSweepRecord | null>;
  defer: (input: {
    sweepId: string;
    leaseOwner: string;
    retryAt: Date;
    error?: string;
  }) => Promise<void>;
  fail: (input: {
    record: MainnetUsdtSweepRecord;
    leaseOwner: string;
    error: string;
    failedAt: Date;
    retryAt: Date;
  }) => Promise<void>;
  confirm: (input: {
    record: MainnetUsdtSweepRecord;
    leaseOwner: string;
    confirmation: MainnetUsdtSweepConfirmation;
    confirmedAt: Date;
  }) => Promise<void>;
  acquireWalletLease: (input: {
    streamType: "TON_WALLET_OUT" | "USDT_GAS_SERVICE_OUT";
    scopeKey: string;
    owner: string;
    now: Date;
    leaseMs: number;
  }) => Promise<boolean>;
  releaseWalletLease: (input: {
    streamType: "TON_WALLET_OUT" | "USDT_GAS_SERVICE_OUT";
    scopeKey: string;
    owner: string;
  }) => Promise<void>;
  retryFailed: (input: { sweepId: string; requestedAt: Date }) => Promise<boolean>;
  queueForDeposit: (input: {
    depositAddressId: string;
    requestId: string;
    requestedAt: Date;
  }) => Promise<MainnetUsdtSweepRecord>;
};

export type MainnetUsdtSweepBlockchain = {
  getTonBalance: (address: Address) => Promise<bigint>;
  getJettonBalance: (jettonWallet: Address) => Promise<bigint>;
  getWalletSeqno: (wallet: WalletContractV5R1) => Promise<number>;
  sendGasTopup: (input: {
    wallet: WalletContractV5R1;
    secretKey: Buffer;
    destination: Address;
    amountNano: bigint;
    seqno: number;
  }) => Promise<void>;
  sendJettonSweep: (input: {
    wallet: WalletContractV5R1;
    secretKey: Buffer;
    jettonWallet: Address;
    amountAtomic: bigint;
    destination: Address;
    responseDestination: Address;
    queryId: bigint;
    valueNano: bigint;
    forwardTonNano: bigint;
    seqno: number;
  }) => Promise<void>;
  waitForWalletSeqno: (wallet: WalletContractV5R1, previousSeqno: number) => Promise<boolean>;
  findJettonSweep: (input: {
    ownerAddress: Address;
    jettonWallet: Address;
    recipientAddress: Address;
    amountAtomic: bigint;
    queryId: bigint;
    notBefore: Date;
    notAfter: Date;
  }) => Promise<MainnetUsdtSweepConfirmation | null>;
};

export type MainnetUsdtSweepOutcome = {
  sweepId: string;
  status:
    | "gas-topup-sent"
    | "sent"
    | "confirmed"
    | "deferred"
    | "failed"
    | "claimed-by-other";
  error?: string;
};

class SweepInvariantError extends Error {}

function truncateError(value: string) {
  return value.length > maxStoredErrorLength ? value.slice(0, maxStoredErrorLength) : value;
}

function errorMessage(error: unknown) {
  return truncateError(error instanceof Error ? error.message : String(error));
}

function parseNano(value: string | undefined, name: string, fallback: bigint) {
  const normalized = String(value ?? fallback).trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${name} must be a non-negative integer nanotons value.`);
  }
  return BigInt(normalized);
}

function parsePositiveInt(value: string | undefined, name: string, fallback: number) {
  const normalized = String(value ?? fallback).trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return parsed;
}

export function resolveMainnetUsdtSweepConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): MainnetUsdtSweepConfig | null {
  if (!resolveMainnetUsdtAdapterConfig(env)) {
    return null;
  }
  const nativeConfig = resolveTonDepositSweepConfig("mainnet", env as NodeJS.ProcessEnv);
  const gasSecretValue = env.TON_MAINNET_GAS_SERVICE_SECRET_KEY?.trim();
  if (!gasSecretValue) {
    throw new Error("TON_MAINNET_GAS_SERVICE_SECRET_KEY is required by the mainnet USDT sweep worker.");
  }
  const gasServiceSecretKey = parseTonDepositSecretKey(gasSecretValue);
  const gasServicePublicKey = tonPublicKeyFromSecretKey(gasServiceSecretKey);
  const gasServiceWallet = WalletContractV5R1.create({ publicKey: gasServicePublicKey });
  if (gasServiceWallet.address.toRawString() !== nativeConfig.recipientAddressRaw) {
    throw new Error(
      "The gas service wallet must be the mainnet sweep recipient so USDT sweep adds no extra merchant wallet.",
    );
  }
  const gasTargetNano = parseNano(
    env.TON_MAINNET_USDT_GAS_TARGET_NANO,
    "TON_MAINNET_USDT_GAS_TARGET_NANO",
    defaultGasTargetNano,
  );
  const depositReserveNano = parseNano(
    env.TON_MAINNET_USDT_DEPOSIT_RESERVE_NANO,
    "TON_MAINNET_USDT_DEPOSIT_RESERVE_NANO",
    defaultDepositReserveNano,
  );
  const jettonTransferValueNano = parseNano(
    env.TON_MAINNET_USDT_TRANSFER_VALUE_NANO,
    "TON_MAINNET_USDT_TRANSFER_VALUE_NANO",
    defaultJettonTransferValueNano,
  );
  const walletFeeCushionNano = parseNano(
    env.TON_MAINNET_USDT_WALLET_FEE_CUSHION_NANO,
    "TON_MAINNET_USDT_WALLET_FEE_CUSHION_NANO",
    defaultWalletFeeCushionNano,
  );
  if (
    depositReserveNano <= 0n ||
    jettonTransferValueNano <= 0n ||
    walletFeeCushionNano <= 0n ||
    gasTargetNano <= 0n
  ) {
    throw new Error("USDT gas target, transfer value, fee cushion, and retained deposit reserve must be positive.");
  }
  if (gasTargetNano < depositReserveNano + jettonTransferValueNano + walletFeeCushionNano) {
    throw new Error(
      "The USDT gas target must cover the transfer value, positive wallet fee cushion, and retained TON reserve.",
    );
  }
  return {
    enabled: true,
    network: "mainnet",
    depositSecretKey: nativeConfig.secretKey,
    depositPublicKey: nativeConfig.publicKey,
    depositPublicKeyHash: nativeConfig.publicKeyHash,
    recipientAddress: nativeConfig.recipientAddress,
    recipientAddressRaw: nativeConfig.recipientAddressRaw,
    gasServiceSecretKey,
    gasServicePublicKey,
    gasServiceAddress: gasServiceWallet.address.toString(),
    gasServiceAddressRaw: gasServiceWallet.address.toRawString(),
    gasTargetNano,
    depositReserveNano,
    jettonTransferValueNano,
    walletFeeCushionNano,
    forwardTonNano: defaultForwardTonNano,
    pollMs: parsePositiveInt(
      env.TON_MAINNET_USDT_SWEEP_INTERVAL_SECONDS,
      "TON_MAINNET_USDT_SWEEP_INTERVAL_SECONDS",
      5,
    ) * 1000,
    retryMs: parsePositiveInt(
      env.TON_MAINNET_USDT_SWEEP_RETRY_SECONDS,
      "TON_MAINNET_USDT_SWEEP_RETRY_SECONDS",
      60,
    ) * 1000,
    leaseMs: parsePositiveInt(
      env.TON_MAINNET_USDT_SWEEP_LEASE_SECONDS,
      "TON_MAINNET_USDT_SWEEP_LEASE_SECONDS",
      60,
    ) * 1000,
    confirmationGraceMs: parsePositiveInt(
      env.TON_MAINNET_USDT_SWEEP_CONFIRMATION_GRACE_SECONDS,
      "TON_MAINNET_USDT_SWEEP_CONFIRMATION_GRACE_SECONDS",
      300,
    ) * 1000,
    maxAttempts: parsePositiveInt(
      env.TON_MAINNET_USDT_SWEEP_MAX_ATTEMPTS,
      "TON_MAINNET_USDT_SWEEP_MAX_ATTEMPTS",
      10,
    ),
    jsonRpcEndpoint: nativeConfig.jsonRpcEndpoint,
    tonCenterBaseUrl: "https://toncenter.com/api/v3",
    apiKey: nativeConfig.apiKey,
  };
}

export function deriveMainnetUsdtSweepQueryId(sweepId: string) {
  const digest = createHash("sha256").update(`tonhub-usdt-sweep:${sweepId}`).digest();
  return digest.readBigUInt64BE(0);
}

export function buildMainnetUsdtTransferBody(input: {
  queryId: bigint;
  amountAtomic: bigint;
  destination: Address;
  responseDestination: Address;
  forwardTonNano?: bigint;
}): Cell {
  const forwardTonNano = input.forwardTonNano ?? defaultForwardTonNano;
  if (input.queryId < 0n || input.queryId > uint64Max) {
    throw new Error("Jetton sweep queryId must fit uint64.");
  }
  if (input.amountAtomic <= 0n || forwardTonNano < 1n) {
    throw new Error("Jetton sweep amount and notification forward value must be positive.");
  }
  return beginCell()
    .storeUint(0x0f8a7ea5, 32)
    .storeUint(input.queryId, 64)
    .storeCoins(input.amountAtomic)
    .storeAddress(input.destination)
    .storeAddress(input.responseDestination)
    .storeBit(false)
    .storeCoins(forwardTonNano)
    .storeBit(false)
    .endCell();
}

function canonicalRequiredAddress(value: unknown, field: string) {
  const canonical = canonicalTonAddress(value);
  if (!canonical) {
    throw new SweepInvariantError(`${field} is not a valid TON address.`);
  }
  return canonical;
}

function normalizeRecord(value: any): MainnetUsdtSweepRecord {
  const deposit = value?.depositAddress;
  const invoice = deposit?.invoice;
  const accounts = Array.isArray(deposit?.assetAccounts) ? deposit.assetAccounts : [];
  const account = accounts.find((candidate: any) => candidate?.asset === "USDT");
  if (
    !value || !deposit || !invoice || !account ||
    typeof value.id !== "string" || typeof value.idempotencyKey !== "string" ||
    typeof deposit.id !== "string" || typeof invoice.id !== "string"
  ) {
    throw new SweepInvariantError("USDT sweep ownership record is incomplete.");
  }
  return {
    id: value.id,
    idempotencyKey: value.idempotencyKey,
    status: value.status,
    asset: value.asset,
    assetKind: value.assetKind,
    amountAtomic: value.amountAtomic,
    reserveAtomic: value.reserveAtomic,
    recipientAddress: value.recipientAddress,
    transactionHash: value.transactionHash,
    seqno: value.seqno,
    queryId: value.queryId,
    gasTopupAmountNano: value.gasTopupAmountNano,
    gasServiceAddress: value.gasServiceAddress ?? null,
    gasTopupSeqno: value.gasTopupSeqno,
    reserveTopupAmountNano: value.reserveTopupAmountNano,
    reserveTopupSeqno: value.reserveTopupSeqno,
    gasServicePlanKey: value.gasServicePlanKey,
    attempts: value.attempts,
    leaseOwner: value.leaseOwner,
    leaseExpiresAt: value.leaseExpiresAt,
    startedAt: value.startedAt,
    sentAt: value.sentAt,
    confirmedAt: value.confirmedAt,
    lastError: value.lastError,
    depositAddressId: deposit.id,
    orderId: value.orderId,
    invoiceId: value.invoiceId,
    depositNetwork: deposit.network,
    depositAddress: deposit.address,
    depositAddressRaw: deposit.addressRaw,
    walletVersion: deposit.walletVersion,
    walletWorkchain: deposit.walletWorkchain,
    walletContext: deposit.walletContext,
    walletNetworkGlobalId: deposit.walletNetworkGlobalId,
    walletPublicKeyHash: deposit.walletPublicKeyHash,
    invoiceNetwork: invoice.network,
    invoiceAddress: invoice.address,
    invoiceAddressRaw: invoice.addressRaw,
    accountNetwork: account.network,
    accountAsset: account.asset,
    accountAssetKind: account.assetKind,
    accountAssetDecimals: account.assetDecimals,
    jettonMasterAddress: account.jettonMasterAddress,
    jettonWalletAddress: account.assetWalletAddress,
    accountStatus: account.status,
  };
}

function assertSweepOwnership(record: MainnetUsdtSweepRecord, config: MainnetUsdtSweepConfig) {
  const ownerAddresses = [
    record.depositAddress,
    record.depositAddressRaw,
    record.invoiceAddress,
    record.invoiceAddressRaw,
  ].map((value, index) => canonicalRequiredAddress(value, `USDT sweep owner address ${index + 1}`));
  const masterAddress = canonicalRequiredAddress(record.jettonMasterAddress, "USDT master address");
  const jettonWalletAddress = canonicalRequiredAddress(record.jettonWalletAddress, "USDT wallet address");
  if (
    record.status === "CONFIRMED" ||
    record.asset !== "USDT" ||
    record.assetKind !== "JETTON" ||
    record.depositNetwork !== "mainnet" ||
    record.invoiceNetwork !== "mainnet" ||
    ownerAddresses.some((value) => value !== ownerAddresses[0]) ||
    record.walletVersion !== "v5r1" ||
    record.walletPublicKeyHash !== config.depositPublicKeyHash ||
    record.accountNetwork !== "mainnet" ||
    record.accountAsset !== "USDT" ||
    record.accountAssetKind !== "JETTON" ||
    record.accountAssetDecimals !== 6 ||
    record.accountStatus !== "VERIFIED" ||
    masterAddress !== officialMainnetUsdtMasterAddress ||
    !jettonWalletAddress
  ) {
    throw new SweepInvariantError("Mainnet USDT sweep ownership evidence is inconsistent.");
  }
  if (record.recipientAddress && canonicalRequiredAddress(record.recipientAddress, "Sweep recipient") !== config.recipientAddressRaw) {
    throw new SweepInvariantError("Mainnet USDT sweep recipient cannot be changed after planning.");
  }
}

function walletForRecord(record: MainnetUsdtSweepRecord, config: MainnetUsdtSweepConfig) {
  const wallet = WalletContractV5R1.create({
    publicKey: config.depositPublicKey,
    workchain: record.walletWorkchain,
    walletId: {
      networkGlobalId: record.walletNetworkGlobalId,
      context: record.walletContext,
    },
  });
  if (wallet.address.toRawString() !== canonicalRequiredAddress(record.depositAddressRaw, "Deposit wallet")) {
    throw new SweepInvariantError("Deposit secret does not reconstruct the USDT sweep owner wallet.");
  }
  return wallet;
}

function gasWallet(config: MainnetUsdtSweepConfig) {
  const wallet = WalletContractV5R1.create({ publicKey: config.gasServicePublicKey });
  if (wallet.address.toRawString() !== config.gasServiceAddressRaw) {
    throw new SweepInvariantError("Gas service secret does not reconstruct the configured gas wallet.");
  }
  return wallet;
}

const sweepInclude = {
  depositAddress: {
    include: {
      invoice: true,
      assetAccounts: { where: { asset: "USDT" } },
    },
  },
};

type PrismaLike = {
  $transaction: <T>(handler: (tx: any) => Promise<T>) => Promise<T>;
  tonhubAssetSweep: any;
  tonhubDepositAddress: any;
  tonhubScanCursor: any;
  tonhubRecoveryCase: any;
  tonhubPaymentMovement: any;
};

async function findSweep(db: PrismaLike, id: string) {
  const value = await db.tonhubAssetSweep.findUnique({ where: { id }, include: sweepInclude });
  return value ? normalizeRecord(value) : null;
}

export function createPrismaMainnetUsdtSweepRepository(db: PrismaLike): MainnetUsdtSweepRepository {
  return {
    listCandidates: async ({ now, limit }) => {
      const rows = await db.tonhubAssetSweep.findMany({
        where: {
          asset: "USDT",
          assetKind: "JETTON",
          status: { in: activeStatuses },
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
          depositAddress: { network: "mainnet", invoice: { network: "mainnet" } },
        },
        orderBy: [{ leaseExpiresAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        take: limit,
        include: sweepInclude,
      });
      return rows.map(normalizeRecord);
    },
    claim: async ({ sweepId, workerId, now, leaseMs }) => {
      const claimed = await db.tonhubAssetSweep.updateMany({
        where: {
          id: sweepId,
          status: { in: activeStatuses },
          OR: [
            { leaseOwner: workerId },
            { leaseExpiresAt: null },
            { leaseExpiresAt: { lte: now } },
          ],
        },
        data: {
          leaseOwner: workerId,
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
          attempts: { increment: 1 },
          lastError: null,
        },
      });
      if (claimed.count === 1) {
        await db.tonhubAssetSweep.updateMany({
          where: { id: sweepId, leaseOwner: workerId, startedAt: null },
          data: { startedAt: now },
        });
      }
      return claimed.count === 1 ? findSweep(db, sweepId) : null;
    },
    transition: async ({ sweepId, leaseOwner, expectedStatuses, data }) => {
      const updated = await db.tonhubAssetSweep.updateMany({
        where: { id: sweepId, leaseOwner, status: { in: expectedStatuses } },
        data,
      });
      return updated.count === 1 ? findSweep(db, sweepId) : null;
    },
    defer: async ({ sweepId, leaseOwner, retryAt, error }) => {
      await db.tonhubAssetSweep.updateMany({
        where: { id: sweepId, leaseOwner, status: { in: activeStatuses } },
        data: {
          leaseOwner: null,
          leaseExpiresAt: retryAt,
          ...(error ? { lastError: truncateError(error) } : {}),
        },
      });
    },
    fail: async ({ record, leaseOwner, error, failedAt, retryAt }) => {
      await db.$transaction(async (tx) => {
        const failed = await tx.tonhubAssetSweep.updateMany({
          where: { id: record.id, leaseOwner, status: { in: activeStatuses } },
          data: {
            status: "FAILED",
            leaseOwner: null,
            leaseExpiresAt: retryAt,
            lastError: truncateError(error),
          },
        });
        if (failed.count !== 1) {
          return;
        }
        await tx.tonhubRecoveryCase.upsert({
          where: { id: `asset-sweep:${record.id}` },
          create: {
            id: `asset-sweep:${record.id}`,
            orderId: record.orderId,
            invoiceId: record.invoiceId,
            reason: "USDT_SWEEP_FAILED",
            title: "Mainnet USDT sweep requires recovery",
            details: {
              sweepId: record.id,
              depositAddressId: record.depositAddressId,
              error: truncateError(error),
              failedAt: failedAt.toISOString(),
            },
          },
          update: {
            status: "OPEN",
            reason: "USDT_SWEEP_FAILED",
            title: "Mainnet USDT sweep requires recovery",
            details: {
              sweepId: record.id,
              depositAddressId: record.depositAddressId,
              error: truncateError(error),
              failedAt: failedAt.toISOString(),
            },
            resolvedBy: null,
            resolvedAt: null,
          },
        });
      });
    },
    confirm: async ({ record, leaseOwner, confirmation, confirmedAt }) => {
      await db.$transaction(async (tx) => {
        if (record.orderId) {
          await tx.$queryRawUnsafe(
            `SELECT "id" FROM "TonhubPaymentOrder" WHERE "id" = $1 FOR UPDATE`,
            record.orderId,
          );
        }
        const confirmed = await tx.tonhubAssetSweep.updateMany({
          where: { id: record.id, leaseOwner, status: "SENT" },
          data: {
            status: "CONFIRMED",
            transactionHash: confirmation.transactionHash,
            confirmedAt,
            leaseOwner: null,
            leaseExpiresAt: null,
            gasServicePlanKey: null,
            lastError: null,
          },
        });
        if (confirmed.count !== 1) {
          throw new Error("USDT sweep confirmation lost its lease or lifecycle state.");
        }
        const fingerprint = `ton:mainnet:jetton-out:${confirmation.transactionHash}:${record.queryId}:${officialMainnetUsdtMasterAddress}`;
        await tx.tonhubPaymentMovement.createMany({
          data: [{
            fingerprint,
            depositAddressId: record.depositAddressId,
            network: "mainnet",
            direction: "OUTGOING",
            asset: "USDT",
            assetKind: "JETTON",
            assetDecimals: 6,
            amountAtomic: record.amountAtomic,
            fromAddress: record.depositAddressRaw,
            toAddress: record.recipientAddress,
            ownerAddress: record.depositAddressRaw,
            jettonMasterAddress: officialMainnetUsdtMasterAddress,
            jettonWalletAddress: record.jettonWalletAddress,
            transactionHash: confirmation.transactionHash,
            transactionLt: confirmation.transactionLt,
            queryId: record.queryId,
            blockchainAt: confirmation.blockchainAt,
            rawPayload: {
              evidenceVersion: 1,
              provider: "toncenter-v3-jetton-transfers",
              officialUsdt: true,
              sweepId: record.id,
            },
          }],
          skipDuplicates: true,
        });
        if (record.orderId && record.invoiceId) {
          await reconcileAutomaticAssetSweeps({
            tx: tx as any,
            orderId: record.orderId,
            invoiceId: record.invoiceId,
            triggeredAt: confirmedAt,
          });
        }
        await tx.tonhubRecoveryCase.updateMany({
          where: { id: `asset-sweep:${record.id}`, status: { in: ["OPEN", "REVIEWED"] } },
          data: { status: "RESOLVED", resolvedBy: "system:usdt-sweep", resolvedAt: confirmedAt },
        });
      });
    },
    acquireWalletLease: async ({ streamType, scopeKey, owner, now, leaseMs }) => {
      await db.tonhubScanCursor.createMany({
        data: { network: "mainnet", streamType, scopeKey },
        skipDuplicates: true,
      });
      const result = await db.tonhubScanCursor.updateMany({
        where: {
          network: "mainnet",
          streamType,
          scopeKey,
          OR: [
            { leaseOwner: owner },
            { leaseExpiresAt: null },
            { leaseExpiresAt: { lte: now } },
          ],
        },
        data: { leaseOwner: owner, leaseExpiresAt: new Date(now.getTime() + leaseMs) },
      });
      return result.count === 1;
    },
    releaseWalletLease: async ({ streamType, scopeKey, owner }) => {
      await db.tonhubScanCursor.updateMany({
        where: { network: "mainnet", streamType, scopeKey, leaseOwner: owner },
        data: { leaseOwner: null, leaseExpiresAt: null },
      });
    },
    retryFailed: async ({ sweepId, requestedAt }) => {
      return db.$transaction(async (tx) => {
        const stored = await tx.tonhubAssetSweep.findUnique({ where: { id: sweepId } });
        if (!stored || stored.asset !== "USDT" || stored.status !== "FAILED") {
          return false;
        }
        const retried = await tx.tonhubAssetSweep.updateMany({
          where: { id: sweepId, asset: "USDT", status: "FAILED" },
          data: {
            status: resumableFailedUsdtSweepStatus(stored),
            attempts: 0,
            leaseOwner: null,
            leaseExpiresAt: requestedAt,
            lastError: null,
          },
        });
        return retried.count === 1;
      });
    },
    queueForDeposit: async ({ depositAddressId, requestId, requestedAt }) => {
      const deposit = await db.tonhubDepositAddress.findUnique({
        where: { id: depositAddressId },
        include: { invoice: true, assetAccounts: { where: { asset: "USDT" } } },
      });
      if (!deposit?.invoice || deposit.network !== "mainnet" || deposit.invoice.network !== "mainnet") {
        throw new SweepInvariantError("Manual USDT sweep requires an owned mainnet invoice deposit.");
      }
      const account = deposit.assetAccounts?.[0];
      const ownerAddresses = [
        deposit.address,
        deposit.addressRaw,
        deposit.invoice.address,
        deposit.invoice.addressRaw,
      ].map(canonicalTonAddress);
      if (
        !account ||
        ownerAddresses.some((address) => !address || address !== ownerAddresses[0]) ||
        account.network !== "mainnet" ||
        account.asset !== "USDT" ||
        account.status !== "VERIFIED" || account.assetKind !== "JETTON" ||
        account.assetDecimals !== 6 ||
        canonicalTonAddress(account.jettonMasterAddress) !== officialMainnetUsdtMasterAddress ||
        !canonicalTonAddress(account.assetWalletAddress)
      ) {
        throw new SweepInvariantError("Manual USDT sweep requires the verified official asset wallet.");
      }
      const idempotencyKey = `manual-usdt:${depositAddressId}:${requestId}`;
      await db.tonhubAssetSweep.createMany({
        data: {
          idempotencyKey,
          depositAddressId,
          orderId: deposit.invoice.orderId,
          invoiceId: deposit.invoice.id,
          asset: "USDT",
          assetKind: "JETTON",
          status: "QUEUED",
          leaseExpiresAt: requestedAt,
        },
        skipDuplicates: true,
      });
      const stored = await db.tonhubAssetSweep.findFirst({
        where: {
          depositAddressId,
          asset: "USDT",
          OR: [{ idempotencyKey }, { status: { in: [...activeStatuses, "FAILED"] } }],
        },
        orderBy: { createdAt: "desc" },
        include: sweepInclude,
      });
      if (!stored) {
        throw new Error("Manual USDT sweep could not be queued or reused.");
      }
      return normalizeRecord(stored);
    },
  };
}

export const prismaMainnetUsdtSweepRepository = createPrismaMainnetUsdtSweepRepository(
  prisma as unknown as PrismaLike,
);

function requirePositiveAtomic(value: string | null, field: string) {
  if (!value || !/^[1-9]\d*$/.test(value)) {
    throw new SweepInvariantError(`${field} is not a positive atomic integer.`);
  }
  return BigInt(value);
}

function requireSeqno(value: number | null, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new SweepInvariantError(`${field} is not a non-negative seqno.`);
  }
  return Number(value);
}

function requireQueryId(value: string | null) {
  if (!value || !/^\d+$/.test(value) || BigInt(value) > uint64Max) {
    throw new SweepInvariantError("USDT sweep queryId is invalid.");
  }
  return BigInt(value);
}

function signingLeaseOwner(
  workerId: string,
  record: MainnetUsdtSweepRecord,
  operation: "gas" | "deposit" | "reserve",
) {
  return `${workerId}:${record.id}:${operation}`;
}

function gasServicePlanKey(config: MainnetUsdtSweepConfig, seqno: number) {
  return `${config.gasServiceAddressRaw}:${seqno}`;
}

function gasTopupAmountForDeficit(deficit: bigint) {
  return deficit > 0n ? deficit + gasTopupDeliveryMarginNano : 0n;
}

async function requiredTransition(
  repository: MainnetUsdtSweepRepository,
  record: MainnetUsdtSweepRecord,
  leaseOwner: string,
  expectedStatuses: MainnetUsdtSweepStatus[],
  data: Partial<MainnetUsdtSweepRecord>,
) {
  const updated = await repository.transition({
    sweepId: record.id,
    leaseOwner,
    expectedStatuses,
    data,
  });
  if (!updated) {
    throw new Error("USDT sweep lost its lifecycle lease.");
  }
  return updated;
}

async function releaseIfAccepted(input: {
  repository: MainnetUsdtSweepRepository;
  blockchain: MainnetUsdtSweepBlockchain;
  wallet: WalletContractV5R1;
  seqno: number;
  streamType: "TON_WALLET_OUT" | "USDT_GAS_SERVICE_OUT";
  scopeKey: string;
  owner: string;
}) {
  if (await input.blockchain.waitForWalletSeqno(input.wallet, input.seqno)) {
    await input.repository.releaseWalletLease(input);
  }
}

async function sendPlannedTopup(input: {
  record: MainnetUsdtSweepRecord;
  config: MainnetUsdtSweepConfig;
  repository: MainnetUsdtSweepRepository;
  blockchain: MainnetUsdtSweepBlockchain;
  leaseOwner: string;
  now: Date;
}) {
  const wallet = gasWallet(input.config);
  const amountNano = requirePositiveAtomic(input.record.gasTopupAmountNano, "Gas top-up amount");
  const plannedSeqno = requireSeqno(input.record.gasTopupSeqno, "Gas top-up");
  if (input.record.gasServicePlanKey !== gasServicePlanKey(input.config, plannedSeqno)) {
    throw new SweepInvariantError("Gas top-up plan is not globally reserved for its wallet seqno.");
  }
  const scopeKey = input.config.gasServiceAddressRaw;
  const signingOwner = signingLeaseOwner(input.leaseOwner, input.record, "gas");
  if (!await input.repository.acquireWalletLease({
    streamType: "USDT_GAS_SERVICE_OUT",
    scopeKey,
    owner: signingOwner,
    now: input.now,
    leaseMs: input.config.leaseMs,
  })) {
    return null;
  }
  const currentSeqno = await input.blockchain.getWalletSeqno(wallet);
  if (currentSeqno < plannedSeqno) {
    throw new SweepInvariantError("Gas service seqno moved backwards from the persisted top-up plan.");
  }
  let current = input.record;
  if (currentSeqno === plannedSeqno) {
    const depositBalance = await input.blockchain.getTonBalance(
      Address.parse(input.record.depositAddressRaw),
    );
    const currentDeficit = depositBalance < input.config.gasTargetNano
      ? input.config.gasTargetNano - depositBalance
      : 0n;
    const currentTopupAmount = gasTopupAmountForDeficit(currentDeficit);
    if (currentTopupAmount !== amountNano && currentDeficit > 0n) {
      current = await requiredTransition(
        input.repository,
        current,
        input.leaseOwner,
        ["GAS_TOPUP_REQUIRED"],
        { gasTopupAmountNano: currentTopupAmount.toString() },
      );
    }
    if (currentDeficit === 0n) {
      current = await requiredTransition(
        input.repository,
        current,
        input.leaseOwner,
        ["GAS_TOPUP_REQUIRED", "GAS_TOPUP_SENT"],
        { status: "GAS_TOPUP_SENT" },
      );
      await input.repository.releaseWalletLease({
        streamType: "USDT_GAS_SERVICE_OUT",
        scopeKey,
        owner: signingOwner,
      });
      return current;
    }
    await input.blockchain.sendGasTopup({
      wallet,
      secretKey: input.config.gasServiceSecretKey,
      destination: Address.parse(input.record.depositAddressRaw),
      amountNano: currentTopupAmount,
      seqno: plannedSeqno,
    });
  }
  current = await requiredTransition(
    input.repository,
    current,
    input.leaseOwner,
    ["GAS_TOPUP_REQUIRED", "GAS_TOPUP_SENT"],
    { status: "GAS_TOPUP_SENT" },
  );
  await releaseIfAccepted({
    repository: input.repository,
    blockchain: input.blockchain,
    wallet,
    seqno: plannedSeqno,
    streamType: "USDT_GAS_SERVICE_OUT",
    scopeKey,
    owner: signingOwner,
  });
  return current;
}

async function sendReadySweep(input: {
  record: MainnetUsdtSweepRecord;
  config: MainnetUsdtSweepConfig;
  repository: MainnetUsdtSweepRepository;
  blockchain: MainnetUsdtSweepBlockchain;
  leaseOwner: string;
  now: Date;
}) {
  const wallet = walletForRecord(input.record, input.config);
  const scopeKey = input.record.depositAddressRaw;
  const signingOwner = signingLeaseOwner(input.leaseOwner, input.record, "deposit");
  if (!await input.repository.acquireWalletLease({
    streamType: "TON_WALLET_OUT",
    scopeKey,
    owner: signingOwner,
    now: input.now,
    leaseMs: input.config.leaseMs,
  })) {
    return null;
  }
  const plannedSeqno = requireSeqno(input.record.seqno, "Deposit sweep");
  const currentSeqno = await input.blockchain.getWalletSeqno(wallet);
  if (currentSeqno < plannedSeqno) {
    throw new SweepInvariantError("Deposit wallet seqno moved backwards from the persisted sweep plan.");
  }
  const amountAtomic = requirePositiveAtomic(input.record.amountAtomic, "USDT sweep amount");
  const queryId = requireQueryId(input.record.queryId);
  if (currentSeqno === plannedSeqno) {
    await input.blockchain.sendJettonSweep({
      wallet,
      secretKey: input.config.depositSecretKey,
      jettonWallet: Address.parse(input.record.jettonWalletAddress),
      amountAtomic,
      destination: Address.parse(input.config.recipientAddressRaw),
      responseDestination: wallet.address,
      queryId,
      valueNano: input.config.jettonTransferValueNano,
      forwardTonNano: input.config.forwardTonNano,
      seqno: plannedSeqno,
    });
  }
  const sent = await requiredTransition(
    input.repository,
    input.record,
    input.leaseOwner,
    ["READY"],
    { status: "SENT", sentAt: input.record.sentAt ?? input.now },
  );
  await releaseIfAccepted({
    repository: input.repository,
    blockchain: input.blockchain,
    wallet,
    seqno: plannedSeqno,
    streamType: "TON_WALLET_OUT",
    scopeKey,
    owner: signingOwner,
  });
  return sent;
}

async function repairConfirmedReserve(input: {
  record: MainnetUsdtSweepRecord;
  config: MainnetUsdtSweepConfig;
  repository: MainnetUsdtSweepRepository;
  blockchain: MainnetUsdtSweepBlockchain;
  leaseOwner: string;
  now: Date;
  depositWallet: WalletContractV5R1;
  currentBalance: bigint;
}) {
  if (input.currentBalance >= input.config.depositReserveNano) {
    return { ready: true, sent: false };
  }
  const serviceWallet = gasWallet(input.config);
  const scopeKey = input.config.gasServiceAddressRaw;
  const signingOwner = signingLeaseOwner(input.leaseOwner, input.record, "reserve");
  if (!await input.repository.acquireWalletLease({
    streamType: "USDT_GAS_SERVICE_OUT",
    scopeKey,
    owner: signingOwner,
    now: input.now,
    leaseMs: input.config.leaseMs,
  })) {
    return { ready: false, sent: false };
  }
  let current = input.record;
  if (current.reserveTopupAmountNano === null || current.reserveTopupSeqno === null) {
    const plannedSeqno = await input.blockchain.getWalletSeqno(serviceWallet);
    current = await requiredTransition(
      input.repository,
      current,
      input.leaseOwner,
      ["SENT"],
      {
        reserveTopupAmountNano: gasTopupAmountForDeficit(
          input.config.depositReserveNano - input.currentBalance,
        ).toString(),
        reserveTopupSeqno: plannedSeqno,
        gasServiceAddress: input.config.gasServiceAddressRaw,
        gasServicePlanKey: gasServicePlanKey(input.config, plannedSeqno),
      },
    );
  }
  const plannedSeqno = requireSeqno(current.reserveTopupSeqno, "Reserve repair top-up");
  if (current.gasServicePlanKey !== gasServicePlanKey(input.config, plannedSeqno)) {
    throw new SweepInvariantError("Reserve repair plan is not globally reserved for its wallet seqno.");
  }
  const currentSeqno = await input.blockchain.getWalletSeqno(serviceWallet);
  if (currentSeqno < plannedSeqno) {
    throw new SweepInvariantError("Gas service seqno moved backwards from the reserve repair plan.");
  }
  const currentBalance = await input.blockchain.getTonBalance(input.depositWallet.address);
  if (currentBalance >= input.config.depositReserveNano) {
    await input.repository.releaseWalletLease({
      streamType: "USDT_GAS_SERVICE_OUT",
      scopeKey,
      owner: signingOwner,
    });
    return { ready: true, sent: false };
  }
  if (currentSeqno > plannedSeqno) {
    if (current.attempts >= input.config.maxAttempts) {
      throw new SweepInvariantError(
        "Reserve repair top-up was accepted but the deposit reserve is still below target.",
      );
    }
    return { ready: false, sent: false };
  }
  const deficit = input.config.depositReserveNano - currentBalance;
  const topupAmount = gasTopupAmountForDeficit(deficit);
  if (current.reserveTopupAmountNano !== topupAmount.toString()) {
    current = await requiredTransition(
      input.repository,
      current,
      input.leaseOwner,
      ["SENT"],
      { reserveTopupAmountNano: topupAmount.toString() },
    );
  }
  await input.blockchain.sendGasTopup({
    wallet: serviceWallet,
    secretKey: input.config.gasServiceSecretKey,
    destination: input.depositWallet.address,
    amountNano: topupAmount,
    seqno: plannedSeqno,
  });
  await releaseIfAccepted({
    repository: input.repository,
    blockchain: input.blockchain,
    wallet: serviceWallet,
    seqno: plannedSeqno,
    streamType: "USDT_GAS_SERVICE_OUT",
    scopeKey,
    owner: signingOwner,
  });
  return {
    ready: await input.blockchain.getTonBalance(input.depositWallet.address) >=
      input.config.depositReserveNano,
    sent: true,
  };
}

async function advanceSweep(input: {
  record: MainnetUsdtSweepRecord;
  config: MainnetUsdtSweepConfig;
  repository: MainnetUsdtSweepRepository;
  blockchain: MainnetUsdtSweepBlockchain;
  leaseOwner: string;
  now: Date;
}): Promise<MainnetUsdtSweepOutcome> {
  let current = input.record;
  assertSweepOwnership(current, input.config);
  const depositWallet = walletForRecord(current, input.config);
  const jettonWallet = Address.parse(current.jettonWalletAddress);

  if (current.status === "SENT") {
    const amountAtomic = requirePositiveAtomic(current.amountAtomic, "USDT sweep amount");
    const queryId = requireQueryId(current.queryId);
    const confirmation = await input.blockchain.findJettonSweep({
      ownerAddress: depositWallet.address,
      jettonWallet,
      recipientAddress: Address.parse(input.config.recipientAddressRaw),
      amountAtomic,
      queryId,
      notBefore: current.sentAt ?? current.startedAt ?? input.now,
      notAfter: input.now,
    });
    if (confirmation) {
      const balance = await input.blockchain.getTonBalance(depositWallet.address);
      const reserve = await repairConfirmedReserve({
        ...input,
        record: current,
        depositWallet,
        currentBalance: balance,
      });
      if (!reserve.ready) {
        return {
          sweepId: current.id,
          status: reserve.sent ? "gas-topup-sent" : "deferred",
        };
      }
      await input.repository.confirm({
        record: current,
        leaseOwner: input.leaseOwner,
        confirmation,
        confirmedAt: input.now,
      });
      return { sweepId: current.id, status: "confirmed" };
    }
    const seqno = requireSeqno(current.seqno, "Deposit sweep");
    const chainSeqno = await input.blockchain.getWalletSeqno(depositWallet);
    if (chainSeqno < seqno) {
      throw new SweepInvariantError("Deposit wallet seqno moved backwards while confirming USDT sweep.");
    }
    if (chainSeqno > seqno) {
      const sentAt = current.sentAt ?? current.startedAt ?? input.now;
      if (input.now.getTime() - sentAt.getTime() >= input.config.confirmationGraceMs) {
        throw new SweepInvariantError("Deposit seqno advanced without matching official USDT sweep evidence.");
      }
      return { sweepId: current.id, status: "deferred" };
    }
    current = await requiredTransition(
      input.repository,
      current,
      input.leaseOwner,
      ["SENT"],
      { status: "READY" },
    );
  }

  if (current.status === "READY") {
    const sent = await sendReadySweep({ ...input, record: current });
    return { sweepId: current.id, status: sent ? "sent" : "deferred" };
  }

  if (current.status === "GAS_TOPUP_REQUIRED") {
    const sent = await sendPlannedTopup({ ...input, record: current });
    return { sweepId: current.id, status: sent ? "gas-topup-sent" : "deferred" };
  }

  if (current.status === "GAS_TOPUP_SENT") {
    const tonBalance = await input.blockchain.getTonBalance(depositWallet.address);
    if (tonBalance < input.config.gasTargetNano) {
      const plannedSeqno = requireSeqno(current.gasTopupSeqno, "Gas top-up");
      const chainSeqno = await input.blockchain.getWalletSeqno(gasWallet(input.config));
      if (chainSeqno < plannedSeqno) {
        throw new SweepInvariantError("Gas service seqno moved backwards while awaiting top-up.");
      }
      if (chainSeqno === plannedSeqno) {
        current = await requiredTransition(
          input.repository,
          current,
          input.leaseOwner,
          ["GAS_TOPUP_SENT"],
          { status: "GAS_TOPUP_REQUIRED" },
        );
        const resent = await sendPlannedTopup({ ...input, record: current });
        return { sweepId: current.id, status: resent ? "gas-topup-sent" : "deferred" };
      }
      if (current.attempts >= input.config.maxAttempts) {
        throw new SweepInvariantError("Gas top-up was accepted but the deposit balance never reached its target.");
      }
    }
  }

  const amountAtomic = await input.blockchain.getJettonBalance(jettonWallet);
  if (amountAtomic <= 0n) {
    if (current.attempts >= input.config.maxAttempts) {
      throw new SweepInvariantError("Observed USDT movement has no balance in the verified deposit asset wallet.");
    }
    return { sweepId: current.id, status: "deferred" };
  }
  const tonBalance = await input.blockchain.getTonBalance(depositWallet.address);
  if (tonBalance < input.config.gasTargetNano) {
    const topupNano = gasTopupAmountForDeficit(input.config.gasTargetNano - tonBalance);
    const serviceWallet = gasWallet(input.config);
    const signingOwner = signingLeaseOwner(input.leaseOwner, current, "gas");
    if (!await input.repository.acquireWalletLease({
      streamType: "USDT_GAS_SERVICE_OUT",
      scopeKey: input.config.gasServiceAddressRaw,
      owner: signingOwner,
      now: input.now,
      leaseMs: input.config.leaseMs,
    })) {
      return { sweepId: current.id, status: "deferred" };
    }
    const topupSeqno = await input.blockchain.getWalletSeqno(serviceWallet);
    current = await requiredTransition(
      input.repository,
      current,
      input.leaseOwner,
      ["QUEUED", "GAS_CHECK", "GAS_TOPUP_SENT"],
      {
        status: "GAS_TOPUP_REQUIRED",
        gasTopupAmountNano: topupNano.toString(),
        gasTopupSeqno: topupSeqno,
        gasServiceAddress: input.config.gasServiceAddressRaw,
        gasServicePlanKey: gasServicePlanKey(input.config, topupSeqno),
      },
    );
    const sent = await sendPlannedTopup({ ...input, record: current });
    return { sweepId: current.id, status: sent ? "gas-topup-sent" : "deferred" };
  }

  if (current.status !== "GAS_CHECK") {
    current = await requiredTransition(
      input.repository,
      current,
      input.leaseOwner,
      ["QUEUED", "GAS_TOPUP_SENT"],
      { status: "GAS_CHECK", gasServicePlanKey: null },
    );
  }
  if (!await input.repository.acquireWalletLease({
    streamType: "TON_WALLET_OUT",
    scopeKey: current.depositAddressRaw,
    owner: signingLeaseOwner(input.leaseOwner, current, "deposit"),
    now: input.now,
    leaseMs: input.config.leaseMs,
  })) {
    return { sweepId: current.id, status: "deferred" };
  }
  const seqno = await input.blockchain.getWalletSeqno(depositWallet);
  current = await requiredTransition(
    input.repository,
    current,
    input.leaseOwner,
    ["GAS_CHECK"],
    {
      status: "READY",
      amountAtomic: amountAtomic.toString(),
      reserveAtomic: "0",
      recipientAddress: input.config.recipientAddressRaw,
      queryId: deriveMainnetUsdtSweepQueryId(current.id).toString(),
      seqno,
    },
  );
  const sent = await sendReadySweep({ ...input, record: current });
  return { sweepId: current.id, status: sent ? "sent" : "deferred" };
}

export async function processMainnetUsdtSweep(input: {
  record: MainnetUsdtSweepRecord;
  config: MainnetUsdtSweepConfig;
  repository?: MainnetUsdtSweepRepository;
  blockchain?: MainnetUsdtSweepBlockchain;
  workerId?: string;
  now?: () => Date;
}): Promise<MainnetUsdtSweepOutcome> {
  const repository = input.repository ?? prismaMainnetUsdtSweepRepository;
  const blockchain = input.blockchain ?? createMainnetUsdtSweepBlockchain(input.config);
  const workerId = input.workerId ?? `usdt-sweep-${process.pid}-${randomUUID()}`;
  const clock = input.now ?? (() => new Date());
  const claimed = await repository.claim({
    sweepId: input.record.id,
    workerId,
    now: clock(),
    leaseMs: input.config.leaseMs,
  });
  if (!claimed) {
    return { sweepId: input.record.id, status: "claimed-by-other" };
  }
  try {
    const outcome = await advanceSweep({
      record: claimed,
      config: input.config,
      repository,
      blockchain,
      leaseOwner: workerId,
      now: clock(),
    });
    if (["deferred", "gas-topup-sent", "sent"].includes(outcome.status)) {
      await repository.defer({
        sweepId: claimed.id,
        leaseOwner: workerId,
        retryAt: new Date(clock().getTime() + (
          outcome.status === "deferred" ? input.config.retryMs : input.config.pollMs
        )),
      });
    }
    return outcome;
  } catch (error) {
    const message = errorMessage(error);
    if (error instanceof SweepInvariantError || claimed.attempts >= input.config.maxAttempts) {
      const failedAt = clock();
      await repository.fail({
        record: claimed,
        leaseOwner: workerId,
        error: message,
        failedAt,
        retryAt: new Date(failedAt.getTime() + input.config.retryMs),
      });
      return { sweepId: claimed.id, status: "failed", error: message };
    }
    await repository.defer({
      sweepId: claimed.id,
      leaseOwner: workerId,
      retryAt: new Date(clock().getTime() + input.config.retryMs),
      error: message,
    });
    return { sweepId: claimed.id, status: "deferred", error: message };
  }
}

function integerText(value: unknown) {
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value).toString() : null;
}

function unixDate(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > 0xffffffff) {
    return null;
  }
  return new Date(Number(value) * 1000);
}

export function createMainnetUsdtSweepBlockchain(
  config: MainnetUsdtSweepConfig,
  fetchImpl: typeof fetch = fetch,
): MainnetUsdtSweepBlockchain {
  const client = new TonClient({ endpoint: config.jsonRpcEndpoint, apiKey: config.apiKey });
  return {
    getTonBalance: (address) => client.getBalance(address),
    getJettonBalance: async (jettonWallet) => {
      const result = await client.runMethod(jettonWallet, "get_wallet_data");
      return result.stack.readBigNumber();
    },
    getWalletSeqno: async (wallet) => client.open(wallet).getSeqno(),
    sendGasTopup: async ({ wallet, secretKey, destination, amountNano, seqno }) => {
      await client.open(wallet).sendTransfer({
        seqno,
        secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        messages: [internal({ to: destination, value: amountNano, bounce: false })],
      });
    },
    sendJettonSweep: async (input) => {
      const body = buildMainnetUsdtTransferBody({
        queryId: input.queryId,
        amountAtomic: input.amountAtomic,
        destination: input.destination,
        responseDestination: input.responseDestination,
        forwardTonNano: input.forwardTonNano,
      });
      await client.open(input.wallet).sendTransfer({
        seqno: input.seqno,
        secretKey: input.secretKey,
        sendMode: (SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS) as SendMode,
        messages: [internal({
          to: input.jettonWallet,
          value: input.valueNano,
          bounce: true,
          body,
        })],
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
    },
    findJettonSweep: async (input) => {
      const url = new URL(`${config.tonCenterBaseUrl}/jetton/transfers`);
      url.searchParams.set("owner_address", input.ownerAddress.toRawString());
      url.searchParams.set("jetton_wallet", input.jettonWallet.toRawString());
      url.searchParams.set("jetton_master", officialMainnetUsdtMasterAddress);
      url.searchParams.set("direction", "out");
      url.searchParams.set("start_utime", String(Math.floor(input.notBefore.getTime() / 1000)));
      url.searchParams.set("limit", "1000");
      url.searchParams.set("offset", "0");
      const response = await fetchImpl(url, {
        headers: config.apiKey ? { "X-API-Key": config.apiKey } : undefined,
      });
      if (!response.ok) {
        throw new Error(`TON Center mainnet jetton confirmation failed: ${response.status}.`);
      }
      const payload = await response.json() as any;
      if (!Array.isArray(payload?.jetton_transfers)) {
        throw new Error("TON Center mainnet jetton confirmation response is malformed.");
      }
      const matches: MainnetUsdtSweepConfirmation[] = [];
      for (const transfer of payload.jetton_transfers) {
        const queryId = integerText(transfer?.query_id);
        const amount = integerText(transfer?.amount);
        const transactionHash = canonicalTonTransactionHash(transfer?.transaction_hash);
        const transactionLt = integerText(transfer?.transaction_lt);
        const blockchainAt = unixDate(transfer?.transaction_now);
        if (
          queryId === input.queryId.toString() &&
          amount === input.amountAtomic.toString() &&
          transfer?.transaction_aborted === false &&
          canonicalTonAddress(transfer?.jetton_master) === officialMainnetUsdtMasterAddress &&
          canonicalTonAddress(transfer?.source) === input.ownerAddress.toRawString() &&
          canonicalTonAddress(transfer?.source_wallet) === input.jettonWallet.toRawString() &&
          canonicalTonAddress(transfer?.destination) === input.recipientAddress.toRawString() &&
          transactionHash &&
          transactionLt && BigInt(transactionLt) > 0n && BigInt(transactionLt) <= uint64Max &&
          blockchainAt &&
          Math.floor(blockchainAt.getTime() / 1_000) >= Math.floor(input.notBefore.getTime() / 1_000) &&
          Math.floor(blockchainAt.getTime() / 1_000) <= Math.floor(input.notAfter.getTime() / 1_000)
        ) {
          matches.push({ transactionHash, transactionLt, blockchainAt });
        }
      }
      if (matches.length > 1) {
        throw new Error("TON Center returned duplicate matching USDT sweep confirmations.");
      }
      return matches[0] ?? null;
    },
  };
}

export async function runMainnetUsdtSweepBatch(input: {
  config: MainnetUsdtSweepConfig;
  repository?: MainnetUsdtSweepRepository;
  blockchain?: MainnetUsdtSweepBlockchain;
  workerId?: string;
  now?: () => Date;
  limit?: number;
}) {
  const repository = input.repository ?? prismaMainnetUsdtSweepRepository;
  const now = input.now ?? (() => new Date());
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("Mainnet USDT sweep limit must be between 1 and 200.");
  }
  const workerId = input.workerId ?? `usdt-sweep-${process.pid}-${randomUUID()}`;
  const candidates = await repository.listCandidates({ now: now(), limit });
  const outcomes: MainnetUsdtSweepOutcome[] = [];
  for (const record of candidates) {
    outcomes.push(await processMainnetUsdtSweep({ ...input, record, repository, workerId, now }));
  }
  return { candidates: candidates.length, outcomes };
}

export function retryFailedMainnetUsdtSweep(
  sweepId: string,
  repository: MainnetUsdtSweepRepository = prismaMainnetUsdtSweepRepository,
) {
  return repository.retryFailed({ sweepId, requestedAt: new Date() });
}

export function queueMainnetUsdtSweepForDeposit(
  depositAddressId: string,
  requestId: string,
  repository: MainnetUsdtSweepRepository = prismaMainnetUsdtSweepRepository,
) {
  return repository.queueForDeposit({ depositAddressId, requestId, requestedAt: new Date() });
}
