import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  XCircle,
  type LucideIcon
} from "lucide-react";
import { createTonQrSvg } from "./createTonQrSvg";
import {
  copyableTonAmount,
  TonManualTransferFields
} from "./TonManualTransferFields";

type TonNetwork = "testnet" | "mainnet";
type FiatCurrency = "EUR" | "USD";
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
  fiatAmountCents: number;
  fiatAmount: number;
  fiatCurrency: FiatCurrency;
  fiatAmountFormatted: string;
  address: string;
  amountNano: string;
  amountTon: string;
  expectedAmountTon: string;
  paidTon: string;
  remainingTon: string;
  reference: string;
  deeplink: string;
  status: InvoiceStatus;
  priceLockedUntil: string | null;
  partialPaymentExpiresAt: string | null;
  quote: {
    fiatPerTon: number;
    fetchedAt: string;
    updatedAt: string | null;
  } | null;
};

type ApiConfig = {
  defaultNetwork: TonNetwork;
  allowedNetworks: TonNetwork[];
  currencies: FiatCurrency[];
};

export type TonhubPaymentWidgetProps = {
  apiBase?: string;
  initialAmount?: string;
  initialCurrency?: FiatCurrency;
  initialNetwork?: TonNetwork;
  externalId?: string;
  metadata?: unknown;
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
  TON_INVOICE_CREATE_FAILED: "We could not create a TON invoice right now. Check the payment configuration and try again.",
  TON_INVOICE_NOT_FOUND: "This invoice could not be found. Create a new invoice and try again.",
  TON_INVOICE_NOT_PAYABLE: "This invoice is no longer payable. Create a new invoice to continue.",
  TON_INVOICE_EXPIRED: "The payment window has expired. Create a new invoice to get a fresh rate.",
  TON_INVOICE_NETWORK_INVALID: "The invoice network is not available for this checkout.",
  TON_INVOICE_CHECK_FAILED: "We could not check the blockchain status right now. Try again in a moment.",
  TON_RATE_UNAVAILABLE: "The TON exchange rate is unavailable right now. Try again in a moment."
};

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
        message: "Your TON payment has been confirmed. The invoice is settled and ready to continue."
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
  externalId,
  metadata,
  onPaid
}: TonhubPaymentWidgetProps) {
  const base = useMemo(() => normalizeApiBase(apiBase), [apiBase]);
  const [amount, setAmount] = useState(initialAmount);
  const [currency, setCurrency] = useState<FiatCurrency>(initialCurrency);
  const [network, setNetwork] = useState<TonNetwork>(initialNetwork ?? "testnet");
  const [allowedNetworks, setAllowedNetworks] = useState<TonNetwork[]>(["testnet", "mainnet"]);
  const [invoice, setInvoice] = useState<TonhubInvoice | null>(null);
  const [notice, setNotice] = useState<WidgetNotice | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch(`${base}/config`)
      .then((response) => response.ok ? response.json() : null)
      .then((data: { config?: ApiConfig } | null) => {
        if (cancelled || !data?.config) {
          return;
        }

        setAllowedNetworks(data.config.allowedNetworks);
        if (!initialNetwork) {
          setNetwork(data.config.defaultNetwork);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [base, initialNetwork]);

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

  const qrSvg = invoice ? createTonQrSvg(invoice.deeplink, "light-on-dark") : null;
  const terminal = invoice ? !isPayable(invoice.status) : false;
  const result = invoice && terminal ? terminalState(invoice) : null;
  const ResultIcon = result?.icon;

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
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        <label className="tonhub-payment-widget__field">
          <span>Currency</span>
          <select value={currency} onChange={(event) => setCurrency(event.target.value as FiatCurrency)}>
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
                disabled={!allowedNetworks.includes(item) || busy}
                onClick={() => setNetwork(item)}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
        <button
          className="tonhub-payment-widget__primary"
          type="button"
          disabled={busy}
          onClick={() => void createInvoice()}
        >
          {busy ? "Creating..." : "Create TON invoice"}
        </button>
      </div>

      {invoice ? (
        <div className="tonhub-payment-widget__invoice" data-tonhub-invoice-status={invoice.status}>
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
              <span>TON amount</span>
              <strong>{invoice.amountTon}</strong>
            </div>
            {invoice.status === "PARTIAL" ? (
              <>
                <div>
                  <span>Paid</span>
                  <strong>{invoice.paidTon}</strong>
                </div>
                <div>
                  <span>Remaining</span>
                  <strong>{invoice.remainingTon}</strong>
                </div>
              </>
            ) : null}
            {invoice.quote ? (
              <div>
                <span>Rate</span>
                <strong>1 TON = {formatRate(invoice.quote.fiatPerTon, invoice.fiatCurrency)}</strong>
              </div>
            ) : null}
            <div>
              <span>Locked until</span>
              <strong>{formatDateTime(invoice.priceLockedUntil)}</strong>
            </div>
          </div>

          {qrSvg && isPayable(invoice.status) ? (
            <div className="tonhub-payment-widget__paybox">
              <div className="tonhub-payment-widget__paybox-header">
                <div>
                  <span>Wallet checkout</span>
                  <strong>{invoice.status === "PARTIAL" ? "Finish the remaining payment" : "Scan to pay"}</strong>
                </div>
                <span className="tonhub-payment-widget__status-pill">{statusLabels[invoice.status]}</span>
              </div>
              <div className="tonhub-payment-widget__qr-shell">
                <div
                  className="tonhub-payment-widget__qr"
                  aria-hidden="true"
                  dangerouslySetInnerHTML={{ __html: qrSvg }}
                />
              </div>
              <TonManualTransferFields
                address={invoice.address}
                amount={invoice.amountTon}
                amountCopyValue={copyableTonAmount(invoice.amountTon)}
                addressLabel="Address"
                amountLabel="Amount"
                copyLabel="Copy"
                copiedLabel="Copied"
              />
              <a className="tonhub-payment-widget__primary" href={invoice.deeplink}>
                Open wallet
              </a>
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
                  <span>TON total</span>
                  <strong>{invoice.expectedAmountTon}</strong>
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

