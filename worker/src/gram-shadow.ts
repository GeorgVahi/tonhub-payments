import { randomUUID } from "node:crypto";
import { prisma } from "../../backend/src/db";
import { movementLedger, type PaymentMovementDraft } from "../../backend/src/movement-ledger";
import {
  fetchTonTransactions,
  resolveTonApiConfig,
  type TonCenterTransaction,
  type TonNetwork,
  type TonReadConfig,
} from "../../backend/src/ton/direct-payments";
import {
  canonicalTonAddress,
  scanGramShadowTransactions,
  tonTransactionCursor,
  type GramShadowRejection,
} from "../../backend/src/ton/gram-shadow-scanner";

const streamType = "GRAM_NATIVE_IN";
const activeStatuses = ["PENDING", "PARTIAL"];
const terminalStatuses = ["PAID", "EXPIRED", "CANCELLED", "FAILED"];

type PrismaLike = {
  $transaction: <T>(handler: (tx: PrismaLike) => Promise<T>) => Promise<T>;
  tonhubPaymentInvoice: any;
  tonhubScanCursor: any;
};

export type GramShadowScanTarget = {
  invoiceId: string;
  depositAddressId: string;
  network: TonNetwork;
  depositNetwork: string;
  address: string;
  addressRaw: string;
  invoiceAddress: string;
  invoiceAddressRaw: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  terminalMonitorUntil: Date | null;
  cursor: {
    hash: string | null;
    lt: string | null;
    timestamp: Date | null;
  };
  leaseOwner: string;
};

export type GramShadowScannerRepository = {
  claimDueTargets: (input: {
    network: TonNetwork;
    workerId: string;
    now: Date;
    limit: number;
    leaseMs: number;
    terminalMonitorMs: number;
  }) => Promise<GramShadowScanTarget[]>;
  renewLease: (input: {
    target: GramShadowScanTarget;
    now: Date;
    leaseMs: number;
  }) => Promise<boolean>;
  completeScan: (input: {
    target: GramShadowScanTarget;
    scannedAt: Date;
    nextScanAt: Date | null;
    terminalMonitorUntil: Date | null;
    cursor: { hash: string; lt: string; timestamp: Date } | null;
  }) => Promise<boolean>;
  failScan: (input: {
    target: GramShadowScanTarget;
    retryAt: Date;
  }) => Promise<boolean>;
};

type GramShadowLedger = {
  recordObserved: (input: PaymentMovementDraft) => Promise<unknown>;
};

export type GramShadowScanOutcome = {
  invoiceId: string;
  status: "scanned" | "failed";
  transactionsScanned: number;
  movementsObserved: number;
  rejections: GramShadowRejection[];
  error?: string;
};

function validDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function addMs(date: Date, ms: number) {
  return new Date(date.getTime() + ms);
}

function normalizeTarget(invoice: any, cursor: any, workerId: string): GramShadowScanTarget {
  const deposit = invoice.depositAddress;
  if (
    !deposit ||
    typeof invoice.id !== "string" ||
    typeof deposit.id !== "string" ||
    typeof invoice.address !== "string" ||
    typeof invoice.addressRaw !== "string" ||
    typeof deposit.address !== "string" ||
    typeof deposit.addressRaw !== "string" ||
    typeof deposit.network !== "string" ||
    !validDate(invoice.createdAt) ||
    !validDate(invoice.updatedAt)
  ) {
    throw new Error("GRAM shadow scan target is malformed.");
  }
  const network = invoice.network;
  if (network !== "testnet" && network !== "mainnet") {
    throw new Error(`GRAM shadow target ${invoice.id} has invalid network.`);
  }
  return {
    invoiceId: invoice.id,
    depositAddressId: deposit.id,
    network,
    depositNetwork: deposit.network,
    address: deposit.address,
    addressRaw: deposit.addressRaw,
    invoiceAddress: invoice.address,
    invoiceAddressRaw: invoice.addressRaw,
    status: invoice.status,
    createdAt: invoice.createdAt,
    updatedAt: invoice.updatedAt,
    terminalMonitorUntil: validDate(invoice.terminalMonitorUntil)
      ? invoice.terminalMonitorUntil
      : null,
    cursor: {
      hash: typeof cursor.lastHash === "string" ? cursor.lastHash : null,
      lt: typeof cursor.lastLt === "string" ? cursor.lastLt : null,
      timestamp: validDate(cursor.lastTimestamp) ? cursor.lastTimestamp : null,
    },
    leaseOwner: workerId,
  };
}

