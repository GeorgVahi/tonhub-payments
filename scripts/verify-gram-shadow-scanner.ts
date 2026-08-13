import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { Address } from "@ton/core";
import { createMovementLedger } from "../backend/src/movement-ledger";
import {
  createPrismaGramShadowScannerRepository,
  runGramShadowScanBatch,
} from "../worker/src/gram-shadow";

const prisma = new PrismaClient();
const repository = createPrismaGramShadowScannerRepository(prisma as any);
const ledger = createMovementLedger(prisma as any);
const suffix = process.env.TONHUB_GRAM_SHADOW_VERIFY_SUFFIX ?? "default";
const byte = suffix === "clean" ? "77" : "88";
const sourceByte = suffix === "clean" ? "99" : "aa";
const addressRaw = `0:${byte.repeat(32)}`;
const sourceRaw = `0:${sourceByte.repeat(32)}`;
const address = Address.parse(addressRaw).toString({ bounceable: true, testOnly: true });
const now = new Date("2026-08-13T10:30:00.000Z");
const ids = {
  order: `gram-shadow-order-${suffix}`,
  invoice: `gram-shadow-invoice-${suffix}`,
  deposit: `gram-shadow-deposit-${suffix}`,
  external: `gram-shadow-external-${suffix}`,
  reference: `gram-shadow-reference-${suffix}`,
};
const transactionHash = (suffix === "clean" ? "bc" : "cd").repeat(32);

