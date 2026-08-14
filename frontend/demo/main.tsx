import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { TonhubPaymentWidget } from "../src";
import "./demo.css";
import "../src/styles.css";

const demoExternalIdKey = "tonhub-payments-demo:external-id";
const demoResumeStorageKey = "tonhub-payments-demo:active-invoice";

function createDemoExternalId() {
  return `demo-${crypto.randomUUID()}`;
}

function initialDemoExternalId() {
  try {
    const stored = window.localStorage.getItem(demoExternalIdKey);
    if (stored?.startsWith("demo-") && stored.length <= 120) return stored;
    const created = createDemoExternalId();
    window.localStorage.setItem(demoExternalIdKey, created);
    return created;
  } catch {
    return createDemoExternalId();
  }
}

function DemoApp() {
  const [externalId, setExternalId] = useState(initialDemoExternalId);
  const [initialInvoiceId] = useState(() => new URLSearchParams(window.location.search).get("invoice") ?? undefined);
  const defaultNetwork = import.meta.env.VITE_TONHUB_PAYMENTS_DEFAULT_NETWORK === "mainnet"
    ? "mainnet"
    : "testnet";

  function handleInvoiceChange(invoice: { id: string } | null) {
    if (invoice) {
      const url = new URL(window.location.href);
      if (url.searchParams.has("invoice")) {
        url.searchParams.delete("invoice");
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      }
      return;
    }

    const nextExternalId = createDemoExternalId();
    try {
      window.localStorage.setItem(demoExternalIdKey, nextExternalId);
    } catch {
      // The demo remains usable when browser storage is unavailable.
    }
    setExternalId(nextExternalId);
  }

  return (
    <main className="tonhub-payment-demo">
      <TonhubPaymentWidget
        apiBase={import.meta.env.VITE_TONHUB_PAYMENTS_API_BASE || "/api/tonhub-payments"}
        externalId={externalId}
        initialInvoiceId={initialInvoiceId}
        initialNetwork={defaultNetwork}
        resumeStorageKey={demoResumeStorageKey}
        tonConnectManifestUrl={import.meta.env.VITE_TONCONNECT_MANIFEST_URL}
        onInvoiceChange={handleInvoiceChange}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DemoApp />
  </React.StrictMode>
);
