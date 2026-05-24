import React from "react";
import { createRoot } from "react-dom/client";
import { TonhubPaymentWidget } from "../src";
import "../src/styles.css";

function DemoApp() {
  const defaultNetwork = import.meta.env.VITE_TONHUB_PAYMENTS_DEFAULT_NETWORK === "mainnet"
    ? "mainnet"
    : "testnet";

  return (
    <main style={{ minHeight: "100vh", padding: 24, background: "#f8fafc" }}>
      <TonhubPaymentWidget
        apiBase={import.meta.env.VITE_TONHUB_PAYMENTS_API_BASE || "/api/tonhub-payments"}
        initialNetwork={defaultNetwork}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DemoApp />
  </React.StrictMode>
);
