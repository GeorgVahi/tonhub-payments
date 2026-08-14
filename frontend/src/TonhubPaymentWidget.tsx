import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  XCircle,
  type LucideIcon
} from "lucide-react";
import { createTonQrSvg } from "./createTonQrSvg";
import {
  copyableAssetAmount,
  TonManualTransferFields
} from "./TonManualTransferFields";
import { normalizeTonConnectManifestUrl } from "./ton-connect-manifest";
import {
  clearInvoiceResumeReference,
  invoiceResumeStorageKey,
  readInvoiceResumeReference,
  requestInvoiceResume,
  validInvoiceResumeId,
  writeInvoiceResumeReference,
} from "./invoice-resume";

const TonConnectPayment = lazy(() => import("./TonConnectPayment").then((module) => ({
  default: module.TonConnectPayment,
})));

class TonConnectFallbackBoundary extends Component<{
  children: ReactNode;
}, {
  failed: boolean;
}> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <p className="tonhub-payment-widget__ton-connect-loading" role="status">
          Wallet connection is unavailable. Use the QR, wallet link, or manual details below.
        </p>
      );
    }
    return this.props.children;
  }
}

type TonNetwork = "testnet" | "mainnet";
type FiatCurrency = "EUR" | "USD";
type PaymentAsset = "GRAM" | "USDT";
type InvoiceStatus = "PENDING" | "PARTIAL" | "PAID" | "EXPIRED" | "CANCELLED" | "FAILED";
type NoticeTone = "info" | "success" | "warning" | "error";

type WidgetNotice = {
  tone: NoticeTone;
  title: string;
  message: string;
  code?: string;
};

type PaymentOption = {
  asset: PaymentAsset;
  label: string;
  assetDecimals: number;
  amountAtomic: string;
  amountFormatted: string;
  payableAmountAtomic: string | null;
  payableAmountFormatted: string | null;
  fiatPerAsset: number | null;
  discountFiatMicros: string | null;
  discountFiatFormatted: string | null;
  selected: boolean;
  selectionLocked: boolean;
  deeplink: string | null;
};

export type TonhubInvoice = {
  id: string;
  externalId: string | null;
  network: TonNetwork;
  asset: PaymentAsset;
  assetKind: "NATIVE" | "JETTON";
  assetDecimals: number;
  fiatAmountCents: number;
  fiatAmount: number;
  fiatCurrency: FiatCurrency;
  fiatAmountFormatted: string;
  creditedFiatMicros: string;
  creditedFiatFormatted: string;
  remainingFiatMicros: string | null;
  remainingFiatFormatted: string | null;
  address: string;
  addressStrategy: "unique-address" | string;
  amountNano: string | null;
  amountGram: string | null;
  amountTon: string | null;
  amountAtomic: string;
  amountFormatted: string;
  expectedAmountAtomic: string;
  expectedAmountFormatted: string;
  paidAmountAtomic: string;
  paidAmountFormatted: string;
  remainingAmountAtomic: string;
  remainingAmountFormatted: string;
  expectedAmountGram: string | null;
  expectedAmountTon: string | null;
  paidGram: string | null;
  paidTon: string | null;
  remainingGram: string | null;
  remainingTon: string | null;
  reference: string;
  deeplink: string | null;
  status: InvoiceStatus;
  expiresAt: string | null;
  priceLockedUntil: string | null;
  partialPaymentExpiresAt: string | null;
  paymentSelectionLockedAsset: PaymentAsset | null;
  paymentSelectionLockedAt: string | null;
  paymentSelectionLocked: boolean;
  paymentOptions: PaymentOption[];
  quote: {
    asset: PaymentAsset;
    assetDecimals: number;
    fiatPerAsset: number;
    amountAtomic: string;
    amountFormatted: string;
    fiatPerGram: number | null;
    fiatPerTon: number | null;
    fetchedAt: string;
    updatedAt: string | null;
  } | null;
};

type ApiConfig = {
  defaultNetwork: TonNetwork;
  allowedNetworks: TonNetwork[];
  currencies: FiatCurrency[];
  defaultAsset: PaymentAsset;
  checkoutAssets: PaymentAsset[];
  defaultAssetByNetwork: Record<TonNetwork, PaymentAsset>;
  checkoutAssetsByNetwork: Record<TonNetwork, PaymentAsset[]>;
  assets: Array<{
    symbol: PaymentAsset;
    label: string;
    kind: "NATIVE" | "JETTON";
    decimals: number;
    checkoutFractionDigits: number;
    pricingStrategy: "MARKET" | "USD_PEG";
  }>;
  orderPolicyByCurrency: Record<FiatCurrency, {
    minimumOrderFiatMicros: string;
    gramDiscountMaxFiatMicros: string;
  }>;
};

