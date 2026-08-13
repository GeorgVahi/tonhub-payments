import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { prisma } from "../../backend/src/db";

const maxStoredWebhookErrorLength = 1_000;

export type WebhookConfig = {
  url: string;
  secret: string;
  timeoutMs: number;
  leaseMs: number;
  baseRetryMs: number;
  maxRetryMs: number;
};

export type WebhookEventRecord = {
  id: string;
  eventId: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  attempts: number;
  createdAt: Date;
};

export type ClaimedWebhookEvent = WebhookEventRecord & {
  leaseOwner: string;
  attemptId: string;
  requestTimestamp: string;
};

export type WebhookRepository = {
  listDue: (input: { now: Date; limit: number }) => Promise<WebhookEventRecord[]>;
  claim: (input: {
    eventId: string;
    leaseOwner: string;
    webhookUrl: string;
    requestTimestamp: string;
    now: Date;
    leaseMs: number;
  }) => Promise<ClaimedWebhookEvent | null>;
  delivered: (input: {
    event: ClaimedWebhookEvent;
    httpStatus: number;
    completedAt: Date;
    durationMs: number;
  }) => Promise<void>;
  failed: (input: {
    event: ClaimedWebhookEvent;
    httpStatus: number | null;
    error: string;
    completedAt: Date;
    durationMs: number;
    retryAt: Date;
  }) => Promise<void>;
};

function integerEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

export function resolveWebhookConfig(
  env: Record<string, string | undefined> = process.env,
): WebhookConfig | null {
  const urlValue = env.TONHUB_WEBHOOK_URL?.trim();
  const secret = env.TONHUB_WEBHOOK_SECRET;
  if (!urlValue && !secret?.trim()) return null;
  if (!urlValue || !secret?.trim()) {
    throw new Error("TONHUB_WEBHOOK_URL and TONHUB_WEBHOOK_SECRET must be set together.");
  }
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new Error("TONHUB_WEBHOOK_URL must be a valid HTTPS URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username || url.password || url.hash || url.search ||
    urlValue.length > 2_048
  ) {
    throw new Error("TONHUB_WEBHOOK_URL must be an HTTPS URL without credentials, query parameters, or a fragment.");
  }
  if (Buffer.byteLength(secret, "utf8") < 32 || Buffer.byteLength(secret, "utf8") > 4_096) {
    throw new Error("TONHUB_WEBHOOK_SECRET must contain between 32 and 4096 UTF-8 bytes.");
  }
  const baseRetryMs = integerEnv(env, "TONHUB_WEBHOOK_BASE_RETRY_SECONDS", 30, 1, 86_400) * 1_000;
  const maxRetryMs = integerEnv(env, "TONHUB_WEBHOOK_MAX_RETRY_SECONDS", 86_400, 1, 7 * 86_400) * 1_000;
  if (maxRetryMs < baseRetryMs) {
    throw new Error("TONHUB_WEBHOOK_MAX_RETRY_SECONDS cannot be below the base retry interval.");
  }
  const timeoutMs = integerEnv(env, "TONHUB_WEBHOOK_TIMEOUT_SECONDS", 10, 1, 120) * 1_000;
  const leaseMs = integerEnv(env, "TONHUB_WEBHOOK_LEASE_SECONDS", 60, 10, 3_600) * 1_000;
  if (leaseMs <= timeoutMs + 5_000) {
    throw new Error("TONHUB_WEBHOOK_LEASE_SECONDS must exceed the HTTP timeout by more than 5 seconds.");
  }
  return {
    url: url.toString(),
    secret,
    timeoutMs,
    leaseMs,
    baseRetryMs,
    maxRetryMs,
  };
}

export function webhookBody(event: WebhookEventRecord) {
  return JSON.stringify({
    id: event.eventId,
    type: event.topic,
    createdAt: event.createdAt.toISOString(),
    data: event.payload,
  });
}

export function webhookSignature(input: { timestamp: string; body: string; secret: string }) {
  return `v1=${createHmac("sha256", input.secret)
    .update(`${input.timestamp}.${input.body}`)
    .digest("hex")}`;
}

