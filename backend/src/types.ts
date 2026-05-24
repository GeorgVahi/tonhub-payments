import type { FiatCurrency } from "./config";
import type { TonNetwork, TonInvoiceMatch } from "./ton/direct-payments";

export type TonhubPaymentStatus = "PENDING" | "PARTIAL" | "PAID" | "EXPIRED" | "CANCELLED" | "FAILED";

export type TonhubObservedPayment = {
  transactionId: string;
  amountNano: string;
  amountTon: string;
  createdAt: string | null;
  status: TonInvoiceMatch["status"];
  comment: string;
};

export type TonhubRateQuote = {
  source: "coingecko";
  fiatAmountCents: number;
  fiatAmount: number;
  fiatCurrency: FiatCurrency;
  fiatPerTon: number;
  amountNano: string;
  amountTon: string;
  updatedAt: Date | null;
  fetchedAt: Date;
};

export type TonhubPaymentInvoiceRecord = {
  id: string;
  externalId: string | null;
  network: string;
  asset: string;
  fiatAmountCents: number;
  fiatCurrency: string;
  address: string;
  addressRaw: string;
  addressStrategy: string;
  walletVersion: string;
  walletWorkchain: number;
  walletContext: number;
  walletNetworkGlobalId: number;
  walletPublicKeyHash: string;
  amountNano: string;
  paidNano: string;
  reference: string;
  status: TonhubPaymentStatus;
  providerName: string;
  observedTransactionHash: string | null;
  observedAt: Date | null;
  partialPaymentStartedAt: Date | null;
  partialPaymentExpiresAt: Date | null;
  expiresAt: Date | null;
  priceLockedAt: Date | null;
  priceLockedUntil: Date | null;
  observedPayments: unknown;
  createdAt: Date;
  updatedAt: Date;
  metadata: unknown;
  payload: unknown;
};

export type TonhubCreateInvoiceInput = {
  amountCents: number;
  currency: FiatCurrency;
  network: TonNetwork;
  externalId?: string | null;
  metadata?: unknown;
};