export type TonhubPaymentWidgetProps = {
  apiBase?: string;
  initialAmount?: string;
  initialCurrency?: FiatCurrency;
  initialNetwork?: TonNetwork;
  initialAsset?: PaymentAsset;
  initialInvoiceId?: string;
  resumeStorageKey?: string;
  externalId?: string;
  metadata?: unknown;
  tonConnectManifestUrl?: string;
  onPaid?: (invoice: TonhubInvoice) => void;
  onInvoiceChange?: (invoice: TonhubInvoice | null) => void;
};

const statusLabels: Record<InvoiceStatus, string> = {
  PENDING: "Waiting for payment",
  PARTIAL: "Partially paid",
  PAID: "Payment successful",
  EXPIRED: "Expired",
  CANCELLED: "Cancelled",
  FAILED: "Failed"
};

const errorMessages: Record<string, string> = {
  INVALID_INVOICE_REQUEST: "Check the amount, currency, and network, then try again.",
  TON_INVOICE_CREATE_FAILED: "We could not create this payment invoice right now. Check the payment configuration and try again.",
  TON_INVOICE_ASSET_UNAVAILABLE: "That payment asset is not available on the selected network.",
  TON_INVOICE_PAYMENT_METHOD_LOCKED: "The original payment method is locked because a transfer has already been detected. You can still open the other method for the remaining balance.",
  TON_INVOICE_PAYMENT_METHOD_UNAVAILABLE: "That payment method is not available for this invoice.",
  TON_INVOICE_NOT_FOUND: "This invoice could not be found. Create a new invoice and try again.",
  TON_INVOICE_NOT_PAYABLE: "This invoice is no longer payable. Create a new invoice to continue.",
  TON_INVOICE_EXPIRED: "The payment window has expired. Create a new invoice to get a fresh rate.",
  TON_INVOICE_NETWORK_INVALID: "The invoice network is not available for this checkout.",
  TON_INVOICE_CHECK_FAILED: "We could not check the blockchain status right now. Try again in a moment.",
  TON_RATE_UNAVAILABLE: "The payment exchange rate is unavailable right now. Try again in a moment."
};

export function checkoutAssetForNetwork(input: {
  network: TonNetwork;
  requested?: PaymentAsset;
  defaults: Record<TonNetwork, PaymentAsset>;
  available: Record<TonNetwork, PaymentAsset[]>;
}) {
  const available = input.available[input.network];
  if (input.requested && available.includes(input.requested)) {
    return input.requested;
  }
  const defaultAsset = input.defaults[input.network];
  return available.includes(defaultAsset) ? defaultAsset : (available[0] ?? "GRAM");
}

export function fiatPaymentProgress(input: {
  creditedFiatFormatted: string;
  remainingFiatFormatted: string | null;
  fiatCurrency: FiatCurrency;
}) {
  return {
    paid: input.creditedFiatFormatted,
    remaining: input.remainingFiatFormatted ?? `0.00 ${input.fiatCurrency}`,
  };
}

export function formatFiatPolicyMicros(value: string | undefined, currency: FiatCurrency) {
  if (!value || !/^\d+$/.test(value)) return null;
  const micros = BigInt(value);
  const whole = micros / BigInt(1_000_000);
  const cents = ((micros % BigInt(1_000_000)) / BigInt(10_000)).toString().padStart(2, "0");
  const symbol = currency === "USD" ? "$" : "€";
  return `${symbol}${whole}${cents === "00" ? "" : `.${cents}`}`;
}

export function paymentRailAction(input: {
  invoiceAsset: PaymentAsset;
  requestedAsset: PaymentAsset;
  selectionLocked: boolean;
}) {
  if (input.invoiceAsset === input.requestedAsset) return "selected" as const;
  return input.selectionLocked ? "top-up" as const : "switch" as const;
}

export function refreshedPaymentInstructionAsset(input: {
  current: PaymentAsset | null;
  invoiceAsset: PaymentAsset;
  available: PaymentAsset[];
  preserve: boolean;
}) {
  return input.preserve && input.current && input.available.includes(input.current)
    ? input.current
    : input.invoiceAsset;
}

export function immutablePaymentOptionSaving(
  options: Array<{ asset: PaymentAsset; discountFiatFormatted: string | null }>,
  asset: PaymentAsset,
) {
  return options.find((option) => option.asset === asset)?.discountFiatFormatted ?? null;
}

export function PaymentStatusAnnouncement({ message }: { message: string }) {
  return (
    <p
      className="tonhub-payment-widget__sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {message}
    </p>
  );
}

function normalizeApiBase(apiBase: string) {
  return apiBase.replace(/\/+$/, "");
}

function formatRate(value: number, currency: FiatCurrency) {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    maximumFractionDigits: 4
  }).format(value);
}

