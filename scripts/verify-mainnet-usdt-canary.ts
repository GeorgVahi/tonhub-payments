import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { inspectMainnetUsdtCanary } from "../backend/src/mainnet-usdt-canary";

const prisma = new PrismaClient();
const suffix = process.env.TONHUB_CANARY_VERIFY_SUFFIX ?? "default";
const externalId = `rehearsal-canary-${suffix}`;

try {
  const order = await prisma.tonhubPaymentOrder.create({
    data: {
      externalId,
      fiatAmountMicros: "5000000",
      fiatCurrency: "USD",
      status: "RECOVERY",
    },
  });
  const invoice = await prisma.tonhubPaymentInvoice.create({
    data: {
      orderId: order.id,
      network: "mainnet",
      asset: "USDT",
      checkoutAsset: "USDT",
      assetKind: "JETTON",
      assetDecimals: 6,
      fiatAmountCents: 500,
      fiatAmountMicros: "5000000",
      remainingFiatMicros: "5000000",
      fiatCurrency: "USD",
      address: `canary-address-${suffix}`,
      addressRaw: `0:canary-${suffix}`,
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 980001 : 980002,
      walletNetworkGlobalId: -239,
      walletPublicKeyHash: `canary-key-${suffix}`,
      amountNano: "5000000",
      amountAtomic: "5000000",
      reference: `canary-reference-${suffix}`,
    },
  });
  const recovery = await prisma.tonhubRecoveryCase.create({
    data: {
      orderId: order.id,
      invoiceId: invoice.id,
      reason: "CANARY_REHEARSAL",
      title: "Canary rehearsal recovery",
    },
  });
  const report = await inspectMainnetUsdtCanary({
    db: prisma as any,
    env: {
      TON_ALLOWED_NETWORKS: "testnet,mainnet",
      TON_USDT_MAINNET_CHECKOUT_ENABLED: "false",
      TON_USDT_MAINNET_ADAPTER_ENABLED: "true",
      TON_MOVEMENT_SETTLEMENT_ENABLED: "true",
      TON_GRAM_SETTLEMENT_MODE: "ledger",
      TON_USDT_MAINNET_CANARY_EXTERNAL_IDS: externalId,
      TON_RATE_SNAPSHOT_MAX_AGE_SECONDS: "300",
    },
    now: new Date("2026-08-13T12:03:00.000Z"),
  });
  assert.equal(report.ok, false);
  assert.equal(report.configuredOrders, 1);
  assert.equal(report.materializedOrders, 1);
  assert.equal(report.unresolvedRecoveries, 1);
  assert.ok(report.blockers.some((value) => value.includes("unresolved recovery")));

  await prisma.tonhubRecoveryCase.update({
    where: { id: recovery.id },
    data: { status: "RESOLVED", resolvedBy: "rehearsal", resolvedAt: new Date("2026-08-13T12:02:30.000Z") },
  });
  await prisma.tonhubPaymentOrder.update({ where: { id: order.id }, data: { status: "PENDING" } });
  const ready = await inspectMainnetUsdtCanary({
    db: prisma as any,
    env: {
      TON_ALLOWED_NETWORKS: "testnet,mainnet",
      TON_USDT_MAINNET_CHECKOUT_ENABLED: "false",
      TON_USDT_MAINNET_ADAPTER_ENABLED: "true",
      TON_MOVEMENT_SETTLEMENT_ENABLED: "true",
      TON_GRAM_SETTLEMENT_MODE: "ledger",
      TON_USDT_MAINNET_CANARY_EXTERNAL_IDS: externalId,
      TON_RATE_SNAPSHOT_MAX_AGE_SECONDS: "300",
    },
    now: new Date("2026-08-13T12:03:00.000Z"),
  });
  assert.equal(ready.ok, true);
  assert.equal(ready.unresolvedRecoveries, 0);
} finally {
  await prisma.$disconnect();
}
