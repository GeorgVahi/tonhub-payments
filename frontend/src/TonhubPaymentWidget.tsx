import { Component, lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
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

type TonhubInvoice = {
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
};

export type TonhubPaymentWidgetProps = {
  apiBase?: string;
  initialAmount?: string;
  initialCurrency?: FiatCurrency;
  initialNetwork?: TonNetwork;
  initialAsset?: PaymentAsset;
  externalId?: string;
  metadata?: unknown;
  tonConnectManifestUrl?: string;
  onPaid?: (invoice: TonhubInvoice) => void;
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
  externalId,
  metadata,
  tonConnectManifestUrl,
  onPaid
}: TonhubPaymentWidgetProps) {
  const base = useMemo(() => normalizeApiBase(apiBase), [apiBase]);
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
    USDT: "USDT"
  });
  const [invoice, setInvoice] = useState<TonhubInvoice | null>(null);
  const [notice, setNotice] = useState<WidgetNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const [configReady, setConfigReady] = useState(false);

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

      setInvoice(body.invoice);
      setAsset(body.invoice.asset);
      setNetwork(body.invoice.network);
      if (body.finalized || body.invoice.status === "PAID") {
        onPaid?.(body.invoice);
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

      setInvoice(body.invoice);
      setAsset(body.invoice.asset);
      setNetwork(body.invoice.network);
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
        onPaid?.(body.invoice);
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
    setInvoice(null);
    setNotice(null);
  }

  function selectNetwork(nextNetwork: TonNetwork) {
    setNetwork(nextNetwork);
    setAsset(checkoutAssetForNetwork({
      network: nextNetwork,
      defaults: defaultAssetByNetwork,
      available: checkoutAssetsByNetwork
    }));
  }

  const qrSvg = invoice?.deeplink
    ? createTonQrSvg(invoice.deeplink, "light-on-dark", `${invoice.asset} payment QR`)
    : null;
  const terminal = invoice ? !isPayable(invoice.status) : false;
  const result = invoice && terminal ? terminalState(invoice) : null;
  const ResultIcon = result?.icon;
  const fiatProgress = invoice ? fiatPaymentProgress(invoice) : null;

  return (
    <section className="tonhub-payment-widget" data-tonhub-payment-widget>
      <div className="tonhub-payment-widget__form">
        <label className="tonhub-payment-widget__field">
          <span>Amount</span>
          <input
            inputMode="decimal"
            min="0.01"
            step="0.01"
            type="number"
            value={amount}
            disabled={Boolean(invoice)}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        <label className="tonhub-payment-widget__field">
          <span>Currency</span>
          <select
            value={currency}
            disabled={Boolean(invoice)}
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
                disabled={!configReady || !allowedNetworks.includes(item) || busy || Boolean(invoice)}
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
                  disabled={!configReady || busy || Boolean(invoice)}
                  onClick={() => setAsset(item)}
                >
                  <strong>{item}</strong>
                  <small>{item === "USDT" ? "Stablecoin on TON" : "Native TON coin"}</small>
                </button>
              );
            })}
          </div>
        </div>
        <button
          className="tonhub-payment-widget__primary"
          type="button"
          disabled={!configReady || busy || Boolean(invoice)}
          onClick={() => void createInvoice()}
        >
          {!configReady ? "Loading payment options..." : busy ? "Creating..." : `Continue with ${asset}`}
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
              <span>{invoice.asset} amount</span>
              <strong>{invoice.amountFormatted}</strong>
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
          </div>

          {isPayable(invoice.status) ? (
            <div className="tonhub-payment-widget__paybox">
              <div className="tonhub-payment-widget__paybox-header">
                <div>
                  <span>Wallet checkout</span>
                  <strong>{invoice.status === "PARTIAL" ? "Finish the remaining payment" : "Scan to pay"}</strong>
                </div>
                <span className="tonhub-payment-widget__status-pill">{statusLabels[invoice.status]}</span>
              </div>
              {tonConnectManifest ? (
                <TonConnectFallbackBoundary key={`${invoice.id}:${invoice.amountAtomic}`}>
                  <Suspense fallback={<div className="tonhub-payment-widget__ton-connect-loading">Loading wallet connection...</div>}>
                    <TonConnectPayment
                      manifestUrl={tonConnectManifest}
                      invoice={invoice}
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
              <TonManualTransferFields
                address={invoice.address}
                amount={invoice.amountFormatted}
                amountCopyValue={copyableAssetAmount(invoice.amountFormatted)}
                addressLabel="Address"
                amountLabel="Amount"
                copyLabel="Copy"
                copiedLabel="Copied"
              />
              <p className="tonhub-payment-widget__wallet-note">
                Open with Tonhub, Tonkeeper, or Wallet in Telegram. Send only {assetLabels[invoice.asset]} on {invoice.network}.
              </p>
              {invoice.deeplink ? (
                <a className="tonhub-payment-widget__primary" href={invoice.deeplink}>
                  Open wallet
                </a>
              ) : null}
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
        </div>
      ) : null}
    </section>
  );
}

