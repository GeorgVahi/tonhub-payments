import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../backend/src/db";
import type { PaymentMovementObservationLease } from "../../backend/src/movement-ledger";
import { canonicalTonAddress } from "../../backend/src/ton/gram-shadow-scanner";

const streamType = "USDT_MAINNET_IN";
const activeStatuses = ["PENDING", "PARTIAL"];
const terminalStatuses = ["PAID", "EXPIRED", "CANCELLED", "FAILED"];

type PrismaLike = {
  $transaction: <T>(handler: (tx: PrismaLike) => Promise<T>) => Promise<T>;
  $queryRaw: <T>(query: Prisma.Sql) => Promise<T>;
  $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => Promise<T>;
  tonhubDepositAddress: any;
  tonhubScanCursor: any;
};

export type MainnetUsdtScanTarget = {
  invoiceId: string;
  depositAddressId: string;
  network: "mainnet";
  invoiceNetwork: string;
  depositNetwork: string;
  address: string;
  addressRaw: string;
  invoiceAddress: string;
  invoiceAddressRaw: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  terminalMonitorUntil: Date | null;
  cursorTimestamp: Date | null;
  leaseOwner: string;
};

export type MainnetUsdtScannerRepository = {
  claimDueTargets: (input: {
    workerId: string;
    now: Date;
    limit: number;
    leaseMs: number;
    activeIntervalMs: number;
    terminalIntervalMs: number;
    terminalMonitorMs: number;
    candidatePoolSize: number;
  }) => Promise<MainnetUsdtScanTarget[]>;
  renewLease: (input: {
    target: MainnetUsdtScanTarget;
    now: Date;
    leaseMs: number;
  }) => Promise<boolean>;
  completeScan: (input: {
    target: MainnetUsdtScanTarget;
    scannedThroughAt: Date;
    completedAt: Date;
    nextScanAt: Date;
  }) => Promise<boolean>;
  failScan: (input: {
    target: MainnetUsdtScanTarget;
    retryAt: Date;
  }) => Promise<boolean>;
};

export type MainnetUsdtObserver = {
  observeDeposit: (input: {
    depositAddressId: string;
    notBefore: Date;
    notAfter: Date;
    limit: number;
    offset: number;
    observationLease?: PaymentMovementObservationLease;
  }) => Promise<{
    transfersScanned: number;
    discoveryTransfersScanned: number;
    notificationTransactionsScanned: number;
    movementsObserved: number;
    rejectionsRecorded: number;
    nextOffset: number;
  }>;
};

