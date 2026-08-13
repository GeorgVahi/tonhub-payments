import { paymentAssets } from "../../../shared/payment-assets";
import type { PaymentMovementDraft } from "../movement-ledger";
import {
  resolveTonApiConfig,
  type TonReadConfig,
} from "./direct-payments";
import {
  canonicalTonAddress,
  canonicalTonTransactionHash,
} from "./gram-shadow-scanner";

export type InternalTestnetJettonConfig = {
  enabled: true;
  network: "testnet";
  masterAddress: string;
  decimals: 6;
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

export type InternalTestnetJettonRejectionCode =
  | "TRANSACTION_ID_INVALID"
  | "TRANSACTION_TIME_INVALID"
  | "TRANSACTION_OUTSIDE_WINDOW"
  | "TRANSACTION_NOT_SUCCESSFUL"
  | "QUERY_ID_INVALID"
  | "MASTER_MISMATCH"
  | "DESTINATION_MISMATCH"
  | "SOURCE_INVALID"
  | "SOURCE_WALLET_INVALID"
  | "AMOUNT_INVALID";

export type InternalTestnetJettonRejection = {
  transactionHash: string | null;
  transactionLt: string | null;
  code: InternalTestnetJettonRejectionCode;
};

type PrismaLike = {
  tonhubDepositAddress: any;
  tonhubDepositAssetAccount: any;
};

type MovementLedgerLike = {
  recordObserved: (movement: PaymentMovementDraft) => Promise<unknown>;
};

type AdapterDependencies = {
  db: PrismaLike;
  ledger: MovementLedgerLike;
  config: InternalTestnetJettonConfig;
  resolveReadConfig?: (network: "testnet") => TonReadConfig;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function canonicalInteger(value: unknown, options: { positive?: boolean } = {}) {
  const raw = text(value);
  if (!raw || !/^\d+$/.test(raw)) {
    return null;
  }
  const normalized = BigInt(raw).toString();
  return options.positive && normalized === "0" ? null : normalized;
}

function transactionDate(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    return null;
  }
  const result = new Date(Number(value) * 1000);
  return Number.isNaN(result.getTime()) ? null : result;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
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
      `TON Center testnet ${input.path} request failed: ${response.status}${detail ? ` ${detail}` : ""}.`,
    );
  }
  return await response.json() as unknown;
}

function rejection(
  transfer: TonCenterJettonTransfer,
  code: InternalTestnetJettonRejectionCode,
): InternalTestnetJettonRejection {
  return {
    transactionHash: canonicalTonTransactionHash(transfer.transaction_hash),
    transactionLt: canonicalInteger(transfer.transaction_lt),
    code,
  };
}

export function scanInternalTestnetJettonTransfers(input: {
  depositAddressId: string;
  ownerAddress: string;
  masterAddress: string;
  assetWalletAddress: string;
  notBefore: Date;
  notAfter: Date;
  transfers: TonCenterJettonTransfer[];
}) {
  const ownerAddress = canonicalTonAddress(input.ownerAddress);
  const masterAddress = canonicalTonAddress(input.masterAddress);
  const assetWalletAddress = canonicalTonAddress(input.assetWalletAddress);
  if (!ownerAddress || !masterAddress || !assetWalletAddress) {
    throw new Error("Internal testnet jetton target evidence is invalid.");
  }
  if (
    !validDate(input.notBefore) ||
    !validDate(input.notAfter) ||
    input.notAfter.getTime() < input.notBefore.getTime()
  ) {
    throw new Error("Internal testnet jetton scan window is invalid.");
  }

  const movements: PaymentMovementDraft[] = [];
  const rejections: InternalTestnetJettonRejection[] = [];
  for (const transfer of input.transfers) {
    const transactionHash = canonicalTonTransactionHash(transfer.transaction_hash);
    const transactionLt = canonicalInteger(transfer.transaction_lt, { positive: true });
    if (!transactionHash || !transactionLt) {
      rejections.push(rejection(transfer, "TRANSACTION_ID_INVALID"));
      continue;
    }
    const blockchainAt = transactionDate(transfer.transaction_now);
    if (!blockchainAt) {
      rejections.push(rejection(transfer, "TRANSACTION_TIME_INVALID"));
      continue;
    }
    if (
      blockchainAt.getTime() < input.notBefore.getTime() ||
      blockchainAt.getTime() > input.notAfter.getTime()
    ) {
      rejections.push(rejection(transfer, "TRANSACTION_OUTSIDE_WINDOW"));
      continue;
    }
    if (transfer.transaction_aborted !== false) {
      rejections.push(rejection(transfer, "TRANSACTION_NOT_SUCCESSFUL"));
      continue;
    }
    const queryId = canonicalInteger(transfer.query_id);
    if (!queryId) {
      rejections.push(rejection(transfer, "QUERY_ID_INVALID"));
      continue;
    }
    if (canonicalTonAddress(transfer.jetton_master) !== masterAddress) {
      rejections.push(rejection(transfer, "MASTER_MISMATCH"));
      continue;
    }
    if (canonicalTonAddress(transfer.destination) !== ownerAddress) {
      rejections.push(rejection(transfer, "DESTINATION_MISMATCH"));
      continue;
    }
    const source = canonicalTonAddress(transfer.source);
    if (!source) {
      rejections.push(rejection(transfer, "SOURCE_INVALID"));
      continue;
    }
    const sourceWallet = canonicalTonAddress(transfer.source_wallet);
    if (!sourceWallet) {
      rejections.push(rejection(transfer, "SOURCE_WALLET_INVALID"));
      continue;
    }
    const amountAtomic = canonicalInteger(transfer.amount, { positive: true });
    if (!amountAtomic) {
      rejections.push(rejection(transfer, "AMOUNT_INVALID"));
      continue;
    }
    const traceId = canonicalTonTransactionHash(transfer.trace_id);
    const asset = paymentAssets.USDT;
    movements.push({
      fingerprint: `ton:testnet:jetton-in:${transactionHash}:${queryId}:${masterAddress}`,
      depositAddressId: input.depositAddressId,
      network: "testnet",
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
        internalTestAsset: true,
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
      },
    });
  }
  return { movements, rejections };
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

