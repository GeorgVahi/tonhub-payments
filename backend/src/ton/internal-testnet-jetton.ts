import { Buffer } from "node:buffer";
import { Cell } from "@ton/core";
import { paymentAssets } from "../../../shared/payment-assets";
import type { PaymentMovementDraft } from "../movement-ledger";
import {
  resolveTonApiConfig,
  type TonNetwork,
  type TonReadConfig,
} from "./direct-payments";
import {
  canonicalTonAddress,
  canonicalTonTransactionHash,
} from "./gram-shadow-scanner";
import { officialMainnetUsdtMasterAddress } from "./jetton-identities";

export type InternalTestnetJettonConfig = {
  enabled: true;
  network: "testnet";
  masterAddress: string;
  decimals: 6;
};

export type VerifiedJettonConfig = {
  enabled: true;
  network: TonNetwork;
  masterAddress: string;
  decimals: 6;
};

export type VerifiedJettonAdapterProfile = {
  name: string;
  evidence: "internal-test-asset" | "official-usdt";
};

export type TonCenterJettonWallet = {
  address?: unknown;
  balance?: unknown;
  owner?: unknown;
  jetton?: unknown;
  last_transaction_lt?: unknown;
};

export type TonCenterJettonTransfer = {
  amount?: unknown;
  destination?: unknown;
  jetton_master?: unknown;
  query_id?: unknown;
  source?: unknown;
  source_wallet?: unknown;
  trace_id?: unknown;
  transaction_aborted?: unknown;
  transaction_hash?: unknown;
  transaction_lt?: unknown;
  transaction_now?: unknown;
};

export type TonCenterJettonNotification = {
  traceId?: unknown;
  accountAddress?: unknown;
  walletAddress?: unknown;
  destinationAddress?: unknown;
  transactionAborted?: unknown;
  body?: unknown;
};

export type InternalTestnetJettonRejectionCode =
  | "TRANSACTION_ID_INVALID"
  | "TRANSACTION_TIME_INVALID"
  | "TRANSACTION_OUTSIDE_WINDOW"
  | "TRANSACTION_NOT_SUCCESSFUL"
  | "QUERY_ID_INVALID"
  | "MASTER_MISMATCH"
  | "WALLET_MISMATCH"
  | "DESTINATION_MISMATCH"
  | "SOURCE_INVALID"
  | "SOURCE_WALLET_INVALID"
  | "AMOUNT_INVALID"
  | "NOTIFICATION_MALFORMED"
  | "NOTIFICATION_OPCODE_MISMATCH"
  | "NOTIFICATION_FACTS_MISMATCH";

export type InternalTestnetJettonRejection = {
  transferIndex: number;
  transactionHash: string | null;
  transactionLt: string | null;
  observedAssetWalletAddress: string | null;
  code: InternalTestnetJettonRejectionCode;
};

export type VerifiedJettonPrismaLike = {
  tonhubDepositAddress: any;
  tonhubDepositAssetAccount: any;
};

export type VerifiedJettonMovementLedgerLike = {
  recordObserved: (movement: PaymentMovementDraft) => Promise<unknown>;
  recordRejected: (input: {
    movement: PaymentMovementDraft;
    validationCode: string;
    reason: string;
    title: string;
    details: Record<string, unknown>;
  }) => Promise<unknown>;
};

export const jettonTransferNotificationOpcode = 0x7362d09c;

export type VerifiedJettonAdapterDependencies = {
  db: VerifiedJettonPrismaLike;
  ledger: VerifiedJettonMovementLedgerLike;
  config: VerifiedJettonConfig;
  resolveReadConfig?: (network: TonNetwork) => TonReadConfig;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

type AdapterDependencies = Omit<VerifiedJettonAdapterDependencies, "config"> & {
  config: InternalTestnetJettonConfig;
};

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const uint64Max = (BigInt(1) << BigInt(64)) - BigInt(1);
const jettonAmountMax = (BigInt(1) << BigInt(120)) - BigInt(1);

function canonicalInteger(value: unknown, options: {
  positive?: boolean;
  max?: bigint;
} = {}) {
  const raw = text(value);
  if (!raw || !/^\d+$/.test(raw)) {
    return null;
  }
  const normalized = BigInt(raw).toString();
  if (options.positive && normalized === "0") {
    return null;
  }
  return options.max !== undefined && BigInt(normalized) > options.max ? null : normalized;
}

function transactionDate(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > 0xffffffff) {
    return null;
  }
  const result = new Date(Number(value) * 1000);
  return Number.isNaN(result.getTime()) ? null : result;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function strictBocBytes(value: unknown) {
  const raw = text(value);
  if (!raw || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw) || raw.length % 4 === 1) {
    return null;
  }
  const standardUnpadded = raw
    .replace(/=+$/u, "")
    .replace(/-/gu, "+")
    .replace(/_/gu, "/");
  try {
    const bytes = Buffer.from(
      `${standardUnpadded}${"=".repeat((4 - standardUnpadded.length % 4) % 4)}`,
      "base64",
    );
    if (!bytes.length || bytes.toString("base64").replace(/=+$/u, "") !== standardUnpadded) {
      return null;
    }
    return bytes;
  } catch {
    return null;
  }
}

