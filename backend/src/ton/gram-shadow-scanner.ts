import { Buffer } from "node:buffer";
import { Address } from "@ton/core";
import { paymentAssets } from "../../../shared/payment-assets";
import type { PaymentMovementDraft } from "../movement-ledger";
import type { TonCenterTransaction, TonNetwork } from "./direct-payments";

export type GramShadowRejectionCode =
  | "TRANSACTION_ID_INVALID"
  | "TRANSACTION_TIME_INVALID"
  | "TRANSACTION_OUTSIDE_WINDOW"
  | "TRANSACTION_NOT_SUCCESSFUL"
  | "IN_MESSAGE_MISSING"
  | "DESTINATION_MISMATCH"
  | "SOURCE_INVALID"
  | "AMOUNT_INVALID";

export type GramShadowRejection = {
  transactionHash: string | null;
  transactionLt: string | null;
  code: GramShadowRejectionCode;
};

export type GramShadowScanResult = {
  movements: PaymentMovementDraft[];
  rejections: GramShadowRejection[];
};

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function canonicalTonTransactionHash(value: unknown) {
  const hash = text(value);
  if (!hash) {
    return null;
  }
  if (/^[a-f0-9]{64}$/i.test(hash)) {
    return hash.toLowerCase();
  }
  try {
    const canonicalBase64Url = hash
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=$/, "");
    if (!/^[A-Za-z0-9_-]{43}$/.test(canonicalBase64Url)) {
      return null;
    }
    const decoded = Buffer.from(canonicalBase64Url, "base64url");
    return decoded.length === 32 && decoded.toString("base64url") === canonicalBase64Url
      ? decoded.toString("hex")
      : null;
  } catch {
    return null;
  }
}

function canonicalLt(value: unknown) {
  const lt = text(value);
  return lt && /^\d+$/.test(lt) ? BigInt(lt).toString() : null;
}

export function canonicalTonAddress(value: unknown) {
  const address = text(value);
  if (!address) {
    return null;
  }
  try {
    return Address.parse(address).toRawString();
  } catch {
    return null;
  }
}

function transactionDate(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    return null;
  }
  const date = new Date(Number(value) * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function positiveAtomic(value: unknown) {
  const amount = text(value);
  if (!amount || !/^[1-9]\d*$/.test(amount)) {
    return null;
  }
  return BigInt(amount).toString();
}

function rejection(
  transaction: TonCenterTransaction,
  code: GramShadowRejectionCode,
): GramShadowRejection {
  return {
    transactionHash: canonicalTonTransactionHash(transaction.hash),
    transactionLt: canonicalLt(transaction.lt),
    code,
  };
}

export function tonTransactionCursor(transaction: TonCenterTransaction) {
  const hash = canonicalTonTransactionHash(transaction.hash);
  const lt = canonicalLt(transaction.lt);
  const timestamp = transactionDate(transaction.now);
  return hash && lt && timestamp ? { hash, lt, timestamp } : null;
}

export function scanGramShadowTransactions(input: {
  network: TonNetwork;
  depositAddressId: string;
  address: string;
  addressRaw: string;
  notBefore: Date;
  notAfter: Date;
  transactions: TonCenterTransaction[];
}): GramShadowScanResult {
  const targetAddress = canonicalTonAddress(input.address);
  const targetAddressRaw = canonicalTonAddress(input.addressRaw);
  if (!targetAddress || !targetAddressRaw || targetAddress !== targetAddressRaw) {
    throw new Error("GRAM shadow target TON address evidence is invalid or inconsistent.");
  }
  if (
    Number.isNaN(input.notBefore.getTime()) ||
    Number.isNaN(input.notAfter.getTime()) ||
    input.notAfter.getTime() < input.notBefore.getTime()
  ) {
    throw new Error("GRAM shadow scan window is invalid.");
  }

  const movements: PaymentMovementDraft[] = [];
  const rejections: GramShadowRejection[] = [];
  const asset = paymentAssets.GRAM;

  for (const transaction of input.transactions) {
    const hash = canonicalTonTransactionHash(transaction.hash);
    const lt = canonicalLt(transaction.lt);
    if (!hash || !lt) {
      rejections.push(rejection(transaction, "TRANSACTION_ID_INVALID"));
      continue;
    }
    const blockchainAt = transactionDate(transaction.now);
    if (!blockchainAt) {
      rejections.push(rejection(transaction, "TRANSACTION_TIME_INVALID"));
      continue;
    }
    if (
      blockchainAt.getTime() < input.notBefore.getTime() ||
      blockchainAt.getTime() > input.notAfter.getTime()
    ) {
      rejections.push(rejection(transaction, "TRANSACTION_OUTSIDE_WINDOW"));
      continue;
    }
    if (
      transaction.description?.aborted !== false ||
      transaction.description.action?.success !== true
    ) {
      rejections.push(rejection(transaction, "TRANSACTION_NOT_SUCCESSFUL"));
      continue;
    }
    const message = transaction.in_msg;
    if (!message) {
      rejections.push(rejection(transaction, "IN_MESSAGE_MISSING"));
      continue;
    }
    const destination = canonicalTonAddress(message.destination);
    if (!destination || destination !== targetAddressRaw) {
      rejections.push(rejection(transaction, "DESTINATION_MISMATCH"));
      continue;
    }
    const source = canonicalTonAddress(message.source);
    if (!source) {
      rejections.push(rejection(transaction, "SOURCE_INVALID"));
      continue;
    }
    const amountAtomic = positiveAtomic(message.value);
    if (!amountAtomic) {
      rejections.push(rejection(transaction, "AMOUNT_INVALID"));
      continue;
    }

    movements.push({
      fingerprint: `ton:${input.network}:native-in:${hash}:0`,
      depositAddressId: input.depositAddressId,
      network: input.network,
      direction: "INCOMING",
      asset: asset.symbol,
      assetKind: asset.kind,
      assetDecimals: asset.decimals,
      amountAtomic,
      fromAddress: source,
      toAddress: targetAddressRaw,
      transactionHash: hash,
      transactionLt: lt,
      blockchainAt,
      rawPayload: {
        evidenceVersion: 1,
        provider: "toncenter-v3",
        transaction: {
          hash,
          lt,
          now: Math.floor(blockchainAt.getTime() / 1000),
          successful: true,
          source,
          destination,
          value: amountAtomic,
        },
      },
    });
  }

  return { movements, rejections };
}