function assertAccountIdentity(account: any, input: {
  depositAddressId: string;
  assetWalletAddress: string;
  masterAddress: string;
}) {
  if (
    account.depositAddressId !== input.depositAddressId ||
    account.network !== "testnet" ||
    account.asset !== "USDT" ||
    account.assetKind !== "JETTON" ||
    account.assetDecimals !== paymentAssets.USDT.decimals ||
    canonicalTonAddress(account.jettonMasterAddress) !== input.masterAddress ||
    canonicalTonAddress(account.assetWalletAddress) !== input.assetWalletAddress ||
    account.status !== "VERIFIED"
  ) {
    throw new Error("Stored internal testnet jetton account conflicts with verified provider evidence.");
  }
  return account;
}

export function createInternalTestnetJettonAdapter(dependencies: AdapterDependencies) {
  if (
    dependencies.config.network !== "testnet" ||
    dependencies.config.enabled !== true ||
    dependencies.config.decimals !== paymentAssets.USDT.decimals
  ) {
    throw new Error("The internal jetton adapter requires explicit testnet-only configuration.");
  }
  const configuredMaster = canonicalTonAddress(dependencies.config.masterAddress);
  if (!configuredMaster) {
    throw new Error("The internal testnet jetton master address is invalid.");
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
        throw new Error("Internal testnet jetton scan window is invalid.");
      }
      const limit = input.limit ?? 100;
      const offset = input.offset ?? 0;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new Error("Internal testnet jetton limit must be between 1 and 1000.");
      }
      if (!Number.isInteger(offset) || offset < 0) {
        throw new Error("Internal testnet jetton offset must be a non-negative integer.");
      }
      const deposit = await dependencies.db.tonhubDepositAddress.findUnique({
        where: { id: input.depositAddressId },
      });
      const ownerAddress = canonicalTonAddress(deposit?.address);
      const ownerAddressRaw = canonicalTonAddress(deposit?.addressRaw);
      if (
        !deposit ||
        deposit.network !== "testnet" ||
        !ownerAddress ||
        !ownerAddressRaw ||
        ownerAddress !== ownerAddressRaw
      ) {
        throw new Error("The internal jetton adapter requires a consistent testnet deposit.");
      }
      const readConfig = resolveReadConfig("testnet");
      if (readConfig.network !== "testnet") {
        throw new Error("The internal jetton adapter cannot use a non-testnet provider.");
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
        throw new Error("TON Center must return exactly one configured internal testnet jetton master.");
      }
      const masterContent = requireRecord(exactMasters[0].jetton_content, "Jetton master content");
      if (canonicalInteger(masterContent.decimals) !== String(paymentAssets.USDT.decimals)) {
        throw new Error("The internal testnet jetton master must have exactly 6 decimals.");
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
        throw new Error("TON Center must return exactly one verified internal testnet jetton wallet.");
      }
      const assetWalletAddress = uniqueWalletAddresses[0];
      const verifiedAt = clock();
      if (!validDate(verifiedAt)) {
        throw new Error("Internal testnet jetton verification time is invalid.");
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
          network: "testnet",
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
      const parsed = scanInternalTestnetJettonTransfers({
        depositAddressId: deposit.id,
        ownerAddress: ownerAddressRaw,
        masterAddress: configuredMaster,
        assetWalletAddress,
        notBefore: input.notBefore,
        notAfter: input.notAfter,
        transfers: requireArray(transfersPayload.jetton_transfers, "Jetton transfers") as TonCenterJettonTransfer[],
      });
      for (const movement of parsed.movements) {
        await dependencies.ledger.recordObserved(movement);
      }
      return {
        account,
        transfersScanned: requireArray(transfersPayload.jetton_transfers, "Jetton transfers").length,
        movementsObserved: parsed.movements.length,
        rejections: parsed.rejections,
        nextOffset: offset + limit,
      };
    },
  };
}
