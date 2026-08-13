import { Address } from "@ton/core";
import type { SendTransactionRequest } from "@tonconnect/ui-react";
import { officialMainnetUsdtMasterFriendlyAddress } from "../../shared/jetton-identities";

export type TonConnectTransactionInvoice = {
  network: "testnet" | "mainnet";
  asset: "GRAM" | "USDT";
  assetKind: "NATIVE" | "JETTON";
  assetDecimals: number;
  address: string;
  addressStrategy: string;
  amountAtomic: string;
  expiresAt: string | null;
  priceLockedUntil: string | null;
  partialPaymentExpiresAt: string | null;
};

export function buildTonConnectTransaction(
  invoice: TonConnectTransactionInvoice,
  now = new Date(),
): SendTransactionRequest {
  if (invoice.network !== "testnet" && invoice.network !== "mainnet") {
    throw new Error("Unsupported TON payment network.");
  }
  if (invoice.asset !== "GRAM" && invoice.asset !== "USDT") {
    throw new Error("Unsupported TON payment asset.");
  }
  const expectedIdentity = invoice.asset === "GRAM"
    ? { kind: "NATIVE", decimals: 9 }
    : { kind: "JETTON", decimals: 6 };
  if (
    invoice.assetKind !== expectedIdentity.kind ||
    invoice.assetDecimals !== expectedIdentity.decimals
  ) {
    throw new Error("TON payment asset identity does not match the registry.");
  }
  if (invoice.addressStrategy !== "unique-address") {
    throw new Error("TON Connect checkout requires a unique deposit address.");
  }
  const parsedAddress = Address.parseFriendly(invoice.address);
  if (parsedAddress.isTestOnly !== (invoice.network === "testnet")) {
    throw new Error("Payment address and invoice network do not match.");
  }
  if (!/^\d+$/.test(invoice.amountAtomic) || BigInt(invoice.amountAtomic) <= BigInt(0)) {
    throw new Error("Payment amount must be a positive atomic integer.");
  }
  const paymentDeadline = invoice.partialPaymentExpiresAt ?? invoice.priceLockedUntil ?? invoice.expiresAt;
  if (!paymentDeadline) {
    throw new Error("TON Connect checkout requires an authoritative payment deadline.");
  }
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const deadlineSeconds = Math.floor(new Date(paymentDeadline).getTime() / 1000);
  if (!Number.isSafeInteger(deadlineSeconds) || deadlineSeconds <= nowSeconds) {
    throw new Error("The payment window has ended.");
  }
  const validUntil = Math.min(nowSeconds + 600, deadlineSeconds);
  const network = invoice.network === "mainnet" ? "-239" : "-3";

  if (invoice.asset === "GRAM") {
    return {
      validUntil,
      network,
      messages: [{ address: invoice.address, amount: invoice.amountAtomic }],
    };
  }
  if (invoice.asset !== "USDT" || invoice.network !== "mainnet") {
    throw new Error("TON Connect USDT checkout requires a unique mainnet deposit address.");
  }
  return {
    validUntil,
    network,
    items: [{
      type: "jetton",
      master: officialMainnetUsdtMasterFriendlyAddress,
      destination: invoice.address,
      amount: invoice.amountAtomic,
    }],
  };
}
