import { useState } from "react";

type ManualTransferKey = "address" | "amount";

type TonManualTransferFieldsProps = {
  address: string;
  amount: string;
  addressLabel: string;
  amountLabel: string;
  copyLabel: string;
  copiedLabel: string;
  amountCopyValue?: string;
};

function CopyIcon() {
  return (
    <svg
      aria-hidden="true"
      className="ton-manual-transfer__copy-icon"
      fill="none"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M5 15V7a2 2 0 0 1 2-2h8" />
    </svg>
  );
}

async function copyWithFallback(value: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall through to the textarea path for browsers that expose but block
      // Clipboard API writes outside a secure context.
    }
  }

  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "true");
  field.style.position = "fixed";
  field.style.left = "-9999px";
  document.body.appendChild(field);
  field.select();

  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(field);
  }

  return Promise.resolve();
}

export function copyableTonAmount(value: string) {
  return value.replace(/\s*TON$/i, "").trim();
}

export function TonManualTransferFields({
  address,
  amount,
  addressLabel,
  amountLabel,
  copyLabel,
  copiedLabel,
  amountCopyValue
}: TonManualTransferFieldsProps) {
  const [copiedKey, setCopiedKey] = useState<ManualTransferKey | null>(null);
  const items = [
    {
      key: "address" as const,
      label: addressLabel,
      value: address,
      copyValue: address
    },
    {
      key: "amount" as const,
      label: amountLabel,
      value: amount,
      copyValue: amountCopyValue || amount
    }
  ];

  async function copyValue(key: ManualTransferKey, value: string) {
    await copyWithFallback(value);
    setCopiedKey(key);
  }

  return (
    <div className="ton-manual-transfer" data-ton-manual-transfer-fields>
      {items.map((item) => (
        <div className="ton-manual-transfer__row" key={item.key}>
          <div className="ton-manual-transfer__content">
            <span>{item.label}</span>
            <code>{item.value}</code>
          </div>
          <button
            className="ton-manual-transfer__copy"
            type="button"
            aria-label={`${copyLabel}: ${item.label}`}
            title={`${copyLabel}: ${item.label}`}
            onClick={() => void copyValue(item.key, item.copyValue)}
          >
            <CopyIcon />
          </button>
          {copiedKey === item.key ? (
            <span className="ton-manual-transfer__status" role="status">
              {copiedLabel}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
