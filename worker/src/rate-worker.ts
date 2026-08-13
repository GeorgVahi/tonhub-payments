import { prisma } from "../../backend/src/db";
import { intEnv, type FiatCurrency } from "../../backend/src/config";
import { loadLocalEnv } from "../../backend/src/load-env";
import { refreshPaymentRateSnapshots } from "../../backend/src/rate-snapshots";

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

function intervalSeconds() {
  const argument = argValue("interval-seconds");
  if (argument !== undefined) {
    const value = /^\d+$/.test(argument) ? Number(argument) : Number.NaN;
    if (!Number.isInteger(value) || value < 30 || value > 3600) {
      throw new Error("interval-seconds must be between 30 and 3600.");
    }
    return value;
  }
  return intEnv("TON_RATE_SNAPSHOT_INTERVAL_SECONDS", 60, { min: 30, max: 3600 });
}

async function main() {
  loadLocalEnv();
  const watch = hasFlag("watch");
  const intervalMs = intervalSeconds() * 1000;
  let stopping = false;
  let interruptWait: (() => void) | null = null;
  const stop = () => {
    stopping = true;
    interruptWait?.();
  };
  const waitForNextRun = () => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, intervalMs);
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
    const result = await refreshPaymentRateSnapshots({
      currencies: ["USD", "EUR"] satisfies FiatCurrency[],
    });
    console.log(
      `[tonhub-rates] stored ${result.snapshots.length} snapshots; errors ${result.errors.length}`,
    );
    for (const error of result.errors) {
      console.error(`[tonhub-rates] ${error.asset}/${error.quoteCurrency}: ${error.error}`);
    }
    if (!watch) {
      if (!result.ok) {
        process.exitCode = 1;
      }
      break;
    }
    if (!stopping) {
      await waitForNextRun();
    }
  } while (!stopping);
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
