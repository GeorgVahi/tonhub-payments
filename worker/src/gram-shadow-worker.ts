import { prisma } from "../../backend/src/db";
import { intEnv } from "../../backend/src/config";
import { loadLocalEnv } from "../../backend/src/load-env";
import { parseTonNetworks } from "../../backend/src/ton/direct-payments";
import { runGramShadowScanBatch } from "./gram-shadow";

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
  const networks = parseTonNetworks(
    argValue("network") ?? process.env.TON_GRAM_SHADOW_NETWORK ?? process.env.TON_DEFAULT_NETWORK,
  );
  const watch = hasFlag("watch");
  const batchSize = intValue(
    "limit",
    intEnv("TON_GRAM_SHADOW_BATCH_SIZE", 20, { min: 1, max: 200 }),
    { min: 1, max: 200 },
  );
  const intervalSeconds = intValue(
    "interval-seconds",
    intEnv("TON_GRAM_SHADOW_INTERVAL_SECONDS", 15, { min: 5, max: 3600 }),
    { min: 5, max: 3600 },
  );
  const terminalIntervalSeconds = intEnv(
    "TON_GRAM_SHADOW_TERMINAL_INTERVAL_SECONDS",
    86_400,
    { min: 60, max: 7 * 86_400 },
  );
  const terminalMonitorDays = intEnv("TON_GRAM_SHADOW_TERMINAL_MONITOR_DAYS", 30, {
    min: 1,
    max: 365,
  });
  const retrySeconds = intEnv("TON_GRAM_SHADOW_RETRY_SECONDS", 60, {
    min: 5,
    max: 3600,
  });
  const leaseSeconds = intEnv("TON_GRAM_SHADOW_LEASE_SECONDS", 60, {
    min: 10,
    max: 3600,
  });
  const pageSize = intEnv("TON_GRAM_SHADOW_PAGE_SIZE", 100, { min: 1, max: 1000 });
  const maxPages = intEnv("TON_GRAM_SHADOW_MAX_PAGES", 100, { min: 1, max: 1000 });
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
    for (const network of networks) {
      const result = await runGramShadowScanBatch({
        network,
        limit: batchSize,
        pageSize,
        maxPages,
        activeIntervalMs: intervalSeconds * 1000,
        terminalIntervalMs: terminalIntervalSeconds * 1000,
        terminalMonitorMs: terminalMonitorDays * 86_400 * 1000,
        retryMs: retrySeconds * 1000,
        leaseMs: leaseSeconds * 1000,
      });
      console.log(
        `[tonhub-gram-shadow] ${network}: candidates ${result.candidates}, scanned ${result.scanned}, failed ${result.failed}, transactions ${result.transactionsScanned}, observed ${result.movementsObserved}, rejected ${result.rejected}`,
      );
      for (const outcome of result.outcomes) {
        if (outcome.status === "failed") {
          console.error(`[tonhub-gram-shadow] ${network}: ${outcome.invoiceId} - ${outcome.error}`);
        }
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