function isPayable(status: InvoiceStatus) {
  return status === "PENDING" || status === "PARTIAL";
}

function readableApiMessage(error: string | undefined, errorCode: string | undefined, fallback: string) {
  if (errorCode && errorMessages[errorCode]) {
    return errorMessages[errorCode];
  }

  const trimmed = error?.trim();
  if (trimmed && !/^[A-Z0-9_]+$/.test(trimmed)) {
    return trimmed;
  }

  return fallback;
}

function errorNotice(input: {
  title: string;
  fallback: string;
  error?: string;
  errorCode?: string;
}): WidgetNotice {
  return {
    tone: "error",
    title: input.title,
    message: readableApiMessage(input.error, input.errorCode, input.fallback),
    code: input.errorCode
  };
}

function formatDateTime(value: string | null) {
  if (!value) {
    return "None";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "None";
  }

  return date.toLocaleString();
}

function terminalState(invoice: TonhubInvoice): {
  tone: Exclude<NoticeTone, "info">;
  icon: LucideIcon;
  title: string;
  message: string;
} {
  switch (invoice.status) {
    case "PAID":
      return {
        tone: "success",
        icon: CheckCircle2,
        title: "Payment successful",
        message: "Your payment has been confirmed. The order is settled and ready to continue."
      };
    case "EXPIRED":
      return {
        tone: "warning",
        icon: Clock3,
        title: "Invoice expired",
        message: "The locked rate window ended before the full payment arrived. Create a new invoice to continue."
      };
    case "CANCELLED":
      return {
        tone: "warning",
        icon: XCircle,
        title: "Invoice cancelled",
        message: "This invoice is no longer active. Create a new invoice to start a fresh payment."
      };
    case "FAILED":
    default:
      return {
        tone: "error",
        icon: AlertTriangle,
        title: "Payment failed",
        message: "The payment could not be completed for this invoice. Create a new invoice or contact support."
      };
  }
}

