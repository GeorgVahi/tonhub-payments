import assert from "node:assert/strict";
import test from "node:test";
import {
  deliverWebhookEvent,
  resolveWebhookConfig,
  runWebhookBatch,
  verifyWebhookSignature,
  webhookRetryDelayMs,
  type ClaimedWebhookEvent,
  type WebhookConfig,
  type WebhookEventRecord,
  type WebhookRepository,
} from "../worker/src/webhooks";

const event = (): WebhookEventRecord => ({
  id: "invoice.partial:invoice-1:2",
  eventId: "invoice.partial:invoice-1:2",
  topic: "invoice.partial",
  aggregateType: "TonhubPaymentInvoice",
  aggregateId: "invoice-1",
  payload: { schemaVersion: 1, orderId: "order-1", creditedFiatMicros: "500000" },
  attempts: 0,
  createdAt: new Date("2026-08-13T10:00:00.000Z"),
});

const config = (): WebhookConfig => ({
  url: "https://merchant.example/webhooks/tonhub",
  secret: "s".repeat(32),
  timeoutMs: 10_000,
  leaseMs: 60_000,
  baseRetryMs: 30_000,
  maxRetryMs: 86_400_000,
});

function harness(events = [event()]) {
  const states = new Map(events.map((value) => [value.id, { ...value, status: "PENDING" }]));
  const attempts: any[] = [];
  const repository: WebhookRepository = {
    listDue: async () => [...states.values()].filter((value) => value.status !== "DELIVERED"),
    claim: async (input) => {
      const stored = states.get(input.eventId);
      if (!stored || stored.status === "DELIVERING" || stored.status === "DELIVERED") return null;
      stored.status = "DELIVERING";
      stored.attempts += 1;
      const claimed: ClaimedWebhookEvent = {
        ...stored,
        leaseOwner: input.leaseOwner,
        attemptId: `${stored.eventId}:${stored.attempts}`,
        requestTimestamp: input.requestTimestamp,
      };
      attempts.push({ id: claimed.attemptId, status: "STARTED" });
      return claimed;
    },
    delivered: async (input) => {
      const stored = states.get(input.event.id)!;
      stored.status = "DELIVERED";
      attempts.at(-1).status = "DELIVERED";
      attempts.at(-1).httpStatus = input.httpStatus;
    },
    failed: async (input) => {
      const stored = states.get(input.event.id)!;
      stored.status = "FAILED";
      attempts.at(-1).status = "FAILED";
      attempts.at(-1).httpStatus = input.httpStatus;
      attempts.at(-1).retryAt = input.retryAt;
      attempts.at(-1).error = input.error;
    },
  };
  return { repository, states, attempts };
}

test("webhook config is global, HTTPS-only, all-or-nothing, and secret-bounded", () => {
  assert.equal(resolveWebhookConfig({}), null);
  assert.throws(() => resolveWebhookConfig({ TONHUB_WEBHOOK_URL: "https://merchant.example/hook" }), /set together/i);
  assert.throws(() => resolveWebhookConfig({
    TONHUB_WEBHOOK_URL: "http://merchant.example/hook",
    TONHUB_WEBHOOK_SECRET: "s".repeat(32),
  }), /HTTPS URL/i);
  assert.throws(() => resolveWebhookConfig({
    TONHUB_WEBHOOK_URL: "https://user:pass@merchant.example/hook",
    TONHUB_WEBHOOK_SECRET: "s".repeat(32),
  }), /without credentials/i);
  assert.throws(() => resolveWebhookConfig({
    TONHUB_WEBHOOK_URL: "https://merchant.example/hook?token=secret",
    TONHUB_WEBHOOK_SECRET: "s".repeat(32),
  }), /query parameters/i);
  assert.throws(() => resolveWebhookConfig({
    TONHUB_WEBHOOK_URL: "https://merchant.example/hook",
    TONHUB_WEBHOOK_SECRET: "short",
  }), /between 32 and 4096/i);
  assert.throws(() => resolveWebhookConfig({
    TONHUB_WEBHOOK_URL: "https://merchant.example/hook",
    TONHUB_WEBHOOK_SECRET: " ".repeat(32),
  }), /set together/i);
  assert.throws(() => resolveWebhookConfig({
    TONHUB_WEBHOOK_URL: "https://merchant.example/hook",
    TONHUB_WEBHOOK_SECRET: "s".repeat(32),
    TONHUB_WEBHOOK_TIMEOUT_SECONDS: "10",
    TONHUB_WEBHOOK_LEASE_SECONDS: "15",
  }), /exceed the HTTP timeout by more than 5 seconds/i);
  assert.equal(resolveWebhookConfig({
    TONHUB_WEBHOOK_URL: "https://merchant.example/hook",
    TONHUB_WEBHOOK_SECRET: "s".repeat(32),
    TONHUB_WEBHOOK_TIMEOUT_SECONDS: "10",
    TONHUB_WEBHOOK_LEASE_SECONDS: "16",
  })?.leaseMs, 16_000);
  assert.equal(resolveWebhookConfig({
    TONHUB_WEBHOOK_URL: "https://merchant.example/hook",
    TONHUB_WEBHOOK_SECRET: "s".repeat(32),
  })?.url, "https://merchant.example/hook");
});