export function createPrismaGramShadowScannerRepository(
  db: PrismaLike,
): GramShadowScannerRepository {
  return {
    claimDueTargets: async (input) => {
      const terminalCutoff = new Date(input.now.getTime() - input.terminalMonitorMs);
      const candidates = await db.tonhubPaymentInvoice.findMany({
        where: {
          network: input.network,
          addressStrategy: "unique-address",
          depositAddress: { isNot: null },
          OR: [
            {
              status: { in: activeStatuses },
              OR: [
                { scanPriorityAt: null },
                { scanPriorityAt: { lte: input.now } },
              ],
            },
            {
              status: { in: terminalStatuses },
              OR: [
                { terminalMonitorUntil: { gt: input.now } },
                {
                  terminalMonitorUntil: null,
                  updatedAt: { gte: terminalCutoff },
                },
              ],
              AND: [{
                OR: [
                  { scanPriorityAt: null },
                  { scanPriorityAt: { lte: input.now } },
                ],
              }],
            },
          ],
        },
        include: { depositAddress: true },
        orderBy: [{ scanPriorityAt: "asc" }, { createdAt: "asc" }],
        take: Math.max(input.limit * 4, input.limit),
      });

      const claimed: GramShadowScanTarget[] = [];
      for (const invoice of candidates) {
        if (claimed.length >= input.limit) {
          break;
        }
        const depositAddressId = invoice.depositAddress?.id;
        if (typeof depositAddressId !== "string") {
          continue;
        }
        let scanInvoice = invoice;
        if (
          terminalStatuses.includes(invoice.status) &&
          !validDate(invoice.terminalMonitorUntil)
        ) {
          const terminalMonitorUntil = addMs(invoice.updatedAt, input.terminalMonitorMs);
          await db.tonhubPaymentInvoice.updateMany({
            where: { id: invoice.id, terminalMonitorUntil: null },
            data: {
              terminalMonitorUntil,
              updatedAt: invoice.updatedAt,
            },
          });
          scanInvoice = { ...invoice, terminalMonitorUntil };
        }
        await db.tonhubScanCursor.createMany({
          data: {
            network: input.network,
            streamType,
            scopeKey: depositAddressId,
          },
          skipDuplicates: true,
        });
        const cursor = await db.tonhubScanCursor.findUnique({
          where: {
            network_streamType_scopeKey: {
              network: input.network,
              streamType,
              scopeKey: depositAddressId,
            },
          },
        });
        if (!cursor) {
          throw new Error("GRAM scan cursor was not created.");
        }
        const lease = await db.tonhubScanCursor.updateMany({
          where: {
            id: cursor.id,
            OR: [
              { leaseOwner: input.workerId },
              { leaseOwner: null },
              { leaseExpiresAt: { lte: input.now } },
            ],
          },
          data: {
            leaseOwner: input.workerId,
            leaseExpiresAt: addMs(input.now, input.leaseMs),
          },
        });
        if (lease.count !== 1) {
          continue;
        }
        const currentCursor = await db.tonhubScanCursor.findUnique({ where: { id: cursor.id } });
        claimed.push(normalizeTarget(scanInvoice, currentCursor, input.workerId));
      }
      return claimed;
    },

    renewLease: async (input) => {
      const result = await db.tonhubScanCursor.updateMany({
        where: {
          network: input.target.network,
          streamType,
          scopeKey: input.target.depositAddressId,
          leaseOwner: input.target.leaseOwner,
        },
        data: { leaseExpiresAt: addMs(input.now, input.leaseMs) },
      });
      return result.count === 1;
    },

    completeScan: (input) => db.$transaction(async (tx) => {
      const cursorData: Record<string, unknown> = {
        leaseOwner: null,
        leaseExpiresAt: null,
      };
      if (input.cursor) {
        cursorData.lastHash = input.cursor.hash;
        cursorData.lastLt = input.cursor.lt;
        cursorData.lastTimestamp = input.cursor.timestamp;
      }
      const released = await tx.tonhubScanCursor.updateMany({
        where: {
          network: input.target.network,
          streamType,
          scopeKey: input.target.depositAddressId,
          leaseOwner: input.target.leaseOwner,
        },
        data: cursorData,
      });
      if (released.count !== 1) {
        return false;
      }
      const updated = await tx.tonhubPaymentInvoice.updateMany({
        where: {
          id: input.target.invoiceId,
          status: input.target.status,
          updatedAt: input.target.updatedAt,
        },
        data: {
          lastScannedAt: input.scannedAt,
          scanPriorityAt: input.nextScanAt,
          terminalMonitorUntil: input.terminalMonitorUntil,
        },
      });
      if (updated.count === 1) {
        return true;
      }
      return Boolean(await tx.tonhubPaymentInvoice.findUnique({
        where: { id: input.target.invoiceId },
        select: { id: true },
      }));
    }),

    failScan: (input) => db.$transaction(async (tx) => {
      const released = await tx.tonhubScanCursor.updateMany({
        where: {
          network: input.target.network,
          streamType,
          scopeKey: input.target.depositAddressId,
          leaseOwner: input.target.leaseOwner,
        },
        data: { leaseOwner: null, leaseExpiresAt: null },
      });
      if (released.count !== 1) {
        return false;
      }
      await tx.tonhubPaymentInvoice.updateMany({
        where: {
          id: input.target.invoiceId,
          status: input.target.status,
          updatedAt: input.target.updatedAt,
        },
        data: { scanPriorityAt: input.retryAt },
      });
      return true;
    }),
  };
}

