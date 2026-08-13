import { prisma } from "../../backend/src/db";
import { movementLedger } from "../../backend/src/movement-ledger";
import {
  createInternalTestnetJettonAdapter,
  resolveInternalTestnetJettonConfig,
} from "../../backend/src/ton/internal-testnet-jetton";

function flag(name: string) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function requiredFlag(name: string) {
  const value = flag(name)?.trim();
  if (!value) {
    throw new Error(`--${name}=... is required.`);
  }
  return value;
}

function dateFlag(name: string, fallback?: Date) {
  const value = flag(name);
  const result = value ? new Date(value) : fallback;
  if (!result || Number.isNaN(result.getTime())) {
    throw new Error(`--${name}=... must be an ISO date.`);
  }
  return result;
}

function integerFlag(name: string, fallback: number, minimum: number) {
  const raw = flag(name);
  const value = raw === null ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`--${name}=... must be an integer not less than ${minimum}.`);
  }
  return value;
}

async function main() {
  const config = resolveInternalTestnetJettonConfig();
  if (!config) {
    throw new Error("Internal testnet jetton adapter is disabled.");
  }
  const adapter = createInternalTestnetJettonAdapter({
    db: prisma,
    ledger: movementLedger,
    config,
  });
  const result = await adapter.observeDeposit({
    depositAddressId: requiredFlag("deposit-id"),
    notBefore: dateFlag("not-before"),
    notAfter: dateFlag("not-after", new Date()),
    limit: integerFlag("limit", 100, 1),
    offset: integerFlag("offset", 0, 0),
  });
  process.stdout.write(`${JSON.stringify({
    depositAssetAccountId: result.account.id,
    transfersScanned: result.transfersScanned,
    discoveryTransfersScanned: result.discoveryTransfersScanned,
    notificationTransactionsScanned: result.notificationTransactionsScanned,
    movementsObserved: result.movementsObserved,
    rejectionsRecorded: result.rejectionsRecorded,
    rejections: result.rejections,
    nextOffset: result.nextOffset,
  })}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
