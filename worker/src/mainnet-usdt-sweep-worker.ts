import { prisma } from "../../backend/src/db";
import { loadLocalEnv } from "../../backend/src/load-env";
import {
  resolveMainnetUsdtSweepConfig,
  runMainnetUsdtSweepBatch,
} from "./mainnet-usdt-sweep";

function intEnv(name: string, fallback: number, options: { min: number; max: number }) {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < options.min || value > options.max) {
    throw new Error(`${name} must be an integer between ${options.min} and ${options.max}.`);
  }
  return value;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function interruptibleWait(ms: number, subscribe: (wake: () => void) => void) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    subscribe(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main() {
  loadLocalEnv();
  const config = resolveMainnetUsdtSweepConfig();
  if (!config) {
    throw new Error("TON_USDT_MAINNET_ADAPTER_ENABLED must be true to run the mainnet USDT sweep worker.");
  }
  const watch = hasFlag("watch");
  const limit = intEnv("TON_MAINNET_USDT_SWEEP_BATCH_SIZE", 20, { min: 1, max: 200 });
  const intervalMs = intEnv("TON_MAINNET_USDT_SWEEP_INTERVAL_SECONDS", 5, {
    min: 1,
    max: 3600,
  }) * 1000;
  let stopping = false;
  let wake: () => void = () => undefined;
  const stop = () => {
    stopping = true;
    wake();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  do {
    const result = await runMainnetUsdtSweepBatch({ config, limit });
    console.log(
      `[tonhub-usdt-sweep] candidates=${result.candidates} outcomes=${result.outcomes.map(({ status }) => status).join(",") || "none"}`,
    );
    if (!watch || stopping) {
      break;
    }
    await interruptibleWait(intervalMs, (nextWake) => {
      wake = nextWake;
    });
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
