import { useEffect, useMemo, useState } from "react";
import { createTonQrSvg } from "./createTonQrSvg";
import {
  copyableTonAmount,
  TonManualTransferFields
} from "./TonManualTransferFields";

type TonNetwork = "testnet" | "mainnet";
type FiatCurrency = "EUR" | "USD";
type InvoiceStatus = "PENDING" | "PARTIAL" | "PAID" | "EXPIRED" | "CANCELLED" | "FAILED";

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
  PAID: "Paid",
  EXPIRED: "Expired",
  CANCELLED: "Cancelled",
  FAILED: "Failed"
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
  const [notice, setNotice] = useState("");
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
    setNotice("");

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
        error?: string;
        errorCode?: string;
      };

      if (!response.ok || !body.invoice) {
        setNotice(body.error || body.errorCode || "Unable to create invoice.");
        return;
      }

      setInvoice(body.invoice);
    } catch {
      setNotice("Unable to create invoice.");
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
      setNotice("");
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

      if (!response.ok || !body.invoice) {
        if (!options.quiet) {
          setNotice(body.error || body.errorCode || "Unable to check invoice.");
        }
        return;
      }

      setInvoice(body.invoice);
      if (body.finalized || body.invoice.status === "PAID") {
        setNotice("Payment confirmed.");
        onPaid?.(body.invoice);
      } else if (!options.quiet) {
        setNotice("Payment is not complete yet.");
      }
    } catch {
      if (!options.quiet) {
        setNotice("Unable to check invoice.");
      }
    } finally {
      if (!options.quiet) {
        setBusy(false);
      }
    }
  }

  const qrSvg = invoice ? createTonQrSvg(invoice.deeplink, "dark-on-light") : null;
  const terminal = invoice && !isPayable(invoice.status);

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
              <strong>{invoice.priceLockedUntil ? new Date(invoice.priceLockedUntil).toLocaleString() : "None"}</strong>
            </div>
          </div>

          {qrSvg && isPayable(invoice.status) ? (
            <div className="tonhub-payment-widget__paybox">
              <div
                className="tonhub-payment-widget__qr"
                aria-hidden="true"
                dangerouslySetInnerHTML={{ __html: qrSvg }}
              />
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

          {terminal ? (
            <p className="tonhub-payment-widget__terminal">{statusLabels[invoice.status]}</p>
          ) : null}
        </div>
      ) : null}

      {notice ? (
        <p className="tonhub-payment-widget__notice" role="status">
          {notice}
        </p>
      ) : null}
    </section>
  );
}