export function parseJettonTransferNotificationBody(value: unknown) {
  const bytes = strictBocBytes(value);
  if (!bytes) {
    return null;
  }
  try {
    const cells = Cell.fromBoc(bytes);
    if (cells.length !== 1) {
      return null;
    }
    const slice = cells[0].beginParse();
    const opcode = slice.loadUint(32);
    const queryId = slice.loadUintBig(64).toString();
    const amountAtomic = slice.loadCoins().toString();
    const sender = slice.loadAddress();
    if (!sender || slice.remainingBits < 1) {
      return null;
    }
    const payloadByReference = slice.loadBit();
    if (payloadByReference) {
      if (slice.remainingBits !== 0 || slice.remainingRefs !== 1) {
        return null;
      }
      slice.loadRef();
    }
    return {
      body: bytes.toString("base64"),
      opcode,
      queryId,
      amountAtomic,
      senderAddress: sender.toRawString(),
    };
  } catch {
    return null;
  }
}

function parseBooleanFlag(value: unknown) {
  const normalized = String(value ?? "false").trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false" || normalized === "") {
    return false;
  }
  throw new Error("TON_INTERNAL_TESTNET_JETTON_ENABLED must be true or false.");
}

export function resolveInternalTestnetJettonConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): InternalTestnetJettonConfig | null {
  if (!parseBooleanFlag(env.TON_INTERNAL_TESTNET_JETTON_ENABLED)) {
    return null;
  }
  const network = String(env.TON_INTERNAL_TESTNET_JETTON_NETWORK ?? "testnet").trim().toLowerCase();
  if (network !== "testnet") {
    throw new Error("The internal jetton adapter is testnet only.");
  }
  const masterAddress = canonicalTonAddress(env.TON_INTERNAL_TESTNET_JETTON_MASTER_ADDRESS);
  if (!masterAddress) {
    throw new Error("TON_INTERNAL_TESTNET_JETTON_MASTER_ADDRESS must be a valid TON address.");
  }
  const decimals = String(env.TON_INTERNAL_TESTNET_JETTON_DECIMALS ?? "").trim();
  if (decimals !== String(paymentAssets.USDT.decimals)) {
    throw new Error("TON_INTERNAL_TESTNET_JETTON_DECIMALS must explicitly equal 6.");
  }
  return { enabled: true, network: "testnet", masterAddress, decimals: 6 };
}