export function scheduleMainnetUsdtDueIds(
  activeIds: string[],
  terminalIds: string[],
  limit: number,
) {
  if (!Number.isSafeInteger(limit) || limit < 2) {
    throw new Error("Mainnet USDT scanner limit must be at least 2 for terminal fairness.");
  }
  const activeQuota = terminalIds.length
    ? Math.min(limit - 1, Math.max(1, Math.ceil(limit * 0.75)))
    : limit;
  const terminalQuota = activeIds.length ? limit - activeQuota : limit;
  return [
    ...activeIds.slice(0, activeQuota),
    ...terminalIds.slice(0, terminalQuota),
    ...activeIds.slice(activeQuota),
    ...terminalIds.slice(terminalQuota),
  ];
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function addMs(value: Date, milliseconds: number) {
  return new Date(value.getTime() + milliseconds);
}

async function readDatabaseClock(db: PrismaLike) {
  const [row] = await db.$queryRawUnsafe<Array<{ now: Date }>>(
    `SELECT clock_timestamp() AS "now"`,
  );
  if (!validDate(row?.now)) {
    throw new Error("Mainnet USDT scanner database clock is unavailable.");
  }
  return row.now;
}

function normalizeTarget(deposit: any, cursor: any, workerId: string): MainnetUsdtScanTarget {
  const invoice = deposit?.invoice;
  if (
    !deposit ||
    !invoice ||
    typeof deposit.id !== "string" ||
    typeof invoice.id !== "string" ||
    typeof deposit.network !== "string" ||
    typeof deposit.address !== "string" ||
    typeof deposit.addressRaw !== "string" ||
    typeof invoice.address !== "string" ||
    typeof invoice.addressRaw !== "string" ||
    !validDate(invoice.createdAt) ||
    !validDate(invoice.updatedAt)
  ) {
    throw new Error("Mainnet USDT scan target is malformed.");
  }
  return {
    invoiceId: invoice.id,
    depositAddressId: deposit.id,
    network: "mainnet",
    invoiceNetwork: invoice.network,
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
    cursorTimestamp: validDate(cursor?.lastTimestamp) ? cursor.lastTimestamp : null,
    leaseOwner: workerId,
  };
}

export function createPrismaMainnetUsdtScannerRepository(
  db: PrismaLike,
): MainnetUsdtScannerRepository {
  return {
    claimDueTargets: async (input) => {
      const dueIds = (statuses: string[]) => db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT deposit."id"
        FROM "TonhubDepositAddress" deposit
        JOIN "TonhubPaymentInvoice" invoice ON invoice."id" = deposit."invoiceId"
        LEFT JOIN "TonhubScanCursor" cursor
          ON cursor."network" = 'mainnet'
         AND cursor."streamType" = ${streamType}
         AND cursor."scopeKey" = deposit."id"
        WHERE deposit."network" = 'mainnet'
          AND invoice."network" = 'mainnet'
          AND invoice."addressStrategy" = 'unique-address'
          AND invoice."status"::text IN (${Prisma.join(statuses)})
          AND (
            invoice."status"::text IN ('PENDING', 'PARTIAL')
            OR COALESCE(
              invoice."terminalMonitorUntil",
              invoice."updatedAt" + ${input.terminalMonitorMs} * INTERVAL '1 millisecond'
            ) > ${input.now}
          )
          AND (
            cursor."id" IS NULL
            OR cursor."leaseExpiresAt" IS NULL
            OR cursor."leaseExpiresAt" <= ${input.now}
          )
        ORDER BY
          COALESCE(cursor."leaseExpiresAt", TIMESTAMP 'epoch') ASC,
          deposit."createdAt" ASC,
          deposit."id" ASC
        LIMIT ${input.candidatePoolSize}
      `);
      const [activeDue, terminalDue] = await Promise.all([
        dueIds(activeStatuses),
        dueIds(terminalStatuses),
      ]);
      const activeIds = activeDue.map(({ id }) => id);
      const terminalIds = terminalDue.map(({ id }) => id);
      const orderedIds = [...activeIds, ...terminalIds];
      if (!orderedIds.length) {
        return [];
      }
      const deposits = await db.tonhubDepositAddress.findMany({
        where: { id: { in: orderedIds } },
        include: { invoice: true },
      });
      const depositsById = new Map(deposits.map((deposit: any) => [deposit.id, deposit]));
      const cursors = await db.tonhubScanCursor.findMany({
        where: {
          network: "mainnet",
          streamType,
          scopeKey: { in: orderedIds },
        },
      });
      const cursorsByScope = new Map(cursors.map((cursor: any) => [cursor.scopeKey, cursor]));
      const fairIds = scheduleMainnetUsdtDueIds(activeIds, terminalIds, input.limit);

      const claimed: MainnetUsdtScanTarget[] = [];
      for (const depositId of fairIds) {
        if (claimed.length >= input.limit) {
          break;
        }
        const deposit = depositsById.get(depositId) as any;
        if (!deposit) {
          continue;
        }
        const existing = cursorsByScope.get(deposit.id);
        if (!existing) {
          await db.tonhubScanCursor.createMany({
            data: { network: "mainnet", streamType, scopeKey: deposit.id },
            skipDuplicates: true,
          });
        }
        const cursor = existing ?? await db.tonhubScanCursor.findUnique({
          where: {
            network_streamType_scopeKey: {
              network: "mainnet",
              streamType,
              scopeKey: deposit.id,
            },
          },
        });
        if (!cursor) {
          throw new Error("Mainnet USDT scan cursor was not created.");
        }
        const claimedLease = await db.$transaction(async (tx) => {
          const [locked] = await tx.$queryRawUnsafe<Array<{
            id: string;
            leaseOwner: string | null;
            leaseExpiresAt: Date | null;
          }>>(
            `SELECT "id", "leaseOwner", "leaseExpiresAt"
             FROM "TonhubScanCursor"
             WHERE "id" = $1
             FOR UPDATE`,
            cursor.id,
          );
          if (!locked) {
            return false;
          }
          const databaseNow = await readDatabaseClock(tx);
          const reclaimable = (
            locked.leaseOwner === null && locked.leaseExpiresAt === null
          ) || (
            validDate(locked.leaseExpiresAt) &&
            locked.leaseExpiresAt.getTime() <= databaseNow.getTime()
          );
          if (!reclaimable) {
            return false;
          }
          const updated = await tx.tonhubScanCursor.updateMany({
            where: { id: locked.id, leaseOwner: locked.leaseOwner },
            data: {
              leaseOwner: input.workerId,
              leaseExpiresAt: addMs(databaseNow, input.leaseMs),
            },
          });
          return updated.count === 1;
        });
        if (!claimedLease) {
          continue;
        }
        claimed.push(normalizeTarget(deposit, cursor, input.workerId));
      }
      return claimed;
    },

    renewLease: async (input) => {
      return db.$transaction(async (tx) => {
        const [locked] = await tx.$queryRawUnsafe<Array<{
          id: string;
          leaseExpiresAt: Date | null;
        }>>(
          `SELECT "id", "leaseExpiresAt"
           FROM "TonhubScanCursor"
           WHERE "network" = 'mainnet'
             AND "streamType" = $1
             AND "scopeKey" = $2
             AND "leaseOwner" = $3
           FOR UPDATE`,
          streamType,
          input.target.depositAddressId,
          input.target.leaseOwner,
        );
        const databaseNow = await readDatabaseClock(tx);
        if (
          !locked ||
          !validDate(locked.leaseExpiresAt) ||
          locked.leaseExpiresAt.getTime() <= databaseNow.getTime()
        ) {
          return false;
        }
        const renewed = await tx.tonhubScanCursor.updateMany({
          where: { id: locked.id, leaseOwner: input.target.leaseOwner },
          data: { leaseExpiresAt: addMs(databaseNow, input.leaseMs) },
        });
        return renewed.count === 1;
      });
    },

    completeScan: (input) => db.$transaction(async (tx) => {
      const [locked] = await tx.$queryRawUnsafe<Array<{
        id: string;
        leaseExpiresAt: Date | null;
      }>>(
        `SELECT "id", "leaseExpiresAt"
         FROM "TonhubScanCursor"
         WHERE "network" = 'mainnet'
           AND "streamType" = $1
           AND "scopeKey" = $2
           AND "leaseOwner" = $3
         FOR UPDATE`,
        streamType,
        input.target.depositAddressId,
        input.target.leaseOwner,
      );
      const databaseNow = await readDatabaseClock(tx);
      if (
        !locked ||
        !validDate(locked.leaseExpiresAt) ||
        locked.leaseExpiresAt.getTime() <= databaseNow.getTime()
      ) {
        return false;
      }
      const completed = await tx.tonhubScanCursor.updateMany({
        where: { id: locked.id, leaseOwner: input.target.leaseOwner },
        data: {
          lastTimestamp: input.scannedThroughAt,
          scannedThroughAt: input.scannedThroughAt,
          leaseOwner: null,
          leaseExpiresAt: input.nextScanAt,
        },
      });
      return completed.count === 1;
    }),

    failScan: async (input) => {
      const failed = await db.tonhubScanCursor.updateMany({
        where: {
          network: "mainnet",
          streamType,
          scopeKey: input.target.depositAddressId,
          leaseOwner: input.target.leaseOwner,
        },
        data: {
          leaseOwner: null,
          leaseExpiresAt: input.retryAt,
        },
      });
      return failed.count === 1;
    },
  };
}

function assertTargetOwnership(target: MainnetUsdtScanTarget) {
  if (
    target.network !== "mainnet" ||
    target.invoiceNetwork !== "mainnet" ||
    target.depositNetwork !== "mainnet"
  ) {
    throw new Error("Mainnet USDT invoice and deposit network evidence is inconsistent.");
  }
  const addresses = [
    target.address,
    target.addressRaw,
    target.invoiceAddress,
    target.invoiceAddressRaw,
  ].map(canonicalTonAddress);
  if (!addresses[0] || addresses.some((address) => address !== addresses[0])) {
    throw new Error("Mainnet USDT invoice and deposit address evidence is inconsistent.");
  }
}

export async function runMainnetUsdtScanBatch(input: {
  adapter: MainnetUsdtObserver;
  workerId?: string;
  now?: Date;
  clock?: () => Date;
  limit?: number;
  pageSize?: number;
  maxPages?: number;
  overlapMs?: number;
  activeIntervalMs?: number;
  terminalIntervalMs?: number;
  terminalMonitorMs?: number;
  retryMs?: number;
  leaseMs?: number;
  candidatePoolSize?: number;
  repository?: MainnetUsdtScannerRepository;
}) {
  const now = input.now ?? new Date();
  const clock = input.clock ?? (() => new Date());
  if (!validDate(now)) {
    throw new Error("Mainnet USDT batch now must be a valid date.");
  }
  const workerId = input.workerId ?? `mainnet-usdt-${process.pid}-${randomUUID()}`;
  const limit = input.limit ?? 20;
  const pageSize = input.pageSize ?? 100;
  const maxPages = input.maxPages ?? 100;
  const overlapMs = input.overlapMs ?? 60 * 60 * 1000;
  const activeIntervalMs = input.activeIntervalMs ?? 15_000;
  const terminalIntervalMs = input.terminalIntervalMs ?? 24 * 60 * 60 * 1000;
  const terminalMonitorMs = input.terminalMonitorMs ?? 30 * 24 * 60 * 60 * 1000;
  const retryMs = input.retryMs ?? 60_000;
  const leaseMs = input.leaseMs ?? 60_000;
  const candidatePoolSize = input.candidatePoolSize ?? 10_000;
  for (const [name, value] of Object.entries({
    limit,
    pageSize,
    maxPages,
    overlapMs,
    activeIntervalMs,
    terminalIntervalMs,
    terminalMonitorMs,
    retryMs,
    leaseMs,
    candidatePoolSize,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Mainnet USDT ${name} must be a positive safe integer.`);
    }
  }
  if (pageSize > 1000) {
    throw new Error("Mainnet USDT pageSize cannot exceed 1000.");
  }
  if (limit < 2) {
    throw new Error("Mainnet USDT limit must be at least 2 for terminal fairness.");
  }
  if (limit > candidatePoolSize) {
    throw new Error("Mainnet USDT candidatePoolSize cannot be smaller than limit.");
  }

  const repository = input.repository ?? createPrismaMainnetUsdtScannerRepository(
    prisma as unknown as PrismaLike,
  );
  const targets = await repository.claimDueTargets({
    workerId,
    now,
    limit,
    leaseMs,
    activeIntervalMs,
    terminalIntervalMs,
    terminalMonitorMs,
    candidatePoolSize,
  });
  const outcomes: Array<{
    invoiceId: string;
    status: "scanned" | "failed";
    transfersScanned: number;
    discoveryTransfersScanned: number;
    notificationTransactionsScanned: number;
    movementsObserved: number;
    rejectionsRecorded: number;
    error?: string;
  }> = [];

  for (const target of targets) {
    const totals = {
      transfersScanned: 0,
      discoveryTransfersScanned: 0,
      notificationTransactionsScanned: 0,
      movementsObserved: 0,
      rejectionsRecorded: 0,
    };
    try {
      assertTargetOwnership(target);
      const notBefore = target.cursorTimestamp
        ? new Date(Math.max(
            target.createdAt.getTime(),
            target.cursorTimestamp.getTime() - overlapMs,
          ))
        : target.createdAt;
      let offset = 0;
      let completed = false;
      for (let page = 0; page < maxPages; page += 1) {
        if (!await repository.renewLease({ target, now: clock(), leaseMs })) {
          throw new Error("Mainnet USDT scan lease was lost.");
        }
        const result = await input.adapter.observeDeposit({
          depositAddressId: target.depositAddressId,
          notBefore,
          notAfter: now,
          limit: pageSize,
          offset,
          observationLease: {
            streamType,
            leaseOwner: target.leaseOwner,
            clock,
          },
        });
        totals.transfersScanned += result.transfersScanned;
        totals.discoveryTransfersScanned += result.discoveryTransfersScanned;
        totals.notificationTransactionsScanned += result.notificationTransactionsScanned;
        totals.movementsObserved += result.movementsObserved;
        totals.rejectionsRecorded += result.rejectionsRecorded;
        if (
          result.transfersScanned < pageSize &&
          result.discoveryTransfersScanned < pageSize
        ) {
          completed = true;
          break;
        }
        if (!Number.isSafeInteger(result.nextOffset) || result.nextOffset <= offset) {
          throw new Error("Mainnet USDT provider pagination did not advance.");
        }
        offset = result.nextOffset;
      }
      if (!completed) {
        throw new Error(`Mainnet USDT scan exceeded ${maxPages} pages before completing its window.`);
      }
      const intervalMs = activeStatuses.includes(target.status)
        ? activeIntervalMs
        : terminalIntervalMs;
      const proposedNextScan = addMs(now, intervalMs);
      const nextScanAt = target.terminalMonitorUntil &&
        proposedNextScan.getTime() > target.terminalMonitorUntil.getTime()
        ? target.terminalMonitorUntil
        : proposedNextScan;
      if (!await repository.completeScan({
        target,
        scannedThroughAt: now,
        completedAt: clock(),
        nextScanAt,
      })) {
        throw new Error("Mainnet USDT scan completion lease was lost.");
      }
      outcomes.push({ invoiceId: target.invoiceId, status: "scanned", ...totals });
    } catch (error) {
      await repository.failScan({ target, retryAt: addMs(now, retryMs) });
      outcomes.push({
        invoiceId: target.invoiceId,
        status: "failed",
        ...totals,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    candidates: targets.length,
    scanned: outcomes.filter(({ status }) => status === "scanned").length,
    failed: outcomes.filter(({ status }) => status === "failed").length,
    transfersScanned: outcomes.reduce((sum, value) => sum + value.transfersScanned, 0),
    discoveryTransfersScanned: outcomes.reduce(
      (sum, value) => sum + value.discoveryTransfersScanned,
      0,
    ),
    notificationTransactionsScanned: outcomes.reduce(
      (sum, value) => sum + value.notificationTransactionsScanned,
      0,
    ),
    movementsObserved: outcomes.reduce((sum, value) => sum + value.movementsObserved, 0),
    rejectionsRecorded: outcomes.reduce((sum, value) => sum + value.rejectionsRecorded, 0),
    outcomes,
  };
}
