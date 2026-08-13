import { prisma } from "./db";
import {
  movementLedger,
  type PaymentMovementDraft,
  type PaymentMovementStatus,
} from "./movement-ledger";
import {
  canonicalTonAddress,
  canonicalTonTransactionHash,
  scanGramShadowTransactions,
  type GramShadowRejection,
} from "./ton/gram-shadow-scanner";
import type {
  TonCenterTransaction,
  TonInvoiceMatch,
  TonNetwork,
} from "./ton/direct-payments";
import { assertPaymentAssetSnapshot, parsePaymentAsset } from "../../shared/payment-assets";

type PrismaLike = {
  tonhubPaymentInvoice: any;
  tonhubPaymentMovement: any;
};

type MovementRecorder = {
  recordObserved: (input: PaymentMovementDraft) => Promise<unknown>;
};

const usableMovementStatuses: PaymentMovementStatus[] = [
  "OBSERVED",
  "VALIDATED",
  "CREDITED",
];

export type GramLedgerObservationResult = {
  observed: number;
  rejections: GramShadowRejection[];
};

export type GramLedgerSettlementSource = {
  resolveTarget: (input: {
    invoiceId: string;
    network: TonNetwork;
  }) => Promise<{ address: string; addressRaw: string; depositAddressId: string }>;
  observeTransactions: (input: {
    invoiceId: string;
    network: TonNetwork;
    notBefore: Date;
    notAfter: Date;
    transactions: TonCenterTransaction[];
  }) => Promise<GramLedgerObservationResult>;
  listMatches: (input: {
    invoiceId: string;
    network: TonNetwork;
    notBefore: Date;
    notAfter: Date;
  }) => Promise<TonInvoiceMatch[]>;
};

function validDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeMovementMatch(value: any, ownership: {
  depositAddressId: string;
  network: TonNetwork;
  addressRaw: string;
  notBefore: Date;
  notAfter: Date;
}): TonInvoiceMatch {
  const transactionHash = canonicalTonTransactionHash(value.transactionHash);
  const transactionLt = typeof value.transactionLt === "string" && /^\d+$/.test(value.transactionLt)
    ? BigInt(value.transactionLt).toString()
    : null;
  const fromAddress = canonicalTonAddress(value.fromAddress);
  const toAddress = canonicalTonAddress(value.toAddress);
  if (
    !transactionHash ||
    !transactionLt ||
    typeof value.amountAtomic !== "string" ||
    !/^[1-9]\d*$/.test(value.amountAtomic) ||
    !validDate(value.blockchainAt) ||
    !fromAddress ||
    !toAddress ||
    value.depositAddressId !== ownership.depositAddressId ||
    value.network !== ownership.network ||
    value.direction !== "INCOMING" ||
    value.asset !== "GRAM" ||
    value.assetKind !== "NATIVE" ||
    value.assetDecimals !== 9 ||
    !usableMovementStatuses.includes(value.status) ||
    toAddress !== ownership.addressRaw ||
    value.blockchainAt.getTime() < ownership.notBefore.getTime() ||
    value.blockchainAt.getTime() > ownership.notAfter.getTime() ||
    value.fingerprint !== `ton:${ownership.network}:native-in:${transactionHash}:0`
  ) {
    throw new Error("Stored GRAM movement is malformed.");
  }

  const rawPayload = value.rawPayload;
  const evidence = isRecord(rawPayload) && isRecord(rawPayload.transaction)
    ? rawPayload.transaction
    : null;
  if (
    !evidence ||
    rawPayload.evidenceVersion !== 1 ||
    rawPayload.provider !== "toncenter-v3" ||
    canonicalTonTransactionHash(evidence.hash) !== transactionHash ||
    (typeof evidence.lt !== "string" || !/^\d+$/.test(evidence.lt) || BigInt(evidence.lt).toString() !== transactionLt) ||
    evidence.now !== Math.floor(value.blockchainAt.getTime() / 1000) ||
    evidence.successful !== true ||
    canonicalTonAddress(evidence.source) !== fromAddress ||
    canonicalTonAddress(evidence.destination) !== ownership.addressRaw ||
    evidence.value !== value.amountAtomic
  ) {
    throw new Error("Stored GRAM movement has inconsistent immutable evidence.");
  }

  return {
    transaction: {
      hash: transactionHash,
      lt: transactionLt,
      now: Math.floor(value.blockchainAt.getTime() / 1000),
      description: { aborted: false, action: { success: true } },
      in_msg: {
        source: fromAddress,
        destination: toAddress,
        value: value.amountAtomic,
      },
    },
    comment: null,
    amountNano: BigInt(value.amountAtomic).toString(),
    createdAt: value.blockchainAt.toISOString(),
    status: "observed",
  };
}