test("delivery signs the exact JSON body and marks success only after a 2xx response", async () => {
  const state = harness();
  let requestBody = "";
  const outcome = await deliverWebhookEvent({
    event: event(),
    config: config(),
    repository: state.repository,
    workerId: "worker-1",
    now: (() => {
      const values = [new Date("2026-08-13T10:01:00.100Z"), new Date("2026-08-13T10:01:00.125Z")];
      return () => values.shift() ?? values.at(-1)!;
    })(),
    fetchImpl: async (_url, init) => {
      requestBody = String(init?.body);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-tonhub-event-id"), event().eventId);
      assert.equal(headers.get("x-tonhub-delivery-attempt"), "1");
      assert.equal(headers.get("x-tonhub-timestamp"), "1786615260");
      assert.equal(init?.redirect, "error");
      assert.equal(verifyWebhookSignature({
        timestamp: headers.get("x-tonhub-timestamp")!,
        body: requestBody,
        secret: config().secret,
        signature: headers.get("x-tonhub-signature")!,
      }), true);
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(outcome.status, "delivered");
  assert.deepEqual(JSON.parse(requestBody), {
    id: event().eventId,
    type: "invoice.partial",
    createdAt: "2026-08-13T10:00:00.000Z",
    data: event().payload,
  });
  assert.equal(state.states.get(event().id)?.status, "DELIVERED");
  assert.deepEqual(state.attempts.map((value) => value.status), ["DELIVERED"]);
});

test("non-2xx delivery is journaled and scheduled with capped exponential backoff", async () => {
  const state = harness();
  const outcome = await deliverWebhookEvent({
    event: event(),
    config: config(),
    repository: state.repository,
    workerId: "worker-2",
    now: (() => {
      const values = [new Date("2026-08-13T10:01:00.000Z"), new Date("2026-08-13T10:01:00.040Z")];
      return () => values.shift() ?? values.at(-1)!;
    })(),
    fetchImpl: async () => new Response("do not persist me", { status: 503 }),
  });
  assert.equal(outcome.status, "failed");
  assert.equal(state.attempts[0].status, "FAILED");
  assert.equal(state.attempts[0].httpStatus, 503);
  assert.match(state.attempts[0].error, /HTTP 503/);
  const delay = state.attempts[0].retryAt.getTime() - new Date("2026-08-13T10:01:00.040Z").getTime();
  assert.ok(delay >= 27_000 && delay <= 33_000);
  assert.ok(webhookRetryDelayMs({ attempt: 100, eventId: "x", baseRetryMs: 30_000, maxRetryMs: 60_000 }) <= 60_000);
});

test("batch isolates one delivery failure so later events are still attempted", async () => {
  const second = { ...event(), id: "invoice.paid:invoice-2:3", eventId: "invoice.paid:invoice-2:3", topic: "invoice.paid" };
  const state = harness([event(), second]);
  let calls = 0;
  const result = await runWebhookBatch({
    config: config(),
    repository: state.repository,
    workerId: "worker-batch",
    now: () => new Date("2026-08-13T10:02:00.000Z"),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error("network down");
      return new Response(null, { status: 200 });
    },
  });
  assert.equal(result.candidates, 2);
  assert.deepEqual(result.outcomes.map((value) => value.status), ["failed", "delivered"]);
});