export function TonhubPaymentWidget({
  apiBase = "/api/tonhub-payments",
  initialAmount = "10.00",
  initialCurrency = "EUR",
  initialNetwork,
  initialAsset,
  initialInvoiceId,
  resumeStorageKey,
  externalId,
  metadata,
  tonConnectManifestUrl,
  onPaid,
  onInvoiceChange,
}: TonhubPaymentWidgetProps) {
  const base = useMemo(() => normalizeApiBase(apiBase), [apiBase]);
  const resumeKey = useMemo(() => {
    if (!resumeStorageKey?.trim()) return null;
    return invoiceResumeStorageKey(base, resumeStorageKey);
  }, [base, resumeStorageKey]);
  const tonConnectManifest = useMemo(
    () => normalizeTonConnectManifestUrl(tonConnectManifestUrl),
    [tonConnectManifestUrl],
  );
  const [amount, setAmount] = useState(initialAmount);
  const [currency, setCurrency] = useState<FiatCurrency>(initialCurrency);
  const [network, setNetwork] = useState<TonNetwork>(initialNetwork ?? "testnet");
  const [asset, setAsset] = useState<PaymentAsset>("GRAM");
  const [allowedNetworks, setAllowedNetworks] = useState<TonNetwork[]>(["testnet", "mainnet"]);
  const [checkoutAssetsByNetwork, setCheckoutAssetsByNetwork] = useState<Record<TonNetwork, PaymentAsset[]>>({
    testnet: ["GRAM"],
    mainnet: ["GRAM"]
  });
  const [defaultAssetByNetwork, setDefaultAssetByNetwork] = useState<Record<TonNetwork, PaymentAsset>>({
    testnet: "GRAM",
    mainnet: "GRAM"
  });
  const [assetLabels, setAssetLabels] = useState<Record<PaymentAsset, string>>({
    GRAM: "GRAM (ex TON)",
    USDT: "USD₮"
  });
  const [orderPolicyByCurrency, setOrderPolicyByCurrency] = useState<ApiConfig["orderPolicyByCurrency"]>({
    USD: { minimumOrderFiatMicros: "10000000", gramDiscountMaxFiatMicros: "1000000" },
    EUR: { minimumOrderFiatMicros: "10000000", gramDiscountMaxFiatMicros: "1000000" },
  });
  const [invoice, setInvoice] = useState<TonhubInvoice | null>(null);
  const [instructionAsset, setInstructionAsset] = useState<PaymentAsset | null>(null);
  const [notice, setNotice] = useState<WidgetNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const [configReady, setConfigReady] = useState(false);
  const [restoring, setRestoring] = useState(Boolean(initialInvoiceId || resumeStorageKey));
  const [resumeBlocked, setResumeBlocked] = useState(false);
  const [resumeRevision, setResumeRevision] = useState(0);
  const onPaidRef = useRef(onPaid);
  const onInvoiceChangeRef = useRef(onInvoiceChange);
  const lastNotifiedInvoiceRef = useRef<string | null>(null);

  useEffect(() => {
    onPaidRef.current = onPaid;
    onInvoiceChangeRef.current = onInvoiceChange;
  }, [onInvoiceChange, onPaid]);

  useEffect(() => {
    let cancelled = false;
    setConfigReady(false);

    fetch(`${base}/config`)
      .then((response) => response.ok ? response.json() : null)
      .then((data: { config?: ApiConfig } | null) => {
        if (cancelled) {
          return;
        }
        if (!data?.config) {
          throw new Error("Payment options are unavailable.");
        }

        setAllowedNetworks(data.config.allowedNetworks);
        const nextNetwork = initialNetwork ?? data.config.defaultNetwork;
        const assetsByNetwork = data.config.checkoutAssetsByNetwork ?? {
          testnet: ["GRAM"],
          mainnet: data.config.checkoutAssets ?? ["GRAM"]
        };
        const defaultsByNetwork = data.config.defaultAssetByNetwork ?? {
          testnet: "GRAM",
          mainnet: data.config.defaultAsset ?? "GRAM"
        };
        setNetwork(nextNetwork);
        setCheckoutAssetsByNetwork(assetsByNetwork);
        setDefaultAssetByNetwork(defaultsByNetwork);
        setAssetLabels(Object.fromEntries(data.config.assets.map((item) => [item.symbol, item.label])) as Record<PaymentAsset, string>);
        if (data.config.orderPolicyByCurrency) {
          setOrderPolicyByCurrency(data.config.orderPolicyByCurrency);
        }
        setAsset(checkoutAssetForNetwork({
          network: nextNetwork,
          requested: initialAsset,
          defaults: defaultsByNetwork,
          available: assetsByNetwork
        }));
        setConfigReady(true);
      })
      .catch(() => {
        if (!cancelled) {
          setNotice({
            tone: "error",
            title: "Payment options unavailable",
            message: "The checkout configuration could not be loaded. Check your connection and try again."
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [base, initialAsset, initialNetwork]);

  useEffect(() => {
    if (!configReady) return undefined;

    let cancelled = false;
    const explicitId = initialInvoiceId === undefined
      ? null
      : validInvoiceResumeId(initialInvoiceId);
    if (initialInvoiceId !== undefined && !explicitId) {
      setRestoring(false);
      setResumeBlocked(true);
      setNotice({
        tone: "error",
        title: "Saved payment could not be restored",
        message: "The supplied invoice reference is invalid. Check the order link before creating another payment.",
      });
      return undefined;
    }

    const storedId = !explicitId && resumeKey
      ? readInvoiceResumeReference(window.localStorage, resumeKey)
      : null;
    const invoiceId = explicitId ?? storedId;
    if (!invoiceId) {
      setRestoring(false);
      setResumeBlocked(false);
      return undefined;
    }

    setRestoring(true);
    setResumeBlocked(false);
    requestInvoiceResume<TonhubInvoice>({ apiBase: base, invoiceId })
      .then((result) => {
        if (cancelled) return;
        if (result.state === "not-found" && storedId) {
          if (resumeKey) clearInvoiceResumeReference(window.localStorage, resumeKey);
          setResumeBlocked(false);
          setNotice({
            tone: "warning",
            title: "Saved payment was not found",
            message: "The saved browser reference is no longer available. You can create a new payment.",
          });
          return;
        }
        if (result.state !== "restored") {
          throw new Error("Unable to restore invoice.");
        }

        presentInvoice(result.invoice);
        if (result.invoice.status === "PARTIAL") {
          setNotice({
            tone: "info",
            title: "Payment restored",
            message: `${result.invoice.creditedFiatFormatted} is already credited. ${result.invoice.remainingFiatFormatted ?? "The outstanding balance"} remains to be paid.`,
          });
        } else if (result.invoice.status === "PENDING") {
          setNotice({
            tone: "info",
            title: "Payment restored",
            message: "Continue with the same unique TON address and exact amount shown below.",
          });
        } else {
          setNotice(null);
        }
        if (result.invoice.status === "PAID") {
          onPaidRef.current?.(result.invoice);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setResumeBlocked(true);
        setNotice({
          tone: "error",
          title: "Saved payment could not be restored",
          message: "The payment service did not return the saved invoice. Retry before creating another payment.",
        });
      })
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });

    return () => {
      cancelled = true;
    };
  }, [base, configReady, initialInvoiceId, resumeKey, resumeRevision]);

  useEffect(() => {
    if (resumeKey && invoice) {
      writeInvoiceResumeReference(window.localStorage, resumeKey, invoice.id);
    }
  }, [invoice?.id, resumeKey]);

  useEffect(() => {
    if (!invoice || !isPayable(invoice.status)) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      void checkInvoice({ quiet: true });
    }, 5000);

    return () => window.clearInterval(timer);
  }, [base, invoice?.id, invoice?.status]);

  async function createInvoice() {
    setBusy(true);
    setNotice(null);

    try {
      const response = await fetch(`${base}/invoices`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          amount,
          currency,
          network,
          asset,
          externalId,
          metadata
        })
      });
      const body = (await response.json().catch(() => ({}))) as {
        invoice?: TonhubInvoice;
        finalized?: boolean;
        error?: string;
        errorCode?: string;
      };

      if (!response.ok || !body.invoice) {
        setNotice(errorNotice({
          title: "Invoice was not created",
          fallback: "Unable to create invoice.",
          error: body.error,
          errorCode: body.errorCode
        }));
        return;
      }

      presentInvoice(body.invoice);
      if (body.finalized || body.invoice.status === "PAID") {
        onPaidRef.current?.(body.invoice);
      }
    } catch {
      setNotice({
        tone: "error",
        title: "Invoice was not created",
        message: "The payment service did not respond. Check your connection and try again."
      });
    } finally {
      setBusy(false);
    }
  }

  async function checkInvoice(options: { quiet?: boolean } = {}) {
    if (!invoice) {
      return;
    }

    if (!options.quiet) {
      setBusy(true);
      setNotice(null);
    }

    try {
      const response = await fetch(`${base}/invoices/${encodeURIComponent(invoice.id)}/check`, {
        method: "POST"
      });
      const body = (await response.json().catch(() => ({}))) as {
        invoice?: TonhubInvoice;
        finalized?: boolean;
        error?: string;
        errorCode?: string;
      };

      if (!body.invoice) {
        if (!options.quiet) {
          setNotice(errorNotice({
            title: "Payment status unavailable",
            fallback: "Unable to check invoice.",
            error: body.error,
            errorCode: body.errorCode
          }));
        }
        return;
      }

      presentInvoice(body.invoice, { preserveInstruction: true });
      if (!response.ok) {
        if (!options.quiet) {
          setNotice(errorNotice({
            title: "Payment status unavailable",
            fallback: "Unable to check invoice.",
            error: body.error,
            errorCode: body.errorCode
          }));
        }
        return;
      }

      if (body.finalized || body.invoice.status === "PAID") {
        setNotice(null);
        onPaidRef.current?.(body.invoice);
      } else if (!options.quiet) {
        setNotice({
          tone: "info",
          title: "Payment is still pending",
          message: "No complete matching transfer was found yet. Keep the wallet transaction open and check again shortly."
        });
      }
    } catch {
      if (!options.quiet) {
        setNotice({
          tone: "error",
          title: "Payment status unavailable",
          message: "The payment service did not respond. Check your connection and try again."
        });
      }
    } finally {
      if (!options.quiet) {
        setBusy(false);
      }
    }
  }

  function resetInvoice() {
    if (resumeKey) clearInvoiceResumeReference(window.localStorage, resumeKey);
    setInvoice(null);
    setInstructionAsset(null);
    setNotice(null);
    lastNotifiedInvoiceRef.current = null;
    onInvoiceChangeRef.current?.(null);
  }

  function presentInvoice(
    nextInvoice: TonhubInvoice,
    options: { preserveInstruction?: boolean } = {},
  ) {
    setInvoice(nextInvoice);
    setInstructionAsset((current) => refreshedPaymentInstructionAsset({
      current,
      invoiceAsset: nextInvoice.asset,
      available: nextInvoice.paymentOptions.map((option) => option.asset),
      preserve: options.preserveInstruction === true,
    }));
    setAsset(nextInvoice.asset);
    setNetwork(nextInvoice.network);
    setCurrency(nextInvoice.fiatCurrency);
    setAmount((nextInvoice.fiatAmountCents / 100).toFixed(2));
    const notificationFingerprint = [
      nextInvoice.id,
      nextInvoice.status,
      nextInvoice.asset,
      nextInvoice.creditedFiatMicros,
      nextInvoice.remainingFiatMicros,
      nextInvoice.amountAtomic,
    ].join(":");
    if (lastNotifiedInvoiceRef.current !== notificationFingerprint) {
      lastNotifiedInvoiceRef.current = notificationFingerprint;
      onInvoiceChangeRef.current?.(nextInvoice);
    }
  }

  async function selectInvoicePaymentMethod(nextAsset: PaymentAsset) {
    if (!invoice || nextAsset === invoice.asset) {
      setInstructionAsset(nextAsset);
      return;
    }
    if (invoice.paymentSelectionLocked || invoice.status !== "PENDING") {
      setInstructionAsset(nextAsset);
      setNotice({
        tone: "info",
        title: `${assetLabels[nextAsset]} opened for the remaining balance`,
        message: "Your original payment choice stays locked. The server will combine verified TON-network transfers by their fiat value.",
      });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`${base}/invoices/${encodeURIComponent(invoice.id)}/payment-method`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ asset: nextAsset }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        invoice?: TonhubInvoice;
        error?: string;
        errorCode?: string;
      };
      if (!response.ok || !body.invoice) {
        setNotice(errorNotice({
          title: "Payment method was not changed",
          fallback: "Unable to change the payment method.",
          error: body.error,
          errorCode: body.errorCode,
        }));
        if (body.errorCode === "TON_INVOICE_PAYMENT_METHOD_LOCKED") {
          await checkInvoice({ quiet: true });
        }
        return;
      }
      presentInvoice(body.invoice);
      setNotice({
        tone: "success",
        title: `Payment method changed to ${assetLabels[body.invoice.asset]}`,
        message: "Use the updated exact amount below. The fiat order total has not changed.",
      });
    } catch {
      setNotice({
        tone: "error",
        title: "Payment method was not changed",
        message: "The payment service did not respond. Check your connection and try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  function selectNetwork(nextNetwork: TonNetwork) {
    setNetwork(nextNetwork);
    setAsset(checkoutAssetForNetwork({
      network: nextNetwork,
      defaults: defaultAssetByNetwork,
      available: checkoutAssetsByNetwork
    }));
  }

  const activePaymentOption = invoice?.paymentOptions.find((option) =>
    option.asset === (instructionAsset ?? invoice.asset)
  ) ?? null;
  const paymentInstruction = invoice && activePaymentOption?.payableAmountAtomic &&
    activePaymentOption.payableAmountFormatted
    ? {
        ...invoice,
        asset: activePaymentOption.asset,
        assetKind: activePaymentOption.asset === "GRAM" ? "NATIVE" as const : "JETTON" as const,
        assetDecimals: activePaymentOption.assetDecimals,
        amountAtomic: activePaymentOption.payableAmountAtomic,
        amountFormatted: activePaymentOption.payableAmountFormatted,
        deeplink: activePaymentOption.deeplink,
      }
    : null;
  const qrSvg = paymentInstruction?.deeplink
    ? createTonQrSvg(
        paymentInstruction.deeplink,
        "light-on-dark",
        `${assetLabels[paymentInstruction.asset]} payment QR`,
      )
    : null;
  const terminal = invoice ? !isPayable(invoice.status) : false;
  const result = invoice && terminal ? terminalState(invoice) : null;
  const ResultIcon = result?.icon;
  const fiatProgress = invoice ? fiatPaymentProgress(invoice) : null;
  const minimumOrder = formatFiatPolicyMicros(
    orderPolicyByCurrency[currency]?.minimumOrderFiatMicros,
    currency,
  );
  const configuredGramSaving = formatFiatPolicyMicros(
    orderPolicyByCurrency[currency]?.gramDiscountMaxFiatMicros,
    currency,
  );
  const invoiceGramSaving = invoice
    ? immutablePaymentOptionSaving(invoice.paymentOptions, "GRAM")
    : null;
  const checkoutLocked = busy || restoring || resumeBlocked || Boolean(invoice);

  return (
    <section className="tonhub-payment-widget" data-tonhub-payment-widget>
      <div className="tonhub-payment-widget__form">
        <label className="tonhub-payment-widget__field">
          <span>Amount</span>
          <input
            inputMode="decimal"
            min={minimumOrder?.replace(/[^\d.]/g, "") || "0.01"}
            step="0.01"
            type="number"
            value={amount}
            disabled={checkoutLocked}
            onChange={(event) => setAmount(event.target.value)}
          />
          {minimumOrder ? <small>Minimum order: {minimumOrder}</small> : null}
        </label>
        <label className="tonhub-payment-widget__field">
          <span>Currency</span>
          <select
            value={currency}
            disabled={checkoutLocked}
            onChange={(event) => setCurrency(event.target.value as FiatCurrency)}
          >
            <option value="EUR">EUR</option>
            <option value="USD">USD</option>
          </select>
        </label>
        <div className="tonhub-payment-widget__field">
          <span>Network</span>
          <div className="tonhub-payment-widget__segments" role="radiogroup" aria-label="TON network">
            {(["testnet", "mainnet"] as TonNetwork[]).map((item) => (
              <button
                className={item === network ? "is-selected" : ""}
                key={item}
                type="button"
                role="radio"
                aria-checked={item === network}
                disabled={!configReady || !allowedNetworks.includes(item) || checkoutLocked}
                onClick={() => selectNetwork(item)}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
        <div className="tonhub-payment-widget__field tonhub-payment-widget__asset-field">
          <span>Pay with</span>
          <div className="tonhub-payment-widget__segments" role="radiogroup" aria-label="Payment asset">
            {(["USDT", "GRAM"] as PaymentAsset[]).map((item) => {
              const available = checkoutAssetsByNetwork[network].includes(item);
              if (!available) {
                return null;
              }
              return (
                <button
                  className={item === asset ? "is-selected" : ""}
                  key={item}
                  type="button"
                  role="radio"
                  aria-checked={item === asset}
                  disabled={!configReady || checkoutLocked}
                  onClick={() => setAsset(item)}
                >
                  <strong>{assetLabels[item]}</strong>
                  <small>{item === "USDT"
                    ? "Familiar Tether, issued on TON"
                    : `${configuredGramSaving ? `Save up to ${configuredGramSaving}` : "Native TON coin"} when paid fully in GRAM`}</small>
                </button>
              );
            })}
          </div>
        </div>
        <button
          className="tonhub-payment-widget__primary"
          type="button"
          disabled={!configReady || checkoutLocked}
          onClick={() => void createInvoice()}
        >
          {!configReady
            ? "Loading payment options..."
            : restoring
              ? "Restoring payment..."
            : busy
              ? "Creating..."
              : `Continue with ${assetLabels[asset]}`}
        </button>
      </div>

      {invoice ? (
        <div className="tonhub-payment-widget__invoice" data-tonhub-invoice-status={invoice.status}>
          <PaymentStatusAnnouncement
            message={invoice.status === "PARTIAL" && fiatProgress
              ? `${statusLabels[invoice.status]}. ${fiatProgress.paid} credited; ${fiatProgress.remaining} remaining.`
              : statusLabels[invoice.status]}
          />
          <div className="tonhub-payment-widget__summary">
            <div>
              <span>Status</span>
              <strong>{statusLabels[invoice.status]}</strong>
            </div>
            <div>
              <span>Network</span>
              <strong>{invoice.network}</strong>
            </div>
            <div>
              <span>Fiat amount</span>
              <strong>{invoice.fiatAmountFormatted}</strong>
            </div>
            <div>
              <span>{assetLabels[invoice.asset]} remaining</span>
              <strong>{invoice.amountFormatted}</strong>
            </div>
            {invoice.quote ? (
              <div>
                <span>Rate</span>
                <strong>1 {invoice.asset} = {formatRate(invoice.quote.fiatPerAsset, invoice.fiatCurrency)}</strong>
              </div>
            ) : null}
            <div>
              <span>Locked until</span>
              <strong>{formatDateTime(invoice.priceLockedUntil)}</strong>
            </div>
            {invoice.status === "PARTIAL" ? (
              <>
                <div>
                  <span>Paid value</span>
                  <strong>{fiatProgress?.paid}</strong>
                </div>
                <div>
                  <span>Remaining value</span>
                  <strong>{fiatProgress?.remaining}</strong>
                </div>
              </>
            ) : null}
          </div>

          {isPayable(invoice.status) ? (
            <div className="tonhub-payment-widget__paybox">
              <div className="tonhub-payment-widget__paybox-header">
                <div>
                  <span>Pay on TON</span>
                  <strong>{invoice.status === "PARTIAL"
                    ? `Finish with ${paymentInstruction ? assetLabels[paymentInstruction.asset] : assetLabels[invoice.asset]}`
                    : `Send ${paymentInstruction ? assetLabels[paymentInstruction.asset] : assetLabels[invoice.asset]}`}</strong>
                </div>
                <span className="tonhub-payment-widget__status-pill">{statusLabels[invoice.status]}</span>
              </div>
              {invoice.paymentOptions.length > 1 ? (
                <div className="tonhub-payment-widget__rail-picker" role="group" aria-label="Payment instruction">
                  {invoice.paymentOptions.map((option) => {
                    const action = paymentRailAction({
                      invoiceAsset: invoice.asset,
                      requestedAsset: option.asset,
                      selectionLocked: invoice.paymentSelectionLocked,
                    });
                    const active = paymentInstruction?.asset === option.asset;
                    return (
                      <button
                        className={active ? "is-selected" : ""}
                        key={option.asset}
                        type="button"
                        aria-pressed={active}
                        disabled={busy || !option.payableAmountAtomic}
                        onClick={() => void selectInvoicePaymentMethod(option.asset)}
                      >
                        <span>
                          <strong>{option.label}</strong>
                          {option.asset === invoice.asset ? <em>Original choice</em> : null}
                        </span>
                        <b>{option.payableAmountFormatted ?? "Unavailable"}</b>
                        <small>{action === "selected"
                          ? invoice.paymentSelectionLocked ? "Locked after first transfer" : "Selected payment method"
                          : action === "switch" ? "Switch before sending" : "Open for the remaining balance"}</small>
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {invoice.paymentSelectionLocked && paymentInstruction?.asset !== invoice.asset ? (
                <p className="tonhub-payment-widget__rail-note" role="status">
                  The original {assetLabels[invoice.asset]} choice stays locked. This additional transfer will be combined by fiat value; a mixed payment does not receive the GRAM-only saving.
                </p>
              ) : invoice.asset === "GRAM" && invoiceGramSaving ? (
                <p className="tonhub-payment-widget__rail-note">
                  Save up to {invoiceGramSaving} only when the complete payment is received in GRAM. Sending USD₮ makes the payment mixed and keeps the original fiat total.
                </p>
              ) : null}
              {tonConnectManifest && paymentInstruction ? (
                <TonConnectFallbackBoundary key={`${invoice.id}:${paymentInstruction.asset}:${paymentInstruction.amountAtomic}`}>
                  <Suspense fallback={<div className="tonhub-payment-widget__ton-connect-loading">Loading wallet connection...</div>}>
                    <TonConnectPayment
                      manifestUrl={tonConnectManifest}
                      invoice={paymentInstruction}
                      onSubmitted={() => setNotice({
                        tone: "info",
                        title: "Transaction submitted",
                        message: "The wallet accepted the request. Confirmation still comes from the on-chain payment ledger.",
                      })}
                      onError={() => setNotice({
                        tone: "warning",
                        title: "Wallet did not submit the payment",
                        message: "Try TON Connect again, open a wallet directly, or use the manual address and amount below.",
                      })}
                    />
                  </Suspense>
                </TonConnectFallbackBoundary>
              ) : null}
              {tonConnectManifest && qrSvg ? (
                <div className="tonhub-payment-widget__fallback-separator" aria-hidden="true">
                  <span>or scan / copy manually</span>
                </div>
              ) : null}
              {qrSvg ? (
                <div className="tonhub-payment-widget__qr-shell">
                  <div
                    className="tonhub-payment-widget__qr"
                    aria-hidden="true"
                    dangerouslySetInnerHTML={{ __html: qrSvg }}
                  />
                </div>
              ) : null}
              {paymentInstruction ? (
                <>
                  <TonManualTransferFields
                    address={invoice.address}
                    amount={paymentInstruction.amountFormatted}
                    amountCopyValue={copyableAssetAmount(paymentInstruction.amountFormatted)}
                    addressLabel="Unique TON address"
                    amountLabel="Exact amount"
                    copyLabel="Copy"
                    copiedLabel="Copied"
                  />
                  <p className="tonhub-payment-widget__wallet-note">
                    Open with Tonhub, Tonkeeper, Trust Wallet, or Wallet in Telegram. Send only {assetLabels[paymentInstruction.asset]} on TON {invoice.network}.
                  </p>
                  {paymentInstruction.deeplink ? (
                    <a className="tonhub-payment-widget__primary" href={paymentInstruction.deeplink}>
                      Open wallet
                    </a>
                  ) : null}
                </>
              ) : (
                <p className="tonhub-payment-widget__rail-note" role="alert">
                  This payment instruction is unavailable. Return to the original method or check the invoice again.
                </p>
              )}
              <button
                className="tonhub-payment-widget__secondary"
                type="button"
                disabled={busy}
                onClick={() => void checkInvoice()}
              >
                Check payment
              </button>
            </div>
          ) : null}

          {result ? (
            <div className={`tonhub-payment-widget__result tonhub-payment-widget__result--${result.tone}`}>
              <div className="tonhub-payment-widget__result-icon" aria-hidden="true">
                {ResultIcon ? <ResultIcon /> : null}
              </div>
              <h3>{result.title}</h3>
              <p>{result.message}</p>
              <div className="tonhub-payment-widget__result-details">
                <div>
                  <span>Amount</span>
                  <strong>{invoice.fiatAmountFormatted}</strong>
                </div>
                <div>
                  <span>{invoice.asset} total</span>
                  <strong>{invoice.expectedAmountFormatted}</strong>
                </div>
                <div>
                  <span>Network</span>
                  <strong>{invoice.network}</strong>
                </div>
                <div>
                  <span>Invoice</span>
                  <strong>{invoice.externalId || invoice.id}</strong>
                </div>
              </div>
              <button className="tonhub-payment-widget__primary" type="button" onClick={resetInvoice}>
                Create another invoice
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {notice ? (
        <div
          className={`tonhub-payment-widget__notice tonhub-payment-widget__notice--${notice.tone}`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          <strong>{notice.title}</strong>
          <span>{notice.message}</span>
          {notice.code ? <code>{notice.code}</code> : null}
          {resumeBlocked ? (
            <button
              className="tonhub-payment-widget__secondary"
              type="button"
              onClick={() => {
                setRestoring(true);
                setResumeBlocked(false);
                setResumeRevision((value) => value + 1);
              }}
            >
              Retry saved payment
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