async function requireOwnedDeposit(
  db: PrismaLike,
  input: { invoiceId: string; network: TonNetwork },
) {
  const invoice = await db.tonhubPaymentInvoice.findUnique({
    where: { id: input.invoiceId },
    include: { depositAddress: true },
  });
  const deposit = invoice?.depositAddress;
  if (!invoice || !deposit) {
    throw new Error(`GRAM ledger invoice ${input.invoiceId} has no owned deposit address.`);
  }
  if (invoice.network !== input.network || deposit.network !== input.network) {
    throw new Error(`GRAM ledger invoice ${input.invoiceId} has inconsistent network ownership.`);
  }
  try {
    assertPaymentAssetSnapshot(parsePaymentAsset(invoice.checkoutAsset ?? invoice.asset), {
      kind: invoice.assetKind,
      decimals: invoice.assetDecimals,
    });
  } catch {
    throw new Error(`GRAM ledger invoice ${input.invoiceId} has inconsistent settlement identity.`);
  }
  if (invoice.addressStrategy !== "unique-address") {
    throw new Error(`GRAM ledger invoice ${input.invoiceId} has inconsistent settlement identity.`);
  }
  return { invoice, deposit };
}

function assertOwnedAddress(invoice: any, deposit: any) {
  const addresses = [
    invoice.address,
    invoice.addressRaw,
    deposit.address,
    deposit.addressRaw,
  ].map(canonicalTonAddress);
  if (!addresses[0] || addresses.some((address) => address !== addresses[0])) {
    throw new Error(`GRAM ledger invoice ${invoice.id} has inconsistent address ownership.`);
  }
  return addresses[0];
}

export function createPrismaGramLedgerSettlementSource(
  db: PrismaLike,
  recorder: MovementRecorder,
): GramLedgerSettlementSource {
  return {
    resolveTarget: async (input) => {
      const { invoice, deposit } = await requireOwnedDeposit(db, input);
      assertOwnedAddress(invoice, deposit);
      return {
        address: deposit.address,
        addressRaw: deposit.addressRaw,
        depositAddressId: deposit.id,
      };
    },

    observeTransactions: async (input) => {
      const { invoice, deposit } = await requireOwnedDeposit(db, input);
      assertOwnedAddress(invoice, deposit);
      const scanned = scanGramShadowTransactions({
        network: input.network,
        depositAddressId: deposit.id,
        address: deposit.address,
        addressRaw: deposit.addressRaw,
        notBefore: input.notBefore,
        notAfter: input.notAfter,
        transactions: input.transactions,
      });
      const identities = new Map<string, string>();
      let observed = 0;
      for (const movement of scanned.movements) {
        const identity = JSON.stringify(movement);
        const existing = identities.get(movement.fingerprint);
        if (existing === identity) {
          continue;
        }
        if (existing !== undefined) {
          throw new Error(`GRAM ledger fingerprint ${movement.fingerprint} has conflicting evidence.`);
        }
        identities.set(movement.fingerprint, identity);
        await recorder.recordObserved(movement);
        observed += 1;
      }
      return { observed, rejections: scanned.rejections };
    },

    listMatches: async (input) => {
      const { invoice, deposit } = await requireOwnedDeposit(db, input);
      const addressRaw = assertOwnedAddress(invoice, deposit);
      const movements = await db.tonhubPaymentMovement.findMany({
        where: {
          depositAddressId: deposit.id,
          network: input.network,
          direction: "INCOMING",
          asset: "GRAM",
          assetKind: "NATIVE",
          assetDecimals: 9,
          status: { in: usableMovementStatuses },
          blockchainAt: { gte: input.notBefore, lte: input.notAfter },
        },
        orderBy: [{ blockchainAt: "asc" }, { transactionLt: "asc" }, { id: "asc" }],
      });
      return movements.map((movement: any) => normalizeMovementMatch(movement, {
        depositAddressId: deposit.id,
        network: input.network,
        addressRaw,
        notBefore: input.notBefore,
        notAfter: input.notAfter,
      }));
    },
  };
}