function selectTransactionsBeforeCursor(
  transactions: TonCenterTransaction[],
  cursor: GramShadowScanTarget["cursor"],
) {
  const selected: TonCenterTransaction[] = [];
  let reachedCursor = false;
  for (const transaction of transactions) {
    const candidate = tonTransactionCursor(transaction);
    if (
      candidate &&
      cursor.hash &&
      candidate.hash === cursor.hash
    ) {
      reachedCursor = true;
      break;
    }
    if (
      candidate &&
      cursor.timestamp &&
      candidate.timestamp.getTime() < cursor.timestamp.getTime()
    ) {
      reachedCursor = true;
      break;
    }
    selected.push(transaction);
  }
  return { selected, reachedCursor };
}

async function scanTarget(input: {
  target: GramShadowScanTarget;
  repository: GramShadowScannerRepository;
  ledger: GramShadowLedger;
  now: Date;
  pageSize: number;
  maxPages: number;
  leaseMs: number;
  clock: () => Date;
  fetchTransactions: (input: {
    config: TonReadConfig;
    limit: number;
    offset: number;
    startUtime: number;
    endUtime: number;
  }) => Promise<{ transactions?: TonCenterTransaction[] }>;
  resolveConfig: (network: TonNetwork) => TonReadConfig;
}) {
  if (input.target.depositNetwork !== input.target.network) {
    throw new Error("GRAM shadow invoice and deposit network evidence is inconsistent.");
  }
  const storedAddresses = [
    input.target.address,
    input.target.addressRaw,
    input.target.invoiceAddress,
    input.target.invoiceAddressRaw,
  ].map(canonicalTonAddress);
  if (!storedAddresses[0] || storedAddresses.some((address) => address !== storedAddresses[0])) {
    throw new Error("GRAM shadow invoice and deposit address evidence is invalid or inconsistent.");
  }
  const transactions: TonCenterTransaction[] = [];
  let newestCursor: ReturnType<typeof tonTransactionCursor> = null;
  let offset = 0;
  let completedHistory = false;

  for (let page = 0; page < input.maxPages; page += 1) {
    if (!await input.repository.renewLease({
      target: input.target,
      now: input.clock(),
      leaseMs: input.leaseMs,
    })) {
      throw new Error("GRAM shadow scan lease was lost.");
    }
    const response = await input.fetchTransactions({
      config: {
        ...input.resolveConfig(input.target.network),
        address: input.target.address,
      },
      limit: input.pageSize,
      offset,
      startUtime: Math.floor(input.target.createdAt.getTime() / 1000),
      endUtime: Math.floor(input.now.getTime() / 1000) + 60,
    });
    const pageTransactions = response.transactions ?? [];
    if (!newestCursor) {
      newestCursor = pageTransactions
        .map(tonTransactionCursor)
        .find((cursor) => Boolean(
          cursor &&
          cursor.timestamp.getTime() >= input.target.createdAt.getTime() &&
          cursor.timestamp.getTime() <= input.now.getTime()
        )) ?? null;
    }
    const selected = selectTransactionsBeforeCursor(pageTransactions, input.target.cursor);
    transactions.push(...selected.selected);
    if (selected.reachedCursor || pageTransactions.length < input.pageSize) {
      completedHistory = true;
      break;
    }
    offset += pageTransactions.length;
  }

  if (!completedHistory) {
    throw new Error(`GRAM shadow scan exceeded ${input.maxPages} pages before reaching its cursor.`);
  }

  const result = scanGramShadowTransactions({
    network: input.target.network,
    depositAddressId: input.target.depositAddressId,
    address: input.target.address,
    addressRaw: input.target.addressRaw,
    notBefore: input.target.createdAt,
    notAfter: input.now,
    transactions,
  });
  const observedIdentities = new Map<string, string>();
  let movementsObserved = 0;
  for (const movement of result.movements) {
    const identity = JSON.stringify(movement);
    const existing = observedIdentities.get(movement.fingerprint);
    if (existing === identity) {
      continue;
    }
    if (existing !== undefined) {
      throw new Error(`GRAM shadow fingerprint ${movement.fingerprint} has conflicting page evidence.`);
    }
    observedIdentities.set(movement.fingerprint, identity);
    await input.ledger.recordObserved(movement);
    movementsObserved += 1;
  }
  return {
    transactionsScanned: transactions.length,
    movementsObserved,
    rejections: result.rejections,
    newestCursor,
  };
}