try {
  await prisma.tonhubPaymentInvoice.updateMany({
    data: {
      scanPriorityAt: new Date("2099-01-01T00:00:00.000Z"),
      terminalMonitorUntil: new Date("2020-01-01T00:00:00.000Z"),
    },
  });
  await prisma.tonhubPaymentOrder.create({
    data: {
      id: ids.order,
      externalId: ids.external,
      fiatAmountMicros: "5000000",
      fiatCurrency: "USD",
    },
  });
  await prisma.tonhubPaymentInvoice.create({
    data: {
      id: ids.invoice,
      orderId: ids.order,
      network: "testnet",
      checkoutAsset: "USDT",
      asset: "USDT",
      assetKind: "JETTON",
      assetDecimals: 6,
      fiatAmountCents: 500,
      fiatAmountMicros: "5000000",
      remainingFiatMicros: "5000000",
      fiatCurrency: "USD",
      address,
      addressRaw,
      addressStrategy: "unique-address",
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 830_001 : 830_002,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: `gram-shadow-key-${suffix}`,
      amountNano: "2000000000",
      amountAtomic: "2000000000",
      paidAmountAtomic: "0",
      reference: ids.reference,
      expiresAt: new Date("2026-08-13T11:00:00.000Z"),
      scanPriorityAt: now,
      createdAt: new Date("2026-08-13T10:00:00.000Z"),
      updatedAt: new Date("2026-08-13T10:00:00.000Z"),
    },
  });
  await prisma.tonhubDepositAddress.create({
    data: {
      id: ids.deposit,
      invoiceId: ids.invoice,
      network: "testnet",
      address,
      addressRaw,
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 830_001 : 830_002,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: `gram-shadow-key-${suffix}`,
      status: "ACTIVE",
    },
  });

  const claimInput = {
    network: "testnet" as const,
    now,
    limit: 1,
    leaseMs: 60_000,
    terminalMonitorMs: 30 * 24 * 60 * 60 * 1000,
  };
  const [left, right] = await Promise.all([
    repository.claimDueTargets({ ...claimInput, workerId: `left-${suffix}` }),
    repository.claimDueTargets({ ...claimInput, workerId: `right-${suffix}` }),
  ]);
  assert.equal(left.length + right.length, 1, "only one worker may lease the address stream");
  const claimed = left[0] ?? right[0];
  assert.ok(claimed);
  assert.equal(await repository.failScan({ target: claimed, retryAt: now }), true);

  const fetchTransactions = async () => ({
    transactions: [
      {
        hash: transactionHash,
        lt: "990001",
        now: Math.floor(new Date("2026-08-13T10:10:00.000Z").getTime() / 1000),
        description: { aborted: false, action: { success: true } },
        in_msg: {
          source: sourceRaw,
          destination: addressRaw,
          value: "1500000000",
        },
      },
      {
        hash: "de".repeat(32),
        lt: "990000",
        now: Math.floor(new Date("2026-08-13T10:09:00.000Z").getTime() / 1000),
        description: { aborted: true },
        in_msg: {
          source: sourceRaw,
          destination: addressRaw,
          value: "9000000000",
        },
      },
    ],
  });
  const config = () => ({
    network: "testnet" as const,
    baseUrl: "https://example.invalid",
    address: "",
    addressEnvName: "",
  });
  const first = await runGramShadowScanBatch({
    network: "testnet",
    workerId: `runner-${suffix}`,
    now,
    clock: () => now,
    limit: 1,
    repository,
    ledger,
    fetchTransactions,
    resolveConfig: config,
  });
  assert.equal(first.scanned, 1);
  assert.equal(first.failed, 0);
  assert.equal(first.outcomes[0]?.movementsObserved, 1);
  assert.deepEqual(first.outcomes[0]?.rejections.map(({ code }) => code), [
    "TRANSACTION_NOT_SUCCESSFUL",
  ]);

  const movement = await prisma.tonhubPaymentMovement.findUnique({
    where: { fingerprint: `ton:testnet:native-in:${transactionHash}:0` },
  });
  assert.ok(movement);
  assert.equal(movement.status, "OBSERVED");
  assert.equal(movement.depositAddressId, ids.deposit);
  assert.equal(movement.amountAtomic, "1500000000");
  assert.equal(movement.fiatCreditMicros, null);
  assert.equal(await prisma.tonhubMovementAllocation.count({ where: { movementId: movement.id } }), 0);
  const invoice = await prisma.tonhubPaymentInvoice.findUnique({ where: { id: ids.invoice } });
  const order = await prisma.tonhubPaymentOrder.findUnique({ where: { id: ids.order } });
  assert.equal(invoice?.status, "PENDING");
  assert.equal(invoice?.paidAmountAtomic, "0");
  assert.equal(order?.status, "PENDING");
  assert.equal(order?.creditedFiatMicros, "0");
  const cursor = await prisma.tonhubScanCursor.findUnique({
    where: {
      network_streamType_scopeKey: {
        network: "testnet",
        streamType: "GRAM_NATIVE_IN",
        scopeKey: ids.deposit,
      },
    },
  });
  assert.equal(cursor?.lastHash, transactionHash);
  assert.equal(cursor?.leaseOwner, null);
  assert.equal(cursor?.leaseExpiresAt, null);

  const replayAt = new Date("2026-08-13T10:31:00.000Z");
  await prisma.tonhubPaymentInvoice.update({
    where: { id: ids.invoice },
    data: { scanPriorityAt: replayAt },
  });
  const replay = await runGramShadowScanBatch({
    network: "testnet",
    workerId: `replay-${suffix}`,
    now: replayAt,
    clock: () => replayAt,
    limit: 1,
    repository,
    ledger,
    fetchTransactions,
    resolveConfig: config,
  });
  assert.equal(replay.scanned, 1);
  assert.equal(replay.outcomes[0]?.transactionsScanned, 0);
  assert.equal(await prisma.tonhubPaymentMovement.count({
    where: { fingerprint: `ton:testnet:native-in:${transactionHash}:0` },
  }), 1);

  const terminalAt = new Date("2026-08-13T10:32:00.000Z");
  await prisma.tonhubPaymentInvoice.update({
    where: { id: ids.invoice },
    data: { scanPriorityAt: terminalAt },
  });
  const staleTarget = (await repository.claimDueTargets({
    ...claimInput,
    workerId: `stale-${suffix}`,
    now: terminalAt,
  }))[0];
  assert.ok(staleTarget);
  await prisma.tonhubPaymentInvoice.update({
    where: { id: ids.invoice },
    data: {
      status: "EXPIRED",
      scanPriorityAt: null,
      terminalMonitorUntil: null,
      updatedAt: terminalAt,
    },
  });
  assert.equal(await repository.completeScan({
    target: staleTarget,
    scannedAt: new Date(terminalAt.getTime() + 1_000),
    nextScanAt: new Date(terminalAt.getTime() + 15_000),
    terminalMonitorUntil: null,
    cursor: {
      hash: transactionHash,
      lt: "990001",
      timestamp: new Date("2026-08-13T10:10:00.000Z"),
    },
  }), true);
  const staleCompletionInvoice = await prisma.tonhubPaymentInvoice.findUnique({
    where: { id: ids.invoice },
  });
  assert.equal(staleCompletionInvoice?.status, "EXPIRED");
  assert.equal(staleCompletionInvoice?.updatedAt.toISOString(), terminalAt.toISOString());
  assert.equal(staleCompletionInvoice?.scanPriorityAt, null);
  assert.equal(staleCompletionInvoice?.terminalMonitorUntil, null);

  await prisma.tonhubPaymentInvoice.update({
    where: { id: ids.invoice },
    data: {
      status: "PENDING",
      scanPriorityAt: terminalAt,
      updatedAt: terminalAt,
    },
  });
  const staleFailureTarget = (await repository.claimDueTargets({
    ...claimInput,
    workerId: `stale-failure-${suffix}`,
    now: terminalAt,
  }))[0];
  assert.ok(staleFailureTarget);
  const secondTerminalAt = new Date(terminalAt.getTime() + 2_000);
  await prisma.tonhubPaymentInvoice.update({
    where: { id: ids.invoice },
    data: {
      status: "EXPIRED",
      scanPriorityAt: null,
      terminalMonitorUntil: null,
      updatedAt: secondTerminalAt,
    },
  });
  assert.equal(await repository.failScan({
    target: staleFailureTarget,
    retryAt: new Date(secondTerminalAt.getTime() + 60_000),
  }), true);
  const staleFailureInvoice = await prisma.tonhubPaymentInvoice.findUnique({
    where: { id: ids.invoice },
  });
  assert.equal(staleFailureInvoice?.status, "EXPIRED");
  assert.equal(staleFailureInvoice?.updatedAt.toISOString(), secondTerminalAt.toISOString());
  assert.equal(staleFailureInvoice?.scanPriorityAt, null);
  assert.equal(staleFailureInvoice?.terminalMonitorUntil, null);

  const terminal = await runGramShadowScanBatch({
    network: "testnet",
    workerId: `terminal-${suffix}`,
    now: secondTerminalAt,
    clock: () => secondTerminalAt,
    limit: 1,
    repository,
    ledger,
    fetchTransactions: async () => ({ transactions: [] }),
    resolveConfig: config,
  });
  assert.equal(terminal.scanned, 1);
  const terminalInvoice = await prisma.tonhubPaymentInvoice.findUnique({
    where: { id: ids.invoice },
  });
  assert.equal(
    terminalInvoice?.terminalMonitorUntil?.toISOString(),
    "2026-09-12T10:32:02.000Z",
  );
  assert.equal(
    terminalInvoice?.scanPriorityAt?.toISOString(),
    "2026-08-14T10:32:02.000Z",
  );
} finally {
  await prisma.$disconnect();
}

console.log(`ok - GRAM shadow scanner repository (${suffix})`);