export const prismaGramLedgerSettlementSource = createPrismaGramLedgerSettlementSource(
  prisma as unknown as PrismaLike,
  movementLedger,
);

export type GramSettlementMode = "legacy" | "compare" | "ledger";

export function parseGramSettlementMode(value?: string | null): GramSettlementMode {
  const normalized = (value ?? "ledger").trim().toLowerCase();
  if (normalized === "legacy" || normalized === "compare" || normalized === "ledger") {
    return normalized;
  }
  throw new Error("TON_GRAM_SETTLEMENT_MODE must be legacy, compare, or ledger.");
}

export type GramSettlementComparison = {
  invoiceId: string;
  legacyCount: number;
  ledgerCount: number;
  legacyAmountAtomic: string;
  ledgerAmountAtomic: string;
  onlyLegacy: string[];
  onlyLedger: string[];
  conflicting: string[];
  equivalent: boolean;
  observationError?: string;
};

function matchFacts(match: TonInvoiceMatch) {
  return `${BigInt(match.amountNano).toString()}:${match.createdAt ?? "missing-time"}`;
}

function matchId(match: TonInvoiceMatch) {
  return canonicalTonTransactionHash(match.transaction.hash) || match.transaction.hash || match.transaction.lt || "missing-id";
}

function indexMatches(matches: TonInvoiceMatch[]) {
  const indexed = new Map<string, { facts: string; amountAtomic: string }>();
  const conflicting = new Set<string>();
  for (const match of matches) {
    const id = matchId(match);
    const facts = matchFacts(match);
    const existing = indexed.get(id);
    if (existing && existing.facts !== facts) {
      conflicting.add(id);
    } else if (!existing) {
      indexed.set(id, { facts, amountAtomic: BigInt(match.amountNano).toString() });
    }
  }
  return { indexed, conflicting };
}

function sumIndexedMatches(matches: Map<string, { amountAtomic: string }>) {
  return [...matches.values()]
    .reduce((sum, match) => sum + BigInt(match.amountAtomic), BigInt(0))
    .toString();
}

export function compareGramSettlementMatches(input: {
  invoiceId: string;
  legacy: TonInvoiceMatch[];
  ledger: TonInvoiceMatch[];
  observationError?: string;
}): GramSettlementComparison {
  const legacy = indexMatches(input.legacy);
  const ledger = indexMatches(input.ledger);
  const onlyLegacy = [...legacy.indexed.keys()].filter((id) => !ledger.indexed.has(id)).sort();
  const onlyLedger = [...ledger.indexed.keys()].filter((id) => !legacy.indexed.has(id)).sort();
  const conflicting = [...new Set([
    ...legacy.conflicting,
    ...ledger.conflicting,
    ...[...legacy.indexed.keys()].filter(
      (id) => ledger.indexed.has(id) && ledger.indexed.get(id)?.facts !== legacy.indexed.get(id)?.facts,
    ),
  ])].sort();
  return {
    invoiceId: input.invoiceId,
    legacyCount: legacy.indexed.size,
    ledgerCount: ledger.indexed.size,
    legacyAmountAtomic: sumIndexedMatches(legacy.indexed),
    ledgerAmountAtomic: sumIndexedMatches(ledger.indexed),
    onlyLegacy,
    onlyLedger,
    conflicting,
    equivalent: !input.observationError && !onlyLegacy.length && !onlyLedger.length && !conflicting.length,
    ...(input.observationError ? { observationError: input.observationError } : {}),
  };
}
