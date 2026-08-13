import assert from "node:assert/strict";
import { Address } from "@ton/core";
import { prisma } from "../backend/src/db";
import { createPrismaAdminRepository } from "../backend/src/admin/repository";
import { createPrismaWebhookRepository } from "../worker/src/webhooks";

const suffix = process.env.TONHUB_WEBHOOK_VERIFY_SUFFIX ?? "default";
const base = new Date("2026-08-13T12:00:00.000Z");
const owner = Address.parseRaw(`0:${(suffix === "clean" ? "d1" : "d2").repeat(32)}`);

async function main() {
  const orderId = `webhook-order-${suffix}`;
  const expiredOrderId = `webhook-expired-order-${suffix}`;
  const invoiceId = `webhook-invoice-${suffix}`;
  const expiredInvoiceId = `webhook-expired-${suffix}`;
  const depositId = `webhook-deposit-${suffix}`;
  await prisma.tonhubPaymentOrder.create({
    data: { id: orderId, externalId: `webhook-external-${suffix}`, fiatAmountMicros: "1000000", fiatCurrency: "USD" },
  });
  await prisma.tonhubPaymentOrder.create({
    data: { id: expiredOrderId, externalId: `webhook-expired-external-${suffix}`, fiatAmountMicros: "1000000", fiatCurrency: "USD" },
  });
  const invoiceData = (id: string, context: number, owningOrderId = orderId) => ({
    id,
    orderId: owningOrderId,
    network: "testnet",
    fiatAmountCents: 100,
    fiatAmountMicros: "1000000",
    remainingFiatMicros: "1000000",
    fiatCurrency: "USD",
    address: owner.toString({ testOnly: true }),
    addressRaw: owner.toRawString(),
    walletVersion: "v5r1",
    walletWorkchain: 0,
    walletContext: context,
    walletNetworkGlobalId: -3,
    walletPublicKeyHash: `webhook-key-${suffix}-${context}`,
    amountNano: "1000000000",
    amountAtomic: "1000000000",
    reference: `webhook-reference-${suffix}-${context}`,
    expiresAt: new Date(base.getTime() + 60 * 60 * 1000),
  });
  await prisma.tonhubPaymentInvoice.create({ data: invoiceData(invoiceId, suffix === "clean" ? 970001 : 970002) });
  await prisma.tonhubPaymentInvoice.create({
    data: invoiceData(expiredInvoiceId, suffix === "clean" ? 970003 : 970004, expiredOrderId),
  });
  await prisma.tonhubDepositAddress.create({
    data: {
      id: depositId,
      invoiceId,
      network: "testnet",
      address: owner.toString({ testOnly: true }),
      addressRaw: owner.toRawString(),
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 970001 : 970002,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: `webhook-key-${suffix}-${suffix === "clean" ? 970001 : 970002}`,
      status: "PAID",
      paidAt: base,
    },
  });

  await prisma.tonhubPaymentInvoice.update({
    where: { id: invoiceId },
    data: { status: "PARTIAL", creditedFiatMicros: "400000", remainingFiatMicros: "600000", observedAt: base, version: { increment: 1 } },
  });
  await prisma.tonhubPaymentInvoice.update({
    where: { id: invoiceId },
    data: { creditedFiatMicros: "700000", remainingFiatMicros: "300000", version: { increment: 1 } },
  });
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.tonhubPaymentInvoice.update({
      where: { id: invoiceId },
      data: { creditedFiatMicros: "800000", remainingFiatMicros: "200000", version: { increment: 1 } },
    });
    throw new Error("rollback webhook transition");
  }));
  assert.equal((await prisma.tonhubPaymentInvoice.findUniqueOrThrow({ where: { id: invoiceId } })).creditedFiatMicros, "700000");
  await prisma.tonhubPaymentInvoice.update({
    where: { id: invoiceId },
    data: { status: "PAID", creditedFiatMicros: "1000000", remainingFiatMicros: "0", observedAt: new Date(base.getTime() + 1_000), version: { increment: 1 } },
  });
  await prisma.tonhubPaymentInvoice.update({
    where: { id: expiredInvoiceId },
    data: { status: "EXPIRED", observedAt: new Date(base.getTime() + 2_000), version: { increment: 1 } },
  });

  const recoveryId = `webhook-recovery-${suffix}`;
  await prisma.tonhubRecoveryCase.create({
    data: { id: recoveryId, orderId, invoiceId, reason: "WEBHOOK_REHEARSAL", title: "Webhook rehearsal recovery" },
  });
  await prisma.tonhubRecoveryCase.update({ where: { id: recoveryId }, data: { status: "REVIEWED" } });
  await prisma.tonhubRecoveryCase.update({ where: { id: recoveryId }, data: { status: "OPEN" } });
  const sweep = await prisma.tonhubAssetSweep.create({
    data: {
      idempotencyKey: `webhook-sweep-${suffix}`,
      depositAddressId: depositId,
      orderId,
      invoiceId,
      asset: "USDT",
      assetKind: "JETTON",
    },
  });
  await prisma.tonhubAssetSweep.update({
    where: { id: sweep.id },
    data: { status: "FAILED", attempts: 1, lastError: "provider timeout" },
  });
  await prisma.tonhubDepositAddress.update({
    where: { id: depositId },
    data: { sweepStatus: "FAILED", sweepAttempts: 1, sweepLastError: "native timeout" },
  });

  const aggregateIds = [invoiceId, expiredInvoiceId, recoveryId, sweep.id, depositId];
  const events = await prisma.tonhubOutboxEvent.findMany({
    where: { aggregateId: { in: aggregateIds } },
    orderBy: { createdAt: "asc" },
  });
  assert.deepEqual(events.map((event) => event.topic).sort(), [
    "invoice.expired",
    "invoice.paid",
    "invoice.partial",
    "invoice.partial",
    "recovery.opened",
    "recovery.opened",
    "sweep.failed",
    "sweep.failed",
  ]);
  assert.equal(new Set(events.map((event) => event.eventId)).size, events.length);
  assert.equal(events.some((event) => (
    event.topic === "invoice.partial" && (event.payload as any).creditedFiatMicros === "800000"
  )), false);

  const repository = createPrismaWebhookRepository(prisma as any);
  const partialEvent = events.find((event) => event.topic === "invoice.partial")!;
  await prisma.$executeRaw`
    SELECT "tonhub_enqueue_webhook_event"(
      ${partialEvent.eventId}, ${partialEvent.topic}, ${partialEvent.aggregateType},
      ${partialEvent.aggregateId}, ${partialEvent.payload}::jsonb
    )
  `;
  await assert.rejects(prisma.$executeRaw`
    SELECT "tonhub_enqueue_webhook_event"(
      ${partialEvent.eventId}, ${partialEvent.topic}, ${partialEvent.aggregateType},
      ${partialEvent.aggregateId}, ${{ schemaVersion: 1, conflicting: true }}::jsonb
    )
  `);
  await assert.rejects(prisma.tonhubOutboxEvent.update({
    where: { id: partialEvent.id },
    data: { payload: { schemaVersion: 1, rewritten: true } },
  }));
  await assert.rejects(prisma.tonhubOutboxEvent.delete({ where: { id: partialEvent.id } }));
  const now = new Date(partialEvent.availableAt.getTime() + 1);
  const [first, loser] = await Promise.all([
    repository.claim({ eventId: partialEvent.id, leaseOwner: "worker-a", webhookUrl: "https://merchant.example/hook", requestTimestamp: "1786623000", now, leaseMs: 60_000 }),
    repository.claim({ eventId: partialEvent.id, leaseOwner: "worker-b", webhookUrl: "https://merchant.example/hook", requestTimestamp: "1786623000", now, leaseMs: 60_000 }),
  ]);
  const claimed = first ?? loser;
  assert.ok(claimed);
  assert.equal(Boolean(first) === Boolean(loser), false);
  assert.equal(await prisma.tonhubWebhookDeliveryAttempt.count({ where: { outboxEventId: partialEvent.id } }), 1);

  const staleEvent = events.find((event) => event.topic === "invoice.partial" && event.id !== partialEvent.id)!;
  const staleNow = new Date(staleEvent.availableAt.getTime() + 1);
  const staleFirst = await repository.claim({
    eventId: staleEvent.id,
    leaseOwner: "same-worker",
    webhookUrl: "https://merchant.example/hook",
    requestTimestamp: "1786623000",
    now: staleNow,
    leaseMs: 10_000,
  });
  assert.ok(staleFirst);
  const staleSecond = await repository.claim({
    eventId: staleEvent.id,
    leaseOwner: "same-worker",
    webhookUrl: "https://merchant.example/hook",
    requestTimestamp: "1786623011",
    now: new Date(staleNow.getTime() + 10_001),
    leaseMs: 10_000,
  });
  assert.ok(staleSecond);
  await assert.rejects(repository.delivered({
    event: staleFirst!,
    httpStatus: 204,
    completedAt: new Date(staleNow.getTime() + 10_002),
    durationMs: 10_002,
  }), /lost its outbox lease/i);
  assert.equal((await prisma.tonhubOutboxEvent.findUniqueOrThrow({ where: { id: staleEvent.id } })).status, "DELIVERING");
  await repository.delivered({
    event: staleSecond!,
    httpStatus: 204,
    completedAt: new Date(staleNow.getTime() + 10_003),
    durationMs: 2,
  });
  await repository.failed({
    event: claimed!,
    httpStatus: 503,
    error: "HTTP 503",
    completedAt: new Date(now.getTime() + 20),
    durationMs: 20,
    retryAt: new Date(now.getTime() + 30_000),
  });
  const admin = createPrismaAdminRepository(prisma as any);
  await admin.retryWebhook({ adminUsername: "merchant", outboxEventId: partialEvent.id });
  const retry = await repository.claim({
    eventId: partialEvent.id,
    leaseOwner: "worker-c",
    webhookUrl: "https://merchant.example/hook",
    requestTimestamp: "1786623030",
    now: new Date(now.getTime() + 30_000),
    leaseMs: 60_000,
  });
  assert.ok(retry);
  await repository.delivered({
    event: retry!,
    httpStatus: 204,
    completedAt: new Date(now.getTime() + 30_010),
    durationMs: 10,
  });
  const attempts = await prisma.tonhubWebhookDeliveryAttempt.findMany({
    where: { outboxEventId: partialEvent.id },
    orderBy: { attemptNumber: "asc" },
  });
  assert.deepEqual(attempts.map((attempt) => attempt.status), ["FAILED", "DELIVERED"]);
  assert.equal((await prisma.tonhubOutboxEvent.findUniqueOrThrow({ where: { id: partialEvent.id } })).status, "DELIVERED");
  assert.equal(await prisma.tonhubAdminAuditEvent.count({
    where: { action: "WEBHOOK_RETRY_QUEUED", targetId: partialEvent.id },
  }), 1);
  await assert.rejects(prisma.tonhubWebhookDeliveryAttempt.update({
    where: { id: attempts[0].id },
    data: { error: "rewritten" },
  }));
  await assert.rejects(prisma.tonhubWebhookDeliveryAttempt.delete({ where: { id: attempts[0].id } }));
}

void main().finally(() => prisma.$disconnect());
