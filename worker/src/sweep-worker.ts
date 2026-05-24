import { prisma } from "../../backend/src/db";
import { loadLocalEnv } from "../../backend/src/load-env";
import {
  formatNanoTon,
  maskValue,
  parseTonNetworks,
  type TonNetwork
} from "../../backend/src/ton/direct-payments";
import {
  resolveTonDepositSweepConfig,
  runTonDepositSweepBatch,
  type TonDepositSweepConfig,
  type TonDepositSweepOutcome
} from "./sweep";

function argValue(name: string) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));

  if (inline) {
    return inline.slice(prefix.length);
  }

  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function intValue(name: string, fallback: number, input: { min: number; max: number }) {
  const raw = argValue(name);

  if (!raw) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);

  if (!Number.isFinite(value) || value < input.min || value > input.max) {
    throw new Error(`${name} must be between ${input.min} and ${input.max}.`);
  }

  return value;
}

function printConfig(config: TonDepositSweepConfig) {
  console.log(
    [
      `[tonhub-sweep] ${config.network}: recipient ${maskValue(config.recipientAddress)} from ${config.recipientAddressEnvName}`,
      `reserve ${formatNanoTon(config.reserveNano.toString())}`,
      `min ${formatNanoTon(config.minSweepNano.toString())}`,
      `secret ${config.secretKeyEnvName}`,
      `API key ${config.apiKeyEnvName ? `configured via ${config.apiKeyEnvName}` : "not configured"}`
    ].join(" | ")
  );
}

function printOutcome(network: TonNetwork, outcome: TonDepositSweepOutcome) {
  if (outcome.status === "sent") {
    console.log(
      `[tonhub-sweep] ${network}: sent ${outcome.amountTon} from ${outcome.addressMasked} to ${outcome.recipientAddressMasked}`
    );
    return;
  }

  if (outcome.status === "insufficient-balance") {
    console.log(`[tonhub-sweep] ${network}: skipped ${outcome.addressMasked} - ${outcome.error}`);
    return;
  }

  if (outcome.status === "claimed-by-other") {
    console.log(`[tonhub-sweep] ${network}: skipped ${outcome.addressMasked} - already claimed`);
    return;
  }

  console.log(`[tonhub-sweep] ${network}: failed ${outcome.addressMasked} - ${outcome.error}`);
}

async function runNetworkSweep(network: TonNetwork, input: {
  limit: number;
  retryAfterMs: number;
}) {
  const config = resolveTonDepositSweepConfig(network);
  printConfig(config);

  const result = await runTonDepositSweepBatch({
    network,
    limit: input.limit,
    retryAfterMs: input.retryAfterMs,
    config
  });

  console.log(
    `[tonhub-sweep] ${network}: candidates ${result.candidates}, sent ${result.sent}, failed ${result.failed}`
  );

  for (const outcome of result.outcomes) {
    printOutcome(network, outcome);
  }
}

async function main() {
  loadLocalEnv();

  const networks = parseTonNetworks(
    argValue("network") ?? process.env.TON_SWEEP_NETWORK ?? process.env.TON_DEFAULT_NETWORK
  );
  const watch = hasFlag("watch");
  const limit = intValue("limit", 10, {
    min: 1,
    max: 50
  });
  const intervalSeconds = intValue("interval-seconds", 15, {
    min: 5,
    max: 600
  });
  const retryAfterSeconds = intValue("retry-after-seconds", 60, {
    min: 10,
    max: 3600
  });
  let stopping = false;

  process.once("SIGINT", () => {
    stopping = true;
  });
  process.once("SIGTERM", () => {
    stopping = true;
  });

  do {
    for (const network of networks) {
      await runNetworkSweep(network, {
        limit,
        retryAfterMs: retryAfterSeconds * 1000
      });
    }

    if (!watch || stopping) {
      break;
    }

    await sleep(intervalSeconds * 1000);
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