export async function runGramShadowScanBatch(input: {
  network: TonNetwork;
  workerId?: string;
  limit?: number;
  pageSize?: number;
  maxPages?: number;
  activeIntervalMs?: number;
  terminalIntervalMs?: number;
  terminalMonitorMs?: number;
  retryMs?: number;
  leaseMs?: number;
  now?: Date;
  clock?: () => Date;
  repository?: GramShadowScannerRepository;
  ledger?: GramShadowLedger;
  fetchTransactions?: Parameters<typeof scanTarget>[0]["fetchTransactions"];
  resolveConfig?: (network: TonNetwork) => TonReadConfig;
}) {
  const now = input.now ?? new Date();
  if (!validDate(now)) {
    throw new Error("GRAM shadow batch now must be a valid date.");
  }
  const workerId = input.workerId ?? `gram-shadow-${process.pid}-${randomUUID()}`;
  const limit = input.limit ?? 20;
  const pageSize = input.pageSize ?? 100;
  const maxPages = input.maxPages ?? 100;
  const activeIntervalMs = input.activeIntervalMs ?? 15_000;
  const terminalIntervalMs = input.terminalIntervalMs ?? 24 * 60 * 60 * 1000;
  const terminalMonitorMs = input.terminalMonitorMs ?? 30 * 24 * 60 * 60 * 1000;
  const retryMs = input.retryMs ?? 60_000;
  const leaseMs = input.leaseMs ?? 60_000;
  const positiveIntegers = {
    limit,
    pageSize,
    maxPages,
    activeIntervalMs,
    terminalIntervalMs,
    terminalMonitorMs,
    retryMs,
    leaseMs,
  };
  for (const [name, value] of Object.entries(positiveIntegers)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`GRAM shadow ${name} must be a positive safe integer.`);
    }
  }
  if (pageSize > 1_000) {
    throw new Error("GRAM shadow pageSize cannot exceed 1000.");
  }
  const clock = input.clock ?? (() => new Date());
  const repository = input.repository ?? createPrismaGramShadowScannerRepository(prisma as unknown as PrismaLike);
  const ledger = input.ledger ?? movementLedger;
  const fetchTransactions = input.fetchTransactions ?? ((request) => fetchTonTransactions(request));
  const resolveConfig = input.resolveConfig ?? resolveTonApiConfig;
  const targets = await repository.claimDueTargets({
    network: input.network,
    workerId,
    now,
    limit,
    leaseMs,
    terminalMonitorMs,
  });
  const outcomes: GramShadowScanOutcome[] = [];

  for (const target of targets) {
    try {
      const result = await scanTarget({
        target,
        repository,
        ledger,
        now,
        pageSize,
        maxPages,
        leaseMs,
        clock,
        fetchTransactions,
        resolveConfig,
      });
      const terminal = terminalStatuses.includes(target.status);
      const terminalMonitorUntil = terminal
        ? target.terminalMonitorUntil ?? addMs(target.updatedAt, terminalMonitorMs)
        : null;
      const proposedNextScan = addMs(now, terminal ? terminalIntervalMs : activeIntervalMs);
      const nextScanAt = terminal && terminalMonitorUntil
        ? now.getTime() >= terminalMonitorUntil.getTime()
          ? null
          : proposedNextScan.getTime() >= terminalMonitorUntil.getTime()
            ? new Date(terminalMonitorUntil.getTime() - 1)
            : proposedNextScan
        : proposedNextScan;
      if (!await repository.completeScan({
        target,
        scannedAt: now,
        nextScanAt,
        terminalMonitorUntil,
        cursor: result.newestCursor,
      })) {
        throw new Error("GRAM shadow scan completion lease was lost.");
      }
      outcomes.push({
        invoiceId: target.invoiceId,
        status: "scanned",
        transactionsScanned: result.transactionsScanned,
        movementsObserved: result.movementsObserved,
        rejections: result.rejections,
      });
    } catch (error) {
      await repository.failScan({ target, retryAt: addMs(now, retryMs) });
      outcomes.push({
        invoiceId: target.invoiceId,
        status: "failed",
        transactionsScanned: 0,
        movementsObserved: 0,
        rejections: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    candidates: targets.length,
    scanned: outcomes.filter(({ status }) => status === "scanned").length,
    failed: outcomes.filter(({ status }) => status === "failed").length,
    transactionsScanned: outcomes.reduce((sum, outcome) => sum + outcome.transactionsScanned, 0),
    movementsObserved: outcomes.reduce((sum, outcome) => sum + outcome.movementsObserved, 0),
    rejected: outcomes.reduce((sum, outcome) => sum + outcome.rejections.length, 0),
    outcomes,
  };
}