export function verifyWebhookSignature(input: {
  timestamp: string;
  body: string;
  secret: string;
  signature: string;
}) {
  const expected = Buffer.from(webhookSignature(input), "utf8");
  const actual = Buffer.from(input.signature, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function webhookRetryDelayMs(input: {
  attempt: number;
  eventId: string;
  baseRetryMs: number;
  maxRetryMs: number;
}) {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new Error("Webhook attempt must be a positive integer.");
  }
  const exponent = Math.min(input.attempt - 1, 30);
  const exponential = Math.min(input.maxRetryMs, input.baseRetryMs * 2 ** exponent);
  const jitterUnit = createHash("sha256").update(`${input.eventId}:${input.attempt}`).digest().readUInt16BE(0) / 65_535;
  return Math.min(input.maxRetryMs, Math.floor(exponential * (0.9 + jitterUnit * 0.2)));
}

function normalizeEvent(value: any): WebhookEventRecord {
  if (
    !value || typeof value.id !== "string" || typeof value.eventId !== "string" ||
    typeof value.topic !== "string" || typeof value.aggregateType !== "string" ||
    typeof value.aggregateId !== "string" || !Number.isSafeInteger(value.attempts) ||
    !(value.createdAt instanceof Date)
  ) {
    throw new Error("Webhook outbox event is malformed.");
  }
  return {
    id: value.id,
    eventId: value.eventId,
    topic: value.topic,
    aggregateType: value.aggregateType,
    aggregateId: value.aggregateId,
    payload: value.payload,
    attempts: value.attempts,
    createdAt: value.createdAt,
  };
}

type PrismaWebhookDb = {
  $transaction: <T>(handler: (tx: any) => Promise<T>) => Promise<T>;
  tonhubOutboxEvent: any;
};

export function createPrismaWebhookRepository(db: PrismaWebhookDb): WebhookRepository {
  return {
    listDue: async ({ now, limit }) => (await db.tonhubOutboxEvent.findMany({
      where: {
        OR: [
          { status: { in: ["PENDING", "FAILED"] }, availableAt: { lte: now } },
          { status: "DELIVERING", leaseExpiresAt: { lte: now } },
        ],
      },
      orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: limit,
    })).map(normalizeEvent),
    claim: async (input) => db.$transaction(async (tx) => {
      const claimed = await tx.tonhubOutboxEvent.updateMany({
        where: {
          id: input.eventId,
          OR: [
            { status: { in: ["PENDING", "FAILED"] }, availableAt: { lte: input.now } },
            { status: "DELIVERING", leaseExpiresAt: { lte: input.now } },
          ],
        },
        data: {
          status: "DELIVERING",
          attempts: { increment: 1 },
          leaseOwner: input.leaseOwner,
          leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
          lastError: null,
        },
      });
      if (claimed.count !== 1) return null;
      const stored = await tx.tonhubOutboxEvent.findUnique({ where: { id: input.eventId } });
      const event = normalizeEvent(stored);
      const attemptId = `${event.eventId}:${event.attempts}`;
      await tx.tonhubWebhookDeliveryAttempt.create({
        data: {
          id: attemptId,
          outboxEventId: event.id,
          attemptNumber: event.attempts,
          webhookUrl: input.webhookUrl,
          requestTimestamp: input.requestTimestamp,
          startedAt: input.now,
        },
      });
      return { ...event, leaseOwner: input.leaseOwner, attemptId, requestTimestamp: input.requestTimestamp };
    }),
    delivered: async (input) => db.$transaction(async (tx) => {
      const completed = await tx.tonhubOutboxEvent.updateMany({
        where: {
          id: input.event.id,
          status: "DELIVERING",
          leaseOwner: input.event.leaseOwner,
          attempts: input.event.attempts,
        },
        data: {
          status: "DELIVERED",
          deliveredAt: input.completedAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: null,
        },
      });
      if (completed.count !== 1) throw new Error("Webhook delivery lost its outbox lease.");
      const journaled = await tx.tonhubWebhookDeliveryAttempt.updateMany({
        where: { id: input.event.attemptId, status: "STARTED" },
        data: {
          status: "DELIVERED",
          httpStatus: input.httpStatus,
          durationMs: input.durationMs,
          completedAt: input.completedAt,
        },
      });
      if (journaled.count !== 1) throw new Error("Webhook delivery attempt journal is inconsistent.");
    }),
    failed: async (input) => db.$transaction(async (tx) => {
      const failed = await tx.tonhubOutboxEvent.updateMany({
        where: {
          id: input.event.id,
          status: "DELIVERING",
          leaseOwner: input.event.leaseOwner,
          attempts: input.event.attempts,
        },
        data: {
          status: "FAILED",
          availableAt: input.retryAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: input.error.slice(0, maxStoredWebhookErrorLength),
        },
      });
      if (failed.count !== 1) throw new Error("Webhook failure lost its outbox lease.");
      const journaled = await tx.tonhubWebhookDeliveryAttempt.updateMany({
        where: { id: input.event.attemptId, status: "STARTED" },
        data: {
          status: "FAILED",
          httpStatus: input.httpStatus,
          error: input.error.slice(0, maxStoredWebhookErrorLength),
          durationMs: input.durationMs,
          completedAt: input.completedAt,
        },
      });
      if (journaled.count !== 1) throw new Error("Webhook failure attempt journal is inconsistent.");
    }),
  };
}

export const prismaWebhookRepository = createPrismaWebhookRepository(prisma as any);

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function deliverWebhookEvent(input: {
  event: WebhookEventRecord;
  config: WebhookConfig;
  repository?: WebhookRepository;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  workerId?: string;
}) {
  const repository = input.repository ?? prismaWebhookRepository;
  const fetchImpl = input.fetchImpl ?? fetch;
  const clock = input.now ?? (() => new Date());
  const startedAt = clock();
  const leaseOwner = `${input.workerId ?? `webhook-${process.pid}`}:${randomUUID()}`;
  const requestTimestamp = Math.floor(startedAt.getTime() / 1_000).toString();
  const claimed = await repository.claim({
    eventId: input.event.id,
    leaseOwner,
    webhookUrl: input.config.url,
    requestTimestamp,
    now: startedAt,
    leaseMs: input.config.leaseMs,
  });
  if (!claimed) return { eventId: input.event.eventId, status: "claimed-by-other" as const };
  const body = webhookBody(claimed);
  const signature = webhookSignature({ timestamp: requestTimestamp, body, secret: input.config.secret });
  let httpStatus: number | null = null;
  try {
    const response = await fetchImpl(input.config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "tonhub-payments-webhooks/1",
        "x-tonhub-event-id": claimed.eventId,
        "x-tonhub-delivery-attempt": String(claimed.attempts),
        "x-tonhub-timestamp": requestTimestamp,
        "x-tonhub-signature": signature,
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(input.config.timeoutMs),
    });
    httpStatus = response.status;
    await response.body?.cancel().catch(() => undefined);
    if (response.status < 200 || response.status > 299) {
      throw new Error(`Webhook endpoint returned HTTP ${response.status}.`);
    }
    const completedAt = clock();
    await repository.delivered({
      event: claimed,
      httpStatus: response.status,
      completedAt,
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
    });
    return { eventId: claimed.eventId, status: "delivered" as const, httpStatus };
  } catch (error) {
    const completedAt = clock();
    const message = errorText(error).slice(0, maxStoredWebhookErrorLength);
    const retryAt = new Date(completedAt.getTime() + webhookRetryDelayMs({
      attempt: claimed.attempts,
      eventId: claimed.eventId,
      baseRetryMs: input.config.baseRetryMs,
      maxRetryMs: input.config.maxRetryMs,
    }));
    await repository.failed({
      event: claimed,
      httpStatus,
      error: message,
      completedAt,
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      retryAt,
    });
    return { eventId: claimed.eventId, status: "failed" as const, httpStatus, error: message, retryAt };
  }
}

export async function runWebhookBatch(input: {
  config: WebhookConfig;
  repository?: WebhookRepository;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  workerId?: string;
  limit?: number;
}) {
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Webhook batch limit must be between 1 and 1000.");
  }
  const repository = input.repository ?? prismaWebhookRepository;
  const clock = input.now ?? (() => new Date());
  const candidates = await repository.listDue({ now: clock(), limit });
  const outcomes = [];
  for (const event of candidates) {
    try {
      outcomes.push(await deliverWebhookEvent({ ...input, event, repository, now: clock }));
    } catch (error) {
      outcomes.push({ eventId: event.eventId, status: "worker-error" as const, error: errorText(error) });
    }
  }
  return { candidates: candidates.length, outcomes };
}
