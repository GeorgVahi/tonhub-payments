import { prisma } from "../../backend/src/db";
import { intEnv } from "../../backend/src/config";
import { loadLocalEnv } from "../../backend/src/load-env";
import { movementLedger } from "../../backend/src/movement-ledger";
import {
  createMainnetUsdtAdapter,
  resolveMainnetUsdtAdapterConfig,
} from "../../backend/src/ton/mainnet-usdt";
import { runMainnetUsdtScanBatch } from "./mainnet-usdt";

function argValue(name: string) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (!value) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function intValue(name: string, fallback: number, limits: { min: number; max: number }) {
  const raw = argValue(name);
  if (!raw) {
    return fallback;
  }
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < limits.min || value > limits.max) {
    throw new Error(`${name} must be between ${limits.min} and ${limits.max}.`);
  }
  return value;
}

async function main() {
  loadLocalEnv();
  const config = resolveMainnetUsdtAdapterConfig();
  if (!config) {
    throw new Error("Mainnet USDT adapter is disabled.");
  }
  const adapter = createMainnetUsdtAdapter({
    db: prisma,
    ledger: movementLedger,
    config,
  });
  const watch = hasFlag("watch");
  const batchSize = intValue(
    "limit",
    intEnv("TON_USDT_MAINNET_SCAN_BATCH_SIZE", 20, { min: 2, max: 200 }),
    { min: 2, max: 200 },
  );
  const intervalSeconds = intValue(
    "interval-seconds",
    intEnv("TON_USDT_MAINNET_SCAN_INTERVAL_SECONDS", 15, { min: 5, max: 3600 }),
    { min: 5, max: 3600 },
  );
  const terminalIntervalSeconds = intEnv(
    "TON_USDT_MAINNET_SCAN_TERMINAL_INTERVAL_SECONDS",
    86_400,
    { min: 60, max: 7 * 86_400 },
  );
  const terminalMonitorDays = intEnv("TON_USDT_MAINNET_SCAN_TERMINAL_MONITOR_DAYS", 30, {
    min: 1,
    max: 365,
  });
  const retrySeconds = intEnv("TON_USDT_MAINNET_SCAN_RETRY_SECONDS", 60, {
    min: 5,
    max: 3600,
  });
  const leaseSeconds = intEnv("TON_USDT_MAINNET_SCAN_LEASE_SECONDS", 60, {
    min: 10,
    max: 3600,
  });
  const pageSize = intEnv("TON_USDT_MAINNET_SCAN_PAGE_SIZE", 1000, { min: 1, max: 1000 });
  const maxPages = intEnv("TON_USDT_MAINNET_SCAN_MAX_PAGES", 100, { min: 1, max: 1000 });
  const overlapSeconds = intEnv("TON_USDT_MAINNET_SCAN_OVERLAP_SECONDS", 3600, {
    min: 60,
    max: 86_400,
  });
  const candidatePoolSize = intEnv("TON_USDT_MAINNET_SCAN_CANDIDATE_POOL_SIZE", 10_000, {
    min: batchSize,
    max: 100_000,
  });
  let stopping = false;
  let interruptWait: (() => void) | null = null;
  const stop = () => {
    stopping = true;
    interruptWait?.();
  };
  const waitForNextRun = () => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, intervalSeconds * 1000);
    interruptWait = () => {
      clearTimeout(timer);
      resolve();
    };
  }).finally(() => {
    interruptWait = null;
  });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  do {
    const result = await runMainnetUsdtScanBatch({
      adapter,
      limit: batchSize,
      pageSize,
      maxPages,
      overlapMs: overlapSeconds * 1000,
      activeIntervalMs: intervalSeconds * 1000,
      terminalIntervalMs: terminalIntervalSeconds * 1000,
      terminalMonitorMs: terminalMonitorDays * 86_400 * 1000,
      retryMs: retrySeconds * 1000,
      leaseMs: leaseSeconds * 1000,
      candidatePoolSize,
    });
    console.log(
      `[tonhub-usdt-mainnet] candidates ${result.candidates}, scanned ${result.scanned}, failed ${result.failed}, transfers ${result.transfersScanned}, observed ${result.movementsObserved}, rejected ${result.rejectionsRecorded}`,
    );
    for (const outcome of result.outcomes) {
      if (outcome.status === "failed") {
        console.error(`[tonhub-usdt-mainnet] ${outcome.invoiceId} - ${outcome.error}`);
      }
    }
    if (watch && !stopping) {
      await waitForNextRun();
    }
  } while (watch && !stopping);
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
