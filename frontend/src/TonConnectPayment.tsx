import { useEffect, useState } from "react";
import {
  checkRequiredWalletFeatures,
  THEME,
  TonConnectButton,
  TonConnectUIProvider,
  useTonConnectUI,
  useTonWallet,
} from "@tonconnect/ui-react";
import {
  buildTonConnectTransaction,
  type TonConnectTransactionInvoice,
} from "./ton-connect-transaction";

type TonConnectPaymentInvoice = TonConnectTransactionInvoice & {
  amountFormatted: string;
};

function TonConnectPaymentActions({
  invoice,
  onSubmitted,
  onError,
}: {
  invoice: TonConnectPaymentInvoice;
  onSubmitted: () => void;
  onError: () => void;
}) {
  const [tonConnectUi] = useTonConnectUI();
  const wallet = useTonWallet();
  const [sending, setSending] = useState(false);
  const [submittedAmount, setSubmittedAmount] = useState<string | null>(null);
  const awaitingLedger = submittedAmount === invoice.amountAtomic;

  useEffect(() => {
    if (submittedAmount !== null && submittedAmount !== invoice.amountAtomic) {
      setSubmittedAmount(null);
    }
  }, [invoice.amountAtomic, submittedAmount]);

  const walletSupportsPayment = wallet
    ? checkRequiredWalletFeatures(wallet.device.features, {
        sendTransaction: invoice.asset === "USDT"
          ? { minMessages: 1, itemTypes: ["jetton"] }
          : { minMessages: 1 },
      })
    : false;

  async function sendPayment() {
    setSending(true);
    try {
      await tonConnectUi.sendTransaction(buildTonConnectTransaction(invoice));
      setSubmittedAmount(invoice.amountAtomic);
      onSubmitted();
    } catch {
      onError();
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="tonhub-payment-widget__ton-connect">
      <TonConnectButton className="tonhub-payment-widget__ton-connect-button" />
      {wallet && walletSupportsPayment ? (
        <button
          className="tonhub-payment-widget__primary"
          type="button"
          disabled={sending || awaitingLedger}
          onClick={() => void sendPayment()}
        >
          {sending
            ? "Waiting for wallet..."
            : awaitingLedger
              ? "Awaiting ledger confirmation"
              : `Pay ${invoice.amountFormatted}`}
        </button>
      ) : wallet ? (
        <p>This wallet does not advertise the required {invoice.asset} transfer feature. Use the wallet link, QR, or manual details below.</p>
      ) : (
        <p>Connect a wallet to prepare this exact payment without copying details.</p>
      )}
      {awaitingLedger ? (
        <p>Do not send again while this transaction is being confirmed. Check the payment status or your wallet history first.</p>
      ) : null}
    </div>
  );
}

export function TonConnectPayment({
  manifestUrl,
  invoice,
  onSubmitted,
  onError,
}: {
  manifestUrl: string;
  invoice: TonConnectPaymentInvoice;
  onSubmitted: () => void;
  onError: () => void;
}) {
  return (
    <TonConnectUIProvider
      manifestUrl={manifestUrl}
      uiPreferences={{ theme: THEME.DARK, borderRadius: "s" }}
      actionsConfiguration={{ returnStrategy: "back" }}
    >
      <TonConnectPaymentActions
        invoice={invoice}
        onSubmitted={onSubmitted}
        onError={onError}
      />
    </TonConnectUIProvider>
  );
}
