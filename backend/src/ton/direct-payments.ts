import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";

export type TonNetwork = "testnet" | "mainnet";

export type TonReadConfig = {
  network: TonNetwork;
  baseUrl: string;
  address: string;
  addressEnvName: string;
  apiKey?: string;
  apiKeyEnvName?: string;
};

export type TonCenterMessage = {
  destination?: string;
  source?: string;
  value?: string;
  message_content?: {
    decoded?: unknown;
  } | null;
};

export type TonCenterTransaction = {
  hash?: string;
  lt?: string;
  now?: number;
  in_msg?: TonCenterMessage | null;
  description?: {
    aborted?: boolean;
    action?: {
      success?: boolean;
    } | null;
  } | null;
};

export type TonCenterTransactionsResponse = {
  transactions?: TonCenterTransaction[];
};

export type TonInvoiceMatch = {
  transaction: TonCenterTransaction;
  comment: string | null;
  amountNano: string;
  createdAt: string | null;
  status: "observed" | "aborted" | "unknown";
};

const nanoPerTon = BigInt("1000000000");

export const tonNetworkConfig: Record<TonNetwork, {
  baseUrl: string;
  apiKeyEnv: string[];
  addressEnv: string[];
}> = {
  testnet: {
    baseUrl: "https://testnet.toncenter.com/api/v3",
    apiKeyEnv: ["TON_TESTNET_API_KEY", "TON_API_KEY"],
    addressEnv: ["TON_TESTNET_ADDRESS", "TON_ADDRESS"]
  },
  mainnet: {
    baseUrl: "https://toncenter.com/api/v3",
    apiKeyEnv: ["TON_MAINNET_API_KEY", "TON_API_KEY"],
    addressEnv: ["TON_MAINNET_ADDRESS", "TON_ADDRESS"]
  }
};

