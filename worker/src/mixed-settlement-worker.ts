import { intEnv } from "../../backend/src/config";
import { runMixedSettlementBatch } from "./mixed-settlement";

const watch = process.argv.includes("--watch");
const intervalSeconds = intEnv("TON_MOVEMENT_SETTLEMENT_INTERVAL_SECONDS", 15, {
  min: 1,
  max: 24 * 60 * 60,
});
const batchSize = intEnv("TON_MOVEMENT_SETTLEMENT_BATCH_SIZE", 100, {
  min: 1,
  max: 10_000,
});
const retrySeconds = intEnv("TON_MOVEMENT_SETTLEMENT_RETRY_SECONDS", 60, {
  min: 1,
  max: 24 * 60 * 60,
});
const enabledValue = process.env.TON_MOVEMENT_SETTLEMENT_ENABLED?.trim().toLowerCase() || "false";
if (enabledValue !== "true" && enabledValue !== "false") {
  throw new Error("TON_MOVEMENT_SETTLEMENT_ENABLED must be true or false.");
}
const enabled = enabledValue === "true";
let stopping = false;
let wake: (() => void) | null = null;

function stop() {
  stopping = true;
  wake?.();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

async function waitForNextRun() {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, intervalSeconds * 1_000);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  wake = null;
}

if (!enabled) {
  console.log(JSON.stringify({ event: "mixed-settlement-disabled" }));
} else {
  do {
    const result = await runMixedSettlementBatch({
      limit: batchSize,
      retryMs: retrySeconds * 1_000,
    });
    console.log(JSON.stringify({
      event: "mixed-settlement-batch",
      movementsSelected: result.movementsSelected,
      invoicesSelected: result.invoicesSelected,
      invoicesSettled: result.invoicesSettled,
      errors: result.errors,
    }));
    if (!watch || stopping) {
      break;
    }
    await waitForNextRun();
  } while (!stopping);
}
