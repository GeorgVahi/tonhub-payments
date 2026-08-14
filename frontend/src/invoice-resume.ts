export type InvoiceResumeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const storagePrefix = "tonhub-payment-widget:resume:";
const invoiceIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{7,159}$/;

function normalizedInvoiceId(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return invoiceIdPattern.test(trimmed) ? trimmed : null;
}

export function invoiceResumeStorageKey(apiBase: string, namespace: string) {
  const normalizedBase = apiBase.trim().replace(/\/+$/, "");
  const normalizedNamespace = namespace.trim();
  if (!normalizedBase) {
    throw new Error("Invoice resume API base must be non-empty.");
  }
  if (!normalizedNamespace) {
    throw new Error("Invoice resume storage namespace must be non-empty.");
  }
  return `${storagePrefix}${encodeURIComponent(normalizedBase)}:${encodeURIComponent(normalizedNamespace)}`;
}

export function invoiceResumeUrl(apiBase: string, invoiceId: string) {
  const normalizedBase = apiBase.trim().replace(/\/+$/, "");
  const normalizedId = normalizedInvoiceId(invoiceId);
  if (!normalizedBase) {
    throw new Error("Invoice resume API base must be non-empty.");
  }
  if (!normalizedId) {
    throw new Error("Invoice resume id is invalid.");
  }
  return `${normalizedBase}/invoices/${encodeURIComponent(normalizedId)}`;
}

type InvoiceResumeFetcher = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export async function requestInvoiceResume<T extends { id: string }>(input: {
  apiBase: string;
  invoiceId: string;
  fetcher?: InvoiceResumeFetcher;
}): Promise<
  | { state: "restored"; invoice: T }
  | { state: "not-found" }
  | { state: "failed" }
> {
  const fetcher = input.fetcher ?? fetch;
  try {
    const response = await fetcher(invoiceResumeUrl(input.apiBase, input.invoiceId));
    if (response.status === 404) return { state: "not-found" };
    const body = await response.json().catch(() => ({})) as { invoice?: unknown };
    if (!response.ok || !body.invoice || typeof body.invoice !== "object") {
      return { state: "failed" };
    }
    const invoice = body.invoice as T;
    if (invoice.id !== input.invoiceId) return { state: "failed" };
    return { state: "restored", invoice };
  } catch {
    return { state: "failed" };
  }
}

export function readInvoiceResumeReference(storage: InvoiceResumeStorage, key: string) {
  try {
    const value = storage.getItem(key);
    if (!value) return null;
    const parsed = JSON.parse(value) as { version?: unknown; invoiceId?: unknown };
    if (parsed.version !== 1) {
      storage.removeItem(key);
      return null;
    }
    const invoiceId = normalizedInvoiceId(parsed.invoiceId);
    if (!invoiceId) {
      storage.removeItem(key);
      return null;
    }
    return invoiceId;
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // Browser storage can be unavailable; recovery remains an optional convenience.
    }
    return null;
  }
}

export function writeInvoiceResumeReference(
  storage: InvoiceResumeStorage,
  key: string,
  invoiceId: string,
) {
  const normalized = normalizedInvoiceId(invoiceId);
  if (!normalized) return false;
  try {
    storage.setItem(key, JSON.stringify({ version: 1, invoiceId: normalized }));
    return true;
  } catch {
    return false;
  }
}

export function clearInvoiceResumeReference(storage: InvoiceResumeStorage, key: string) {
  try {
    storage.removeItem(key);
  } catch {
    // Browser storage can be unavailable; there is nothing else to clear locally.
  }
}

export function validInvoiceResumeId(value: unknown) {
  return normalizedInvoiceId(value);
}