function envValue(env: NodeJS.ProcessEnv, names: string[]) {
  for (const name of names) {
    const value = env[name]?.trim();

    if (value) {
      return {
        name,
        value
      };
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function extractTextFromRecord(value: Record<string, unknown>): string | null {
  return (
    textValue(value.comment) ||
    textValue(value.text) ||
    textValue(value.value) ||
    (isRecord(value.value) ? extractTextFromRecord(value.value) : null) ||
    (isRecord(value.body) ? extractTextFromRecord(value.body) : null)
  );
}

export function parseTonNetwork(value?: string | null): TonNetwork {
  const normalized = (value || "testnet").trim().toLowerCase();

  if (normalized === "testnet" || normalized === "mainnet") {
    return normalized;
  }

  throw new Error("TON network must be testnet or mainnet.");
}

export function parseTonNetworks(value?: string | null): TonNetwork[] {
  const normalized = (value || "testnet").trim().toLowerCase();

  if (normalized === "all") {
    return ["testnet", "mainnet"];
  }

  return [parseTonNetwork(normalized)];
}

export function resolveTonReadConfig(
  network: TonNetwork,
  env: NodeJS.ProcessEnv = process.env
): TonReadConfig {
  const config = tonNetworkConfig[network];
  const address = envValue(env, config.addressEnv);
  const apiKey = envValue(env, config.apiKeyEnv);

  if (!address) {
    throw new Error(
      `${network}: set one of ${config.addressEnv.map((name) => `\`${name}\``).join(", ")}.`
    );
  }

  return {
    network,
    baseUrl: config.baseUrl,
    address: address.value,
    addressEnvName: address.name,
    apiKey: apiKey?.value,
    apiKeyEnvName: apiKey?.name
  };
}

export function resolveTonApiConfig(
  network: TonNetwork,
  env: NodeJS.ProcessEnv = process.env
): TonReadConfig {
  const config = tonNetworkConfig[network];
  const apiKey = envValue(env, config.apiKeyEnv);

  return {
    network,
    baseUrl: config.baseUrl,
    address: "",
    addressEnvName: "",
    apiKey: apiKey?.value,
    apiKeyEnvName: apiKey?.name
  };
}

export function parseTonAmountToNano(value: string) {
  const trimmed = value.trim();

  if (!/^\d+(\.\d{1,9})?$/.test(trimmed)) {
    throw new Error("TON amount must be a positive decimal with up to 9 fractional digits.");
  }

  const [wholeText, fractionalText = ""] = trimmed.split(".");
  const whole = BigInt(wholeText);
  const fractional = BigInt(fractionalText.padEnd(9, "0"));
  const nano = whole * nanoPerTon + fractional;

  if (nano <= 0) {
    throw new Error("TON amount must be greater than zero.");
  }

  return nano.toString();
}

export function formatNanoTon(value: string | undefined) {
  if (!value) {
    return "0 TON";
  }

  try {
    const nano = BigInt(value);
    const whole = nano / nanoPerTon;
    const fractional = nano % nanoPerTon;
    const fractionalText = fractional.toString().padStart(9, "0").replace(/0+$/, "");

    return `${whole.toString()}${fractionalText ? `.${fractionalText}` : ""} TON`;
  } catch {
    return `${value} nanotons`;
  }
}

function tonTransactionHashForExplorer(value: string) {
  const trimmed = value.trim();

  if (/^[a-f0-9]{64}$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  if (/^\d+$/.test(trimmed)) {
    return null;
  }

  try {
    const decoded = Buffer.from(
      trimmed.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    );

    if (decoded.length === 32) {
      return decoded.toString("hex");
    }
  } catch {
    return null;
  }

  return null;
}

export function tonTransactionExplorerUrl(
  network: TonNetwork | string | null | undefined,
  transactionId: string | null | undefined
) {
  if (!transactionId) {
    return null;
  }

  const transactionHash = tonTransactionHashForExplorer(transactionId);
  if (!transactionHash) {
    return null;
  }

  const baseUrl = network === "testnet"
    ? "https://testnet.tonviewer.com"
    : "https://tonviewer.com";

  return `${baseUrl}/transaction/${transactionHash}`;
}

export function maskValue(value: string) {
  if (value.length <= 12) {
    return "[set]";
  }

  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

export function createTonInvoiceReference(prefix = "AF-TEST") {
  const normalizedPrefix = prefix
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "AF-TEST";

  return `${normalizedPrefix}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

export function buildTonTransferLink(input: {
  address: string;
  amountNano: string;
  comment: string;
}) {
  const url = new URL(`ton://transfer/${input.address}`);
  url.searchParams.set("amount", input.amountNano);
  url.searchParams.set("text", input.comment);

  return url.toString();
}

export function extractTonComment(message: TonCenterMessage | null | undefined) {
  const decoded = isRecord(message?.message_content?.decoded)
    ? message.message_content.decoded
    : null;

  return decoded ? extractTextFromRecord(decoded) : null;
}

export function transactionObservedStatus(
  transaction: TonCenterTransaction
): TonInvoiceMatch["status"] {
  if (transaction.description?.aborted === true) {
    return "aborted";
  }

  if (transaction.description?.aborted === false || transaction.description?.action?.success === true) {
    return "observed";
  }

  return "unknown";
}

export async function fetchTonTransactions(input: {
  config: TonReadConfig;
  limit: number;
  offset?: number;
  startUtime?: number;
  endUtime?: number;
  fetchImpl?: typeof fetch;
}) {
  const fetcher = input.fetchImpl ?? fetch;
  const url = new URL(`${input.config.baseUrl}/transactions`);
  url.searchParams.set("account", input.config.address);
  url.searchParams.set("limit", String(input.limit));
  if (typeof input.offset === "number") {
    url.searchParams.set("offset", String(input.offset));
  }
  if (typeof input.startUtime === "number") {
    url.searchParams.set("start_utime", String(input.startUtime));
  }
  if (typeof input.endUtime === "number") {
    url.searchParams.set("end_utime", String(input.endUtime));
  }
  url.searchParams.set("sort", "desc");

  const response = await fetcher(url, {
    headers: input.config.apiKey
      ? {
          "X-API-Key": input.config.apiKey
        }
      : undefined
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail = body.trim().slice(0, 180);
    throw new Error(
      `TON Center ${input.config.network} request failed: ${response.status}${detail ? ` ${detail}` : ""}`
    );
  }

  return await response.json() as TonCenterTransactionsResponse;
}

export function findTonInvoicePayment(input: {
  transactions: TonCenterTransaction[];
  expectedComment: string;
  expectedAmountNano?: string;
  notBefore?: Date | null;
  notAfter?: Date | null;
}) {
  return findTonInvoicePayments(input)[0] ?? null;
}

export function findTonInvoicePayments(input: {
  transactions: TonCenterTransaction[];
  expectedComment: string;
  expectedAmountNano?: string;
  notBefore?: Date | null;
  notAfter?: Date | null;
}) {
  const expectedComment = input.expectedComment.trim();
  const notBeforeMs = input.notBefore?.getTime() ?? null;
  const notAfterMs = input.notAfter?.getTime() ?? null;
  const matches: TonInvoiceMatch[] = [];

  for (const transaction of input.transactions) {
    const inMessage = transaction.in_msg ?? null;
    const comment = extractTonComment(inMessage);
    const createdAtMs = transaction.now ? transaction.now * 1000 : null;

    if ((notBeforeMs !== null || notAfterMs !== null) && createdAtMs === null) {
      continue;
    }

    if (notBeforeMs !== null && createdAtMs !== null && createdAtMs < notBeforeMs) {
      continue;
    }

    if (notAfterMs !== null && createdAtMs !== null && createdAtMs > notAfterMs) {
      continue;
    }

    if (comment !== expectedComment) {
      continue;
    }

    if (
      input.expectedAmountNano &&
      inMessage?.value !== input.expectedAmountNano
    ) {
      continue;
    }

    matches.push({
      transaction,
      comment,
      amountNano: inMessage?.value ?? "0",
      createdAt: createdAtMs ? new Date(createdAtMs).toISOString() : null,
      status: transactionObservedStatus(transaction)
    } satisfies TonInvoiceMatch);
  }

  return matches;
}
