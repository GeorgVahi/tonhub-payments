import { intEnv } from "../../backend/src/config";
import { loadLocalEnv } from "../../backend/src/load-env";
import { prisma } from "../../backend/src/db";
import { resolveWebhookConfig, runWebhookBatch } from "./webhooks";

loadLocalEnv();
const config = resolveWebhookConfig();
if (!config) throw new Error("Webhooks are disabled; set TONHUB_WEBHOOK_URL and TONHUB_WEBHOOK_SECRET.");
const webhookConfig = config;
const watch = process.argv.includes("--watch");
const intervalSeconds = intEnv("TONHUB_WEBHOOK_INTERVAL_SECONDS", 5, { min: 1, max: 3_600 });
const batchSize = intEnv("TONHUB_WEBHOOK_BATCH_SIZE", 50, { min: 1, max: 1_000 });
let stopping = false;
let wake: (() => void) | null = null;
const stop = () => { stopping = true; wake?.(); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

async function waitForNextRun() {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, intervalSeconds * 1_000);
    wake = () => { clearTimeout(timer); resolve(); };
  });
  wake = null;
}

async function main() {
  do {
    const result = await runWebhookBatch({ config: webhookConfig, limit: batchSize });
    console.log(JSON.stringify({ event: "webhook-batch", ...result }));
    if (!watch || stopping) break;
    await waitForNextRun();
  } while (!stopping);
}

void main()
  .catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
