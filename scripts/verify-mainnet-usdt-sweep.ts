import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { Address } from "@ton/core";
import { WalletContractV5R1 } from "@ton/ton";
import { prisma } from "../backend/src/db";
import { createMovementLedger } from "../backend/src/movement-ledger";
import { officialMainnetUsdtMasterAddress } from "../backend/src/ton/mainnet-usdt";
import {
  createPrismaMainnetUsdtSweepRepository,
  processMainnetUsdtSweep,
  resolveMainnetUsdtSweepConfig,
  type MainnetUsdtSweepBlockchain,
} from "../worker/src/mainnet-usdt-sweep";

const suffix = process.env.TONHUB_USDT_SWEEP_VERIFY_SUFFIX ?? "default";
const depositSecret = Buffer.concat([Buffer.alloc(32, 71), Buffer.alloc(32, 72)]);
const gasSecret = Buffer.concat([Buffer.alloc(32, 73), Buffer.alloc(32, 74)]);
const depositPublic = depositSecret.subarray(32);
const gasPublic = gasSecret.subarray(32);
const context = suffix === "clean" ? 830_001 : 830_002;
const depositWallet = WalletContractV5R1.create({
  publicKey: depositPublic,
  workchain: 0,
  walletId: { networkGlobalId: -239, context },
});
const gasWallet = WalletContractV5R1.create({ publicKey: gasPublic });
const jettonWallet = Address.parseRaw(`0:${(suffix === "clean" ? "81" : "82").repeat(32)}`);
const sender = Address.parseRaw(`0:${(suffix === "clean" ? "83" : "84").repeat(32)}`);
const createdAt = new Date("2026-08-13T09:59:00.000Z");