async function fetchJson(input: {
  config: TonReadConfig;
  path: string;
  search: Record<string, string | number>;
  fetchImpl: typeof fetch;
}) {
  const url = new URL(`${input.config.baseUrl}/${input.path}`);
  for (const [key, value] of Object.entries(input.search)) {
    url.searchParams.set(key, String(value));
  }
  const response = await input.fetchImpl(url, {
    headers: input.config.apiKey ? { "X-API-Key": input.config.apiKey } : undefined,
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim().slice(0, 180);
    throw new Error(
      `TON Center ${input.config.network} ${input.path} request failed: ${response.status}${detail ? ` ${detail}` : ""}.`,
    );
  }
  return await response.json() as unknown;
}

function rejection(
  transfer: TonCenterJettonTransfer,
  code: InternalTestnetJettonRejectionCode,
  transferIndex: number,
  observedAssetWalletAddress: string | null = null,
): InternalTestnetJettonRejection {
  return {
    transferIndex,
    transactionHash: canonicalTonTransactionHash(transfer.transaction_hash),
    transactionLt: canonicalInteger(transfer.transaction_lt, { max: uint64Max }),
    observedAssetWalletAddress,
    code,
  };
}

function scanVerifiedJettonTransfers(input: {
  network: TonNetwork;
  evidence: VerifiedJettonAdapterProfile["evidence"];
  depositAddressId: string;
  ownerAddress: string;
  masterAddress: string;
  assetWalletAddress: string;
  notBefore: Date;
  notAfter: Date;
  transfers: TonCenterJettonTransfer[];
  notifications?: TonCenterJettonNotification[];
}) {
  const ownerAddress = canonicalTonAddress(input.ownerAddress);
  const masterAddress = canonicalTonAddress(input.masterAddress);
  const assetWalletAddress = canonicalTonAddress(input.assetWalletAddress);
  if (!ownerAddress || !masterAddress || !assetWalletAddress) {
    throw new Error("Verified jetton target evidence is invalid.");
  }
  if (
    !validDate(input.notBefore) ||
    !validDate(input.notAfter) ||
    input.notAfter.getTime() < input.notBefore.getTime()
  ) {
    throw new Error("Verified jetton scan window is invalid.");
  }

  const movements: PaymentMovementDraft[] = [];
  const rejections: InternalTestnetJettonRejection[] = [];
  for (const [transferIndex, transfer] of input.transfers.entries()) {
    const transactionHash = canonicalTonTransactionHash(transfer.transaction_hash);
    const transactionLt = canonicalInteger(transfer.transaction_lt, { positive: true, max: uint64Max });
    if (!transactionHash || !transactionLt) {
      rejections.push(rejection(transfer, "TRANSACTION_ID_INVALID", transferIndex));
      continue;
    }
    const blockchainAt = transactionDate(transfer.transaction_now);
    if (!blockchainAt) {
      rejections.push(rejection(transfer, "TRANSACTION_TIME_INVALID", transferIndex));
      continue;
    }
    if (
      blockchainAt.getTime() < input.notBefore.getTime() ||
      blockchainAt.getTime() > input.notAfter.getTime()
    ) {
      rejections.push(rejection(transfer, "TRANSACTION_OUTSIDE_WINDOW", transferIndex));
      continue;
    }
    if (transfer.transaction_aborted !== false) {
      rejections.push(rejection(transfer, "TRANSACTION_NOT_SUCCESSFUL", transferIndex));
      continue;
    }
    const queryId = canonicalInteger(transfer.query_id, { max: uint64Max });
    if (!queryId) {
      rejections.push(rejection(transfer, "QUERY_ID_INVALID", transferIndex));
      continue;
    }
    if (canonicalTonAddress(transfer.destination) !== ownerAddress) {
      rejections.push(rejection(transfer, "DESTINATION_MISMATCH", transferIndex));
      continue;
    }
    const source = canonicalTonAddress(transfer.source);
    if (!source) {
      rejections.push(rejection(transfer, "SOURCE_INVALID", transferIndex));
      continue;
    }
    const sourceWallet = canonicalTonAddress(transfer.source_wallet);
    if (!sourceWallet) {
      rejections.push(rejection(transfer, "SOURCE_WALLET_INVALID", transferIndex));
      continue;
    }
    const amountAtomic = canonicalInteger(transfer.amount, { positive: true, max: jettonAmountMax });
    if (!amountAtomic) {
      rejections.push(rejection(transfer, "AMOUNT_INVALID", transferIndex));
      continue;
    }
    const traceId = canonicalTonTransactionHash(transfer.trace_id);
    const notificationMatches = traceId
      ? (input.notifications ?? []).filter((value) =>
          canonicalTonTransactionHash(value.traceId) === traceId)
      : [];
    if (notificationMatches.length > 1) {
      rejections.push(rejection(transfer, "NOTIFICATION_MALFORMED", transferIndex));
      continue;
    }
    const notificationEvidence = notificationMatches[0] ?? null;
    const notificationWallet = notificationEvidence
      ? canonicalTonAddress(notificationEvidence.walletAddress)
      : null;
    if (
      notificationEvidence &&
      (
        notificationEvidence.transactionAborted !== false ||
        canonicalTonAddress(notificationEvidence.accountAddress) !== ownerAddress ||
        canonicalTonAddress(notificationEvidence.destinationAddress) !== ownerAddress ||
        !notificationWallet
      )
    ) {
      rejections.push(rejection(transfer, "NOTIFICATION_MALFORMED", transferIndex));
      continue;
    }
    const notification = notificationEvidence
      ? parseJettonTransferNotificationBody(notificationEvidence.body)
      : null;
    if (notificationEvidence && !notification) {
      rejections.push(rejection(
        transfer,
        "NOTIFICATION_MALFORMED",
        transferIndex,
        notificationWallet,
      ));
      continue;
    }
    if (notification && notification.opcode !== jettonTransferNotificationOpcode) {
      rejections.push(rejection(
        transfer,
        "NOTIFICATION_OPCODE_MISMATCH",
        transferIndex,
        notificationWallet,
      ));
      continue;
    }
    if (
      notification &&
      (
        notification.queryId !== queryId ||
        notification.amountAtomic !== amountAtomic ||
        notification.senderAddress !== source
      )
    ) {
      rejections.push(rejection(
        transfer,
        "NOTIFICATION_FACTS_MISMATCH",
        transferIndex,
        notificationWallet,
      ));
      continue;
    }
    if (canonicalTonAddress(transfer.jetton_master) !== masterAddress) {
      rejections.push(rejection(
        transfer,
        "MASTER_MISMATCH",
        transferIndex,
        notificationWallet,
      ));
      continue;
    }
    if (notificationWallet && notificationWallet !== assetWalletAddress) {
      rejections.push(rejection(
        transfer,
        "WALLET_MISMATCH",
        transferIndex,
        notificationWallet,
      ));
      continue;
    }
    const asset = paymentAssets.USDT;
    movements.push({
      fingerprint: `ton:${input.network}:jetton-in:${transactionHash}:${queryId}:${masterAddress}`,
      depositAddressId: input.depositAddressId,
      network: input.network,
      direction: "INCOMING",
      asset: asset.symbol,
      assetKind: asset.kind,
      assetDecimals: asset.decimals,
      amountAtomic,
      fromAddress: source,
      toAddress: ownerAddress,
      ownerAddress,
      jettonMasterAddress: masterAddress,
      jettonWalletAddress: assetWalletAddress,
      transactionHash,
      transactionLt,
      traceId,
      queryId,
      blockchainAt,
      rawPayload: {
        evidenceVersion: 1,
        provider: "toncenter-v3-jetton-transfers",
        ...(input.evidence === "internal-test-asset"
          ? { internalTestAsset: true }
          : { officialUsdt: true }),
        transfer: {
          amount: amountAtomic,
          destination: ownerAddress,
          jettonMaster: masterAddress,
          queryId,
          source,
          sourceWallet,
          transactionAborted: false,
          transactionHash,
          transactionLt,
          transactionNow: Math.floor(blockchainAt.getTime() / 1000),
        },
        ...(notification
          ? {
              notification: {
                body: notification.body,
                opcode: `0x${notification.opcode.toString(16).padStart(8, "0")}`,
                queryId: notification.queryId,
                amount: notification.amountAtomic,
                sender: notification.senderAddress,
              },
            }
          : {}),
      },
    });
  }
  return { movements, rejections };
}

export function scanInternalTestnetJettonTransfers(input: Omit<
  Parameters<typeof scanVerifiedJettonTransfers>[0],
  "network" | "evidence"
>) {
  return scanVerifiedJettonTransfers({
    ...input,
    network: "testnet",
    evidence: "internal-test-asset",
  });
}

function rejectedJettonCandidate(input: {
  network: TonNetwork;
  evidence: VerifiedJettonAdapterProfile["evidence"];
  depositAddressId: string;
  ownerAddress: string;
  configuredMaster: string;
  verifiedAssetWalletAddress: string;
  observedAssetWalletAddress: string;
  notBefore: Date;
  notAfter: Date;
  transfer: TonCenterJettonTransfer;
  code: "MASTER_MISMATCH" | "WALLET_MISMATCH";
}) {
  const transactionHash = canonicalTonTransactionHash(input.transfer.transaction_hash);
  const transactionLt = canonicalInteger(input.transfer.transaction_lt, {
    positive: true,
    max: uint64Max,
  });
  const blockchainAt = transactionDate(input.transfer.transaction_now);
  const queryId = canonicalInteger(input.transfer.query_id, { max: uint64Max });
  const actualMaster = canonicalTonAddress(input.transfer.jetton_master);
  const actualWallet = canonicalTonAddress(input.observedAssetWalletAddress);
  const destination = canonicalTonAddress(input.transfer.destination);
  const source = canonicalTonAddress(input.transfer.source);
  const sourceWallet = canonicalTonAddress(input.transfer.source_wallet);
  const amountAtomic = canonicalInteger(input.transfer.amount, {
    positive: true,
    max: jettonAmountMax,
  });
  if (
    !transactionHash ||
    !transactionLt ||
    !blockchainAt ||
    blockchainAt.getTime() < input.notBefore.getTime() ||
    blockchainAt.getTime() > input.notAfter.getTime() ||
    input.transfer.transaction_aborted !== false ||
    !queryId ||
    !actualMaster ||
    !actualWallet ||
    destination !== input.ownerAddress ||
    !source ||
    !sourceWallet ||
    !amountAtomic
  ) {
    return null;
  }
  const asset = paymentAssets.USDT;
  return {
    fingerprint: `ton:${input.network}:jetton-rejected:${transactionHash}:${queryId}:${actualMaster}:${actualWallet}`,
    depositAddressId: input.depositAddressId,
    network: input.network,
    direction: "INCOMING" as const,
    asset: asset.symbol,
    assetKind: asset.kind,
    assetDecimals: asset.decimals,
    amountAtomic,
    fromAddress: source,
    toAddress: input.ownerAddress,
    ownerAddress: input.ownerAddress,
    jettonMasterAddress: actualMaster,
    jettonWalletAddress: actualWallet,
    transactionHash,
    transactionLt,
    traceId: canonicalTonTransactionHash(input.transfer.trace_id),
    queryId,
    blockchainAt,
    rawPayload: {
      evidenceVersion: 1,
      provider: "toncenter-v3-jetton-transfers",
      ...(input.evidence === "internal-test-asset"
        ? { internalTestAsset: true }
        : { officialUsdt: true }),
      untrustedJettonCandidate: true,
      rejectionCode: input.code,
      configuredMasterAddress: input.configuredMaster,
      verifiedAssetWalletAddress: input.verifiedAssetWalletAddress,
      transfer: {
        amount: amountAtomic,
        destination: input.ownerAddress,
        jettonMaster: actualMaster,
        jettonWallet: actualWallet,
        queryId,
        source,
        sourceWallet,
        transactionAborted: false,
        transactionHash,
        transactionLt,
        transactionNow: Math.floor(blockchainAt.getTime() / 1000),
      },
    },
  } satisfies PaymentMovementDraft;
}

function requireRecord(value: unknown, field: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} response must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, field: string) {
  if (!Array.isArray(value)) {
    throw new Error(`${field} response must be an array.`);
  }
  return value;
}

