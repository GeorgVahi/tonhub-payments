import type { FiatCurrency } from "./config";
import type { TonNetwork, TonInvoiceMatch } from "./ton/direct-payments";
import type { PaymentAssetSymbol } from "../../shared/payment-assets";

export type TonhubPaymentStatus = "PENDING" | "PARTIAL" | "PAID" | "EXPIRED" | "CANCELLED" | "FAILED";
export type TonhubPaymentOrderStatus = TonhubPaymentStatus | "RECOVERY";

export type TonhubPaymentOrderRecord = {
  id: string;
  externalId: string | null;
  fiatAmountMicros: string;
  fiatCurrency: string;
  creditedFiatMicros: string;
  overpaymentFiatMicros: string;
  status: TonhubPaymentOrderStatus;
  paidAt: Date | null;
  expiresAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  metadata: unknown;
};

export type TonhubObservedPayment = {
  transactionId: string;
  asset?: PaymentAssetSymbol;
  assetDecimals?: number;
  amountAtomic?: string;
  amountFormatted?: string;
  amountNano?: string;
  amountGram?: string;
  amountTon?: string;
  createdAt: string | null;
  status: TonInvoiceMatch["status"];
  comment: string;
};

export type TonhubRateQuote = {
  source: "coingecko" | "usd-peg";
  asset: PaymentAssetSymbol;
  assetDecimals: number;
  fiatPerAsset: number;
  amountAtomic: string;
  amountFormatted: string;
  fiatAmountCents: number;
  fiatAmount: number;
  fiatCurrency: FiatCurrency;
  fiatPerGram?: number;
  fiatPerTon?: number;
  amountNano?: string;
  amountGram?: string;
  amountTon?: string;
  updatedAt: Date | null;
  fetchedAt: Date;
};

export type TonhubPaymentInvoiceRecord = {
  id: string;
  externalId: string | null;
  orderId?: string | null;
  order?: TonhubPaymentOrderRecord | null;
  network: string;
  asset: string;
  checkoutAsset?: string;
  assetKind?: string;
  assetDecimals?: number;
  fiatAmountCents: number;
  fiatAmountMicros?: string | null;
  creditedFiatMicros?: string;
  remainingFiatMicros?: string | null;
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
  amountAtomic?: string | null;
  paidAmountAtomic?: string | null;
  version?: number;
  reference: string;
  status: TonhubPaymentStatus;
  providerName: string;
  observedTransactionHash: string | null;
  observedAt: Date | null;
  firstMovementAt?: Date | null;
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