async function main() {
  const config = resolveMainnetUsdtSweepConfig({
    TON_USDT_MAINNET_ADAPTER_ENABLED: "true",
    TON_MAINNET_DEPOSIT_SECRET_KEY: depositSecret.toString("base64url"),
    TON_MAINNET_SWEEP_RECIPIENT_ADDRESS: gasWallet.address.toString(),
    TON_MAINNET_GAS_SERVICE_SECRET_KEY: gasSecret.toString("base64url"),
    TON_MAINNET_USDT_SWEEP_INTERVAL_SECONDS: "5",
  });
  assert.ok(config);
  const orderId = `usdt-sweep-order-${suffix}`;
  const invoiceId = `usdt-sweep-invoice-${suffix}`;
  const depositId = `usdt-sweep-deposit-${suffix}`;
  await prisma.tonhubPaymentOrder.create({
    data: {
      id: orderId,
      externalId: `usdt-sweep-merchant-${suffix}`,
      fiatAmountMicros: "5000000",
      fiatCurrency: "USD",
      createdAt,
      updatedAt: createdAt,
    },
  });
  await prisma.tonhubPaymentInvoice.create({
    data: {
      id: invoiceId,
      orderId,
      network: "mainnet",
      fiatAmountCents: 500,
      fiatAmountMicros: "5000000",
      remainingFiatMicros: "5000000",
      activationThresholdFiatMicros: "2500000",
      fiatCurrency: "USD",
      address: depositWallet.address.toString(),
      addressRaw: depositWallet.address.toRawString(),
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: context,
      walletNetworkGlobalId: -239,
      walletPublicKeyHash: config.depositPublicKeyHash,
      amountNano: "5000000000",
      amountAtomic: "5000000000",
      reference: `usdt-sweep-reference-${suffix}`,
      createdAt,
      updatedAt: createdAt,
    },
  });
  await prisma.tonhubDepositAddress.create({
    data: {
      id: depositId,
      invoiceId,
      network: "mainnet",
      address: depositWallet.address.toString(),
      addressRaw: depositWallet.address.toRawString(),
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: context,
      walletNetworkGlobalId: -239,
      walletPublicKeyHash: config.depositPublicKeyHash,
      status: "ACTIVE",
      createdAt,
      updatedAt: createdAt,
    },
  });
  await prisma.tonhubDepositAssetAccount.create({
    data: {
      depositAddressId: depositId,
      network: "mainnet",
      asset: "USDT",
      assetKind: "JETTON",
      assetDecimals: 6,
      jettonMasterAddress: officialMainnetUsdtMasterAddress,
      assetWalletAddress: jettonWallet.toRawString(),
      status: "VERIFIED",
      verifiedAt: new Date("2026-08-13T09:59:00.000Z"),
    },
  });
  const ledger = createMovementLedger(prisma as any);
  const incoming = await ledger.recordObserved({
    fingerprint: `ton:mainnet:jetton-in:${"91".repeat(32)}:42:${officialMainnetUsdtMasterAddress}`,
    depositAddressId: depositId,
    network: "mainnet",
    direction: "INCOMING",
    asset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    amountAtomic: "5000000",
    fromAddress: sender.toRawString(),
    toAddress: depositWallet.address.toRawString(),
    ownerAddress: depositWallet.address.toRawString(),
    jettonMasterAddress: officialMainnetUsdtMasterAddress,
    jettonWalletAddress: jettonWallet.toRawString(),
    transactionHash: "91".repeat(32),
    transactionLt: "930001",
    queryId: "42",
    blockchainAt: new Date("2026-08-13T10:00:00.000Z"),
    rawPayload: { officialUsdt: true, evidenceVersion: 1 },
  });
  await prisma.tonhubAssetSweep.create({
    data: {
      idempotencyKey: `verifier-usdt-movement:${incoming.id}`,
      depositAddressId: depositId,
      orderId,
      invoiceId,
      asset: "USDT",
      assetKind: "JETTON",
      status: "QUEUED",
    },
  });
  const repository = createPrismaMainnetUsdtSweepRepository(prisma as any);
  let sweep = (await repository.listCandidates({
    now: new Date("2026-08-13T10:00:01.000Z"),
    limit: 200,
  })).find((candidate) => candidate.depositAddressId === depositId);
  assert.ok(sweep);
  assert.equal(sweep.idempotencyKey, `verifier-usdt-movement:${incoming.id}`);
  let depositTon = 40_000_000n;
  let jettonBalance = 5_000_000n;
  let depositSeqno = 8;
  let gasSeqno = 12;
  let jettonSent = false;
  const blockchain: MainnetUsdtSweepBlockchain = {
    getTonBalance: async () => depositTon,
    getJettonBalance: async () => jettonBalance,
    getWalletSeqno: async (wallet) => wallet.address.equals(gasWallet.address)
      ? gasSeqno
      : depositSeqno,
    sendGasTopup: async ({ amountNano, seqno }) => {
      assert.equal(amountNano, seqno === 12 ? 111_000_000n : 11_000_000n);
      assert.ok(seqno === 12 || seqno === 13);
      gasSeqno += 1;
      depositTon += amountNano;
    },
    sendJettonSweep: async ({ amountAtomic, queryId, seqno }) => {
      assert.equal(amountAtomic, 5_000_000n);
      assert.ok(queryId >= 0n);
      assert.equal(seqno, 8);
      depositSeqno += 1;
      depositTon = 40_000_000n;
      jettonBalance = 0n;
      jettonSent = true;
    },
    waitForWalletSeqno: async (wallet, previous) => (
      wallet.address.equals(gasWallet.address) ? gasSeqno : depositSeqno
    ) > previous,
    findJettonSweep: async ({ amountAtomic, queryId }) => jettonSent
      ? {
          transactionHash: "92".repeat(32),
          transactionLt: "930002",
          blockchainAt: new Date("2026-08-13T10:00:10.000Z"),
        }
      : (assert.fail(`confirmation requested before send: ${amountAtomic}/${queryId}`), null),
  };
  assert.equal((await processMainnetUsdtSweep({
    record: sweep,
    config,
    repository,
    blockchain,
    workerId: `usdt-sweep-worker-${suffix}`,
    now: () => new Date("2026-08-13T10:00:01.000Z"),
  })).status, "gas-topup-sent");
  sweep = (await repository.listCandidates({
    now: new Date("2026-08-13T10:00:07.000Z"),
    limit: 200,
  })).find((candidate) => candidate.depositAddressId === depositId);
  assert.ok(sweep);
  assert.equal((await processMainnetUsdtSweep({
    record: sweep,
    config,
    repository,
    blockchain,
    workerId: `usdt-sweep-worker-${suffix}`,
    now: () => new Date("2026-08-13T10:00:07.000Z"),
  })).status, "sent");
  sweep = (await repository.listCandidates({
    now: new Date("2026-08-13T10:00:13.000Z"),
    limit: 200,
  })).find((candidate) => candidate.depositAddressId === depositId);
  assert.ok(sweep);
  assert.equal((await processMainnetUsdtSweep({
    record: sweep,
    config,
    repository,
    blockchain,
    workerId: `usdt-sweep-worker-${suffix}`,
    now: () => new Date("2026-08-13T10:00:13.000Z"),
  })).status, "confirmed");
  const confirmed = await prisma.tonhubAssetSweep.findUniqueOrThrow({ where: { id: sweep.id } });
  assert.equal(confirmed.status, "CONFIRMED");
  assert.equal(confirmed.amountAtomic, "5000000");
  assert.equal(confirmed.gasTopupAmountNano, "111000000");
  assert.equal(confirmed.reserveTopupAmountNano, "11000000");
  assert.equal(confirmed.reserveTopupSeqno, 13);
  assert.equal(confirmed.gasServicePlanKey, null);
  assert.equal(confirmed.transactionHash, "92".repeat(32));
  const outgoing = await prisma.tonhubPaymentMovement.findFirstOrThrow({
    where: { depositAddressId: depositId, direction: "OUTGOING", asset: "USDT" },
  });
  assert.equal(outgoing.amountAtomic, "5000000");
  assert.equal(outgoing.queryId, confirmed.queryId);
  assert.equal(await prisma.tonhubAssetSweep.count({
    where: { depositAddressId: depositId, status: { not: "CONFIRMED" } },
  }), 0);

  const manual = await repository.queueForDeposit({
    depositAddressId: depositId,
    requestId: `recovery-check-${suffix}`,
    requestedAt: new Date("2026-08-13T10:01:00.000Z"),
  });
  await prisma.tonhubPaymentInvoice.update({
    where: { id: invoiceId },
    data: { network: "testnet" },
  });
  assert.equal((await processMainnetUsdtSweep({
    record: manual,
    config,
    repository,
    blockchain,
    workerId: `usdt-sweep-worker-${suffix}`,
    now: () => new Date("2026-08-13T10:01:01.000Z"),
  })).status, "failed");
  assert.equal(await prisma.tonhubRecoveryCase.count({
    where: { id: `asset-sweep:${manual.id}`, status: "OPEN" },
  }), 1);
  await prisma.tonhubPaymentInvoice.update({
    where: { id: invoiceId },
    data: { network: "mainnet" },
  });
  assert.equal(await repository.retryFailed({
    sweepId: manual.id,
    requestedAt: new Date("2026-08-13T10:02:00.000Z"),
  }), true);
  const retried = await prisma.tonhubAssetSweep.findUniqueOrThrow({ where: { id: manual.id } });
  assert.equal(retried.status, "QUEUED");
  assert.equal(retried.attempts, 0);
}

void main().finally(() => prisma.$disconnect());