function notificationEvidenceFromTransactions(value: unknown) {
  return requireArray(value, "Notification transactions").flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return [];
    }
    const transaction = candidate as Record<string, unknown>;
    const traceId = canonicalTonTransactionHash(transaction.trace_id);
    const inMessage = transaction.in_msg &&
      typeof transaction.in_msg === "object" &&
      !Array.isArray(transaction.in_msg)
      ? transaction.in_msg as Record<string, unknown>
      : null;
    if (!traceId || !inMessage) {
      return [];
    }
    const description = transaction.description &&
      typeof transaction.description === "object" &&
      !Array.isArray(transaction.description)
      ? transaction.description as Record<string, unknown>
      : null;
    const messageContent = inMessage.message_content &&
      typeof inMessage.message_content === "object" &&
      !Array.isArray(inMessage.message_content)
      ? inMessage.message_content as Record<string, unknown>
      : null;
    return [{
      traceId,
      accountAddress: transaction.account,
      walletAddress: inMessage.source,
      destinationAddress: inMessage.destination,
      transactionAborted: description?.aborted === false &&
        Array.isArray(transaction.out_msgs) &&
        transaction.out_msgs.length === 0
        ? false
        : true,
      body: messageContent?.body,
    } satisfies TonCenterJettonNotification];
  });
}

function assertAccountIdentity(account: any, input: {
  depositAddressId: string;
  assetWalletAddress: string;
  masterAddress: string;
  network: TonNetwork;
  profileName: string;
}) {
  if (
    account.depositAddressId !== input.depositAddressId ||
    account.network !== input.network ||
    account.asset !== "USDT" ||
    account.assetKind !== "JETTON" ||
    account.assetDecimals !== paymentAssets.USDT.decimals ||
    canonicalTonAddress(account.jettonMasterAddress) !== input.masterAddress ||
    canonicalTonAddress(account.assetWalletAddress) !== input.assetWalletAddress ||
    account.status !== "VERIFIED"
  ) {
    throw new Error(`Stored ${input.profileName} account conflicts with verified provider evidence.`);
  }
  return account;
}

export function createVerifiedJettonAdapter(
  dependencies: VerifiedJettonAdapterDependencies,
  profile: VerifiedJettonAdapterProfile,
) {
  if (
    !["testnet", "mainnet"].includes(dependencies.config.network) ||
    dependencies.config.enabled !== true ||
    dependencies.config.decimals !== paymentAssets.USDT.decimals
  ) {
    throw new Error(`${profile.name} requires explicit verified 6-decimal configuration.`);
  }
  const configuredMaster = canonicalTonAddress(dependencies.config.masterAddress);
  if (!configuredMaster) {
    throw new Error(`${profile.name} master address is invalid.`);
  }
  if (
    (profile.evidence === "internal-test-asset" && dependencies.config.network !== "testnet") ||
    (
      profile.evidence === "official-usdt" &&
      (
        dependencies.config.network !== "mainnet" ||
        configuredMaster !== officialMainnetUsdtMasterAddress
      )
    )
  ) {
    throw new Error(`${profile.name} evidence identity is not allowed on this network.`);
  }
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const resolveReadConfig = dependencies.resolveReadConfig ?? resolveTonApiConfig;
  const clock = dependencies.now ?? (() => new Date());

  return {
    observeDeposit: async (input: {
      depositAddressId: string;
      notBefore: Date;
      notAfter: Date;
      limit?: number;
      offset?: number;
    }) => {
      if (
        !validDate(input.notBefore) ||
        !validDate(input.notAfter) ||
        input.notAfter.getTime() < input.notBefore.getTime()
      ) {
        throw new Error(`${profile.name} scan window is invalid.`);
      }
      const limit = input.limit ?? 100;
      const offset = input.offset ?? 0;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new Error(`${profile.name} limit must be between 1 and 1000.`);
      }
      if (!Number.isInteger(offset) || offset < 0) {
        throw new Error(`${profile.name} offset must be a non-negative integer.`);
      }
      const deposit = await dependencies.db.tonhubDepositAddress.findUnique({
        where: { id: input.depositAddressId },
      });
      const ownerAddress = canonicalTonAddress(deposit?.address);
      const ownerAddressRaw = canonicalTonAddress(deposit?.addressRaw);
      if (
        !deposit ||
        deposit.network !== dependencies.config.network ||
        !ownerAddress ||
        !ownerAddressRaw ||
        ownerAddress !== ownerAddressRaw
      ) {
        throw new Error(`${profile.name} requires a consistent ${dependencies.config.network} deposit.`);
      }
      const readConfig = resolveReadConfig(dependencies.config.network);
      if (readConfig.network !== dependencies.config.network) {
        throw new Error(`${profile.name} cannot use a provider for another network.`);
      }
      const mastersPayload = requireRecord(await fetchJson({
        config: readConfig,
        path: "jetton/masters",
        search: {
          address: configuredMaster,
          limit: 10,
        },
        fetchImpl,
      }), "Jetton masters");
      const exactMasters = requireArray(mastersPayload.jetton_masters, "Jetton masters")
        .map((value) => requireRecord(value, "Jetton master"))
        .filter((master) => canonicalTonAddress(master.address) === configuredMaster);
      if (exactMasters.length !== 1) {
        throw new Error(`TON Center must return exactly one configured ${profile.name} master.`);
      }
      const masterContent = requireRecord(exactMasters[0].jetton_content, "Jetton master content");
      if (canonicalInteger(masterContent.decimals) !== String(paymentAssets.USDT.decimals)) {
        throw new Error(`${profile.name} master must have exactly 6 decimals.`);
      }
      const walletsPayload = requireRecord(await fetchJson({
        config: readConfig,
        path: "jetton/wallets",
        search: {
          owner_address: ownerAddressRaw,
          jetton_address: configuredMaster,
          limit: 10,
        },
        fetchImpl,
      }), "Jetton wallets");
      const exactWallets = requireArray(walletsPayload.jetton_wallets, "Jetton wallets")
        .map((value) => requireRecord(value, "Jetton wallet"))
        .filter((wallet) =>
          canonicalTonAddress(wallet.owner) === ownerAddressRaw &&
          canonicalTonAddress(wallet.jetton) === configuredMaster);
      const uniqueWalletAddresses = [...new Set(exactWallets
        .map((wallet) => canonicalTonAddress(wallet.address))
        .filter((value): value is string => Boolean(value)))];
      if (uniqueWalletAddresses.length !== 1) {
        throw new Error(`TON Center must return exactly one verified ${profile.name} wallet.`);
      }
      const assetWalletAddress = uniqueWalletAddresses[0];
      const verifiedAt = clock();
      if (!validDate(verifiedAt)) {
        throw new Error(`${profile.name} verification time is invalid.`);
      }
      let account = await dependencies.db.tonhubDepositAssetAccount.upsert({
        where: {
          depositAddressId_asset: {
            depositAddressId: deposit.id,
            asset: paymentAssets.USDT.symbol,
          },
        },
        create: {
          depositAddressId: deposit.id,
          network: dependencies.config.network,
          asset: paymentAssets.USDT.symbol,
          assetKind: paymentAssets.USDT.kind,
          assetDecimals: paymentAssets.USDT.decimals,
          jettonMasterAddress: configuredMaster,
          assetWalletAddress,
          status: "VERIFIED",
          verifiedAt,
          verificationError: null,
        },
        update: {},
      });
      account = assertAccountIdentity(account, {
        depositAddressId: deposit.id,
        assetWalletAddress,
        masterAddress: configuredMaster,
        network: dependencies.config.network,
        profileName: profile.name,
      });

      const startUtime = Math.max(0, Math.floor(input.notBefore.getTime() / 1000) - 1);
      const endUtime = Math.floor(input.notAfter.getTime() / 1000) + 1;
      const transfersPayload = requireRecord(await fetchJson({
        config: readConfig,
        path: "jetton/transfers",
        search: {
          owner_address: ownerAddressRaw,
          jetton_wallet: assetWalletAddress,
          jetton_master: configuredMaster,
          direction: "in",
          start_utime: startUtime,
          end_utime: endUtime,
          limit,
          offset,
          sort: "asc",
        },
        fetchImpl,
      }), "Jetton transfers");
      const discoveryPayload = requireRecord(await fetchJson({
        config: readConfig,
        path: "jetton/transfers",
        search: {
          owner_address: ownerAddressRaw,
          direction: "in",
          start_utime: startUtime,
          end_utime: endUtime,
          limit,
          offset,
          sort: "asc",
        },
        fetchImpl,
      }), "Jetton discovery transfers");
      const notificationPayload = requireRecord(await fetchJson({
        config: readConfig,
        path: "transactions",
        search: {
          account: ownerAddressRaw,
          start_utime: startUtime,
          end_utime: endUtime,
          limit: 1000,
          offset: 0,
          sort: "asc",
        },
        fetchImpl,
      }), "Notification transactions");
      const transfers = requireArray(
        transfersPayload.jetton_transfers,
        "Jetton transfers",
      ) as TonCenterJettonTransfer[];
      const discoveryTransfers = requireArray(
        discoveryPayload.jetton_transfers,
        "Jetton discovery transfers",
      ) as TonCenterJettonTransfer[];
      const notificationTransactions = requireArray(
        notificationPayload.transactions,
        "Notification transactions",
      );
      const notifications = notificationEvidenceFromTransactions(notificationTransactions);
      const parsed = scanVerifiedJettonTransfers({
        network: dependencies.config.network,
        evidence: profile.evidence,
        depositAddressId: deposit.id,
        ownerAddress: ownerAddressRaw,
        masterAddress: configuredMaster,
        assetWalletAddress,
        notBefore: input.notBefore,
        notAfter: input.notAfter,
        transfers,
        notifications,
      });
      const discovered = scanVerifiedJettonTransfers({
        network: dependencies.config.network,
        evidence: profile.evidence,
        depositAddressId: deposit.id,
        ownerAddress: ownerAddressRaw,
        masterAddress: configuredMaster,
        assetWalletAddress,
        notBefore: input.notBefore,
        notAfter: input.notAfter,
        transfers: discoveryTransfers,
        notifications,
      });
      const observedWallets = new Map<string, string | null>();
      const resolveObservedWallet = async (masterAddress: string) => {
        if (observedWallets.has(masterAddress)) {
          return observedWallets.get(masterAddress) ?? null;
        }
        const payload = requireRecord(await fetchJson({
          config: readConfig,
          path: "jetton/wallets",
          search: {
            owner_address: ownerAddressRaw,
            jetton_address: masterAddress,
            limit: 10,
          },
          fetchImpl,
        }), "Rejected jetton wallets");
        const addresses = [...new Set(requireArray(payload.jetton_wallets, "Rejected jetton wallets")
          .flatMap((value) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) {
              return [];
            }
            const wallet = value as Record<string, unknown>;
            const address = canonicalTonAddress(wallet.address);
            return canonicalTonAddress(wallet.owner) === ownerAddressRaw &&
              canonicalTonAddress(wallet.jetton) === masterAddress &&
              address
              ? [address]
              : [];
          }))];
        const resolved = addresses.length === 1 ? addresses[0] : null;
        observedWallets.set(masterAddress, resolved);
        return resolved;
      };
      let rejectionsRecorded = 0;
      const recordedFingerprints = new Set<string>();
      for (const source of [
        { rejections: parsed.rejections, transfers },
        { rejections: discovered.rejections, transfers: discoveryTransfers },
      ]) {
        for (const rejected of source.rejections) {
          if (rejected.code !== "MASTER_MISMATCH" && rejected.code !== "WALLET_MISMATCH") {
            continue;
          }
          const transfer = source.transfers[rejected.transferIndex];
          if (!transfer) {
            continue;
          }
          const observedMaster = canonicalTonAddress(transfer.jetton_master);
          const observedAssetWalletAddress = rejected.observedAssetWalletAddress ?? (
            observedMaster ? await resolveObservedWallet(observedMaster) : null
          );
          if (!observedAssetWalletAddress) {
            continue;
          }
          const candidate = rejectedJettonCandidate({
            network: dependencies.config.network,
            evidence: profile.evidence,
            depositAddressId: deposit.id,
            ownerAddress: ownerAddressRaw,
            configuredMaster,
            verifiedAssetWalletAddress: assetWalletAddress,
            observedAssetWalletAddress,
            notBefore: input.notBefore,
            notAfter: input.notAfter,
            transfer,
            code: rejected.code,
          });
          if (!candidate || recordedFingerprints.has(candidate.fingerprint)) {
            continue;
          }
          await dependencies.ledger.recordRejected({
            movement: candidate,
            validationCode: rejected.code === "MASTER_MISMATCH"
              ? "JETTON_MASTER_NOT_ALLOWLISTED"
              : "JETTON_WALLET_NOT_VERIFIED",
            reason: rejected.code === "MASTER_MISMATCH"
              ? "UNSUPPORTED_JETTON_MASTER"
              : "UNVERIFIED_JETTON_WALLET",
            title: rejected.code === "MASTER_MISMATCH"
              ? "Unsupported jetton received by a deposit address"
              : "Jetton transfer references an unverified wallet",
            details: {
              configuredMasterAddress: configuredMaster,
              verifiedAssetWalletAddress: assetWalletAddress,
              observedMasterAddress: candidate.jettonMasterAddress,
              observedAssetWalletAddress: candidate.jettonWalletAddress,
              transactionHash: candidate.transactionHash,
            },
          });
          recordedFingerprints.add(candidate.fingerprint);
          rejectionsRecorded += 1;
        }
      }
      for (const movement of parsed.movements) {
        await dependencies.ledger.recordObserved(movement);
      }
      return {
        account,
        transfersScanned: transfers.length,
        discoveryTransfersScanned: discoveryTransfers.length,
        notificationTransactionsScanned: notificationTransactions.length,
        movementsObserved: parsed.movements.length,
        rejectionsRecorded,
        rejections: [...parsed.rejections, ...discovered.rejections],
        nextOffset: offset + limit,
      };
    },
  };
}

export function createInternalTestnetJettonAdapter(dependencies: AdapterDependencies) {
  if (dependencies.config.network !== "testnet") {
    throw new Error("The internal jetton adapter requires explicit testnet-only configuration.");
  }
  return createVerifiedJettonAdapter(dependencies, {
    name: "internal testnet jetton adapter",
    evidence: "internal-test-asset",
  });
}
