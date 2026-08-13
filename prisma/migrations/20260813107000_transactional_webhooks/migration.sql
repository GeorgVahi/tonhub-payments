CREATE TYPE "TonhubWebhookAttemptStatus" AS ENUM ('STARTED', 'DELIVERED', 'FAILED');

CREATE TABLE "TonhubWebhookDeliveryAttempt" (
    "id" TEXT NOT NULL,
    "outboxEventId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" "TonhubWebhookAttemptStatus" NOT NULL DEFAULT 'STARTED',
    "webhookUrl" TEXT NOT NULL,
    "requestTimestamp" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "error" TEXT,
    "durationMs" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "TonhubWebhookDeliveryAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TonhubWebhookDeliveryAttempt_outboxEventId_attemptNumber_key"
ON "TonhubWebhookDeliveryAttempt"("outboxEventId", "attemptNumber");
CREATE INDEX "TonhubWebhookDeliveryAttempt_status_startedAt_idx"
ON "TonhubWebhookDeliveryAttempt"("status", "startedAt");
CREATE INDEX "TonhubWebhookDeliveryAttempt_outboxEventId_startedAt_idx"
ON "TonhubWebhookDeliveryAttempt"("outboxEventId", "startedAt");

ALTER TABLE "TonhubWebhookDeliveryAttempt"
ADD CONSTRAINT "TonhubWebhookDeliveryAttempt_outboxEventId_fkey"
FOREIGN KEY ("outboxEventId") REFERENCES "TonhubOutboxEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TonhubWebhookDeliveryAttempt"
ADD CONSTRAINT "TonhubWebhookDeliveryAttempt_values_check" CHECK (
  "attemptNumber" > 0 AND
  LENGTH("webhookUrl") > 0 AND
  "requestTimestamp" ~ '^[0-9]{1,20}$' AND
  ("httpStatus" IS NULL OR "httpStatus" BETWEEN 100 AND 599) AND
  ("durationMs" IS NULL OR "durationMs" >= 0) AND
  (
    ("status" = 'STARTED' AND "completedAt" IS NULL AND "httpStatus" IS NULL AND "error" IS NULL AND "durationMs" IS NULL) OR
    ("status" = 'DELIVERED' AND "completedAt" IS NOT NULL AND "httpStatus" BETWEEN 200 AND 299 AND "error" IS NULL AND "durationMs" IS NOT NULL) OR
    ("status" = 'FAILED' AND "completedAt" IS NOT NULL AND "error" IS NOT NULL AND "durationMs" IS NOT NULL)
  )
);

ALTER TABLE "TonhubOutboxEvent"
ADD CONSTRAINT "TonhubOutboxEvent_delivery_state_check" CHECK (
  "attempts" >= 0 AND
  "topic" IN ('invoice.partial', 'invoice.paid', 'invoice.expired', 'recovery.opened', 'sweep.failed') AND
  jsonb_typeof("payload") = 'object' AND
  (
    ("status" = 'DELIVERING' AND "leaseOwner" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL AND "deliveredAt" IS NULL) OR
    ("status" = 'DELIVERED' AND "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL AND "deliveredAt" IS NOT NULL) OR
    ("status" IN ('PENDING', 'FAILED') AND "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL AND "deliveredAt" IS NULL)
  )
);

CREATE FUNCTION "tonhub_guard_outbox_event_update"() RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR
     NEW."eventId" IS DISTINCT FROM OLD."eventId" OR
     NEW."topic" IS DISTINCT FROM OLD."topic" OR
     NEW."aggregateType" IS DISTINCT FROM OLD."aggregateType" OR
     NEW."aggregateId" IS DISTINCT FROM OLD."aggregateId" OR
     NEW."payload" IS DISTINCT FROM OLD."payload" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'webhook outbox event identity and content are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TonhubOutboxEvent_guard_update"
BEFORE UPDATE ON "TonhubOutboxEvent"
FOR EACH ROW EXECUTE FUNCTION "tonhub_guard_outbox_event_update"();
CREATE TRIGGER "TonhubOutboxEvent_no_delete"
BEFORE DELETE ON "TonhubOutboxEvent"
FOR EACH ROW EXECUTE FUNCTION "tonhub_reject_immutable_row_change"();
CREATE TRIGGER "TonhubOutboxEvent_no_truncate"
BEFORE TRUNCATE ON "TonhubOutboxEvent"
FOR EACH STATEMENT EXECUTE FUNCTION "tonhub_reject_immutable_row_change"();

CREATE FUNCTION "tonhub_guard_webhook_attempt_update"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'STARTED' OR NEW."status" NOT IN ('DELIVERED', 'FAILED') OR
     NEW."id" IS DISTINCT FROM OLD."id" OR
     NEW."outboxEventId" IS DISTINCT FROM OLD."outboxEventId" OR
     NEW."attemptNumber" IS DISTINCT FROM OLD."attemptNumber" OR
     NEW."webhookUrl" IS DISTINCT FROM OLD."webhookUrl" OR
     NEW."requestTimestamp" IS DISTINCT FROM OLD."requestTimestamp" OR
     NEW."startedAt" IS DISTINCT FROM OLD."startedAt" THEN
    RAISE EXCEPTION 'webhook delivery attempt evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TonhubWebhookDeliveryAttempt_guard_update"
BEFORE UPDATE ON "TonhubWebhookDeliveryAttempt"
FOR EACH ROW EXECUTE FUNCTION "tonhub_guard_webhook_attempt_update"();
CREATE TRIGGER "TonhubWebhookDeliveryAttempt_no_delete"
BEFORE DELETE ON "TonhubWebhookDeliveryAttempt"
FOR EACH ROW EXECUTE FUNCTION "tonhub_reject_immutable_row_change"();
CREATE TRIGGER "TonhubWebhookDeliveryAttempt_no_truncate"
BEFORE TRUNCATE ON "TonhubWebhookDeliveryAttempt"
FOR EACH STATEMENT EXECUTE FUNCTION "tonhub_reject_immutable_row_change"();

CREATE FUNCTION "tonhub_enqueue_webhook_event"(
  event_id TEXT,
  event_topic TEXT,
  aggregate_type TEXT,
  aggregate_id TEXT,
  event_payload JSONB
) RETURNS void AS $$
DECLARE
  inserted_count INTEGER;
  stored "TonhubOutboxEvent"%ROWTYPE;
BEGIN
  INSERT INTO "TonhubOutboxEvent" (
    "id", "eventId", "topic", "aggregateType", "aggregateId", "payload",
    "status", "attempts", "availableAt", "createdAt", "updatedAt"
  ) VALUES (
    event_id, event_id, event_topic, aggregate_type, aggregate_id, event_payload,
    'PENDING', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ) ON CONFLICT ("eventId") DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count = 0 THEN
    SELECT * INTO stored FROM "TonhubOutboxEvent" WHERE "eventId" = event_id;
    IF NOT FOUND OR stored."id" IS DISTINCT FROM event_id OR
       stored."topic" IS DISTINCT FROM event_topic OR
       stored."aggregateType" IS DISTINCT FROM aggregate_type OR
       stored."aggregateId" IS DISTINCT FROM aggregate_id OR
       stored."payload" IS DISTINCT FROM event_payload THEN
      RAISE EXCEPTION 'conflicting webhook outbox event identity: %', event_id;
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "tonhub_invoice_webhook_outbox"() RETURNS trigger AS $$
DECLARE
  topic_name TEXT;
  event_key TEXT;
BEGIN
  IF NEW."status" = 'PARTIAL' AND (
    OLD."status" IS DISTINCT FROM NEW."status" OR
    OLD."creditedFiatMicros" IS DISTINCT FROM NEW."creditedFiatMicros"
  ) THEN
    topic_name := 'invoice.partial';
  ELSIF NEW."status" = 'PAID' AND OLD."status" IS DISTINCT FROM 'PAID' THEN
    topic_name := 'invoice.paid';
  ELSIF NEW."status" = 'EXPIRED' AND OLD."status" IS DISTINCT FROM 'EXPIRED' THEN
    topic_name := 'invoice.expired';
  ELSE
    RETURN NEW;
  END IF;
  event_key := topic_name || ':' || NEW."id" || ':' || NEW."version"::TEXT || ':' || txid_current()::TEXT;
  PERFORM "tonhub_enqueue_webhook_event"(
    event_key,
    topic_name,
    'TonhubPaymentInvoice',
    NEW."id",
    jsonb_build_object(
      'schemaVersion', 1,
      'invoiceId', NEW."id",
      'orderId', NEW."orderId",
      'externalId', (SELECT "externalId" FROM "TonhubPaymentOrder" WHERE "id" = NEW."orderId"),
      'status', NEW."status",
      'network', NEW."network",
      'asset', NEW."checkoutAsset",
      'assetKind', NEW."assetKind",
      'assetDecimals', NEW."assetDecimals",
      'fiatCurrency', NEW."fiatCurrency",
      'fiatAmountMicros', NEW."fiatAmountMicros",
      'creditedFiatMicros', NEW."creditedFiatMicros",
      'remainingFiatMicros', NEW."remainingFiatMicros",
      'occurredAt', COALESCE(NEW."observedAt", NEW."updatedAt", CURRENT_TIMESTAMP)
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TonhubPaymentInvoice_webhook_outbox"
AFTER UPDATE ON "TonhubPaymentInvoice"
FOR EACH ROW EXECUTE FUNCTION "tonhub_invoice_webhook_outbox"();

CREATE FUNCTION "tonhub_recovery_webhook_outbox"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'OPEN' AND (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM 'OPEN') THEN
    PERFORM "tonhub_enqueue_webhook_event"(
      'recovery.opened:' || NEW."id" || ':' || txid_current()::TEXT,
      'recovery.opened',
      'TonhubRecoveryCase',
      NEW."id",
      jsonb_build_object(
        'schemaVersion', 1,
        'recoveryId', NEW."id",
        'movementId', NEW."movementId",
        'orderId', NEW."orderId",
        'invoiceId', NEW."invoiceId",
        'reason', NEW."reason",
        'title', NEW."title",
        'occurredAt', NEW."createdAt"
      )
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TonhubRecoveryCase_webhook_outbox"
AFTER INSERT OR UPDATE ON "TonhubRecoveryCase"
FOR EACH ROW EXECUTE FUNCTION "tonhub_recovery_webhook_outbox"();

CREATE FUNCTION "tonhub_asset_sweep_webhook_outbox"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'FAILED' AND OLD."status" IS DISTINCT FROM 'FAILED' THEN
    PERFORM "tonhub_enqueue_webhook_event"(
      'sweep.failed:asset:' || NEW."id" || ':' || txid_current()::TEXT,
      'sweep.failed',
      'TonhubAssetSweep',
      NEW."id",
      jsonb_build_object(
        'schemaVersion', 1,
        'sweepId', NEW."id",
        'depositAddressId', NEW."depositAddressId",
        'orderId', NEW."orderId",
        'invoiceId', NEW."invoiceId",
        'asset', NEW."asset",
        'assetKind', NEW."assetKind",
        'attempts', NEW."attempts",
        'error', NEW."lastError",
        'occurredAt', NEW."updatedAt"
      )
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TonhubAssetSweep_webhook_outbox"
AFTER UPDATE ON "TonhubAssetSweep"
FOR EACH ROW EXECUTE FUNCTION "tonhub_asset_sweep_webhook_outbox"();

CREATE FUNCTION "tonhub_native_sweep_webhook_outbox"() RETURNS trigger AS $$
BEGIN
  IF NEW."sweepStatus" = 'FAILED' AND OLD."sweepStatus" IS DISTINCT FROM 'FAILED' THEN
    PERFORM "tonhub_enqueue_webhook_event"(
      'sweep.failed:native:' || NEW."id" || ':' || txid_current()::TEXT,
      'sweep.failed',
      'TonhubDepositAddress',
      NEW."id",
      jsonb_build_object(
        'schemaVersion', 1,
        'sweepId', 'native:' || NEW."id",
        'depositAddressId', NEW."id",
        'invoiceId', NEW."invoiceId",
        'asset', 'GRAM',
        'assetKind', 'NATIVE',
        'attempts', NEW."sweepAttempts",
        'error', NEW."sweepLastError",
        'occurredAt', NEW."updatedAt"
      )
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TonhubDepositAddress_native_sweep_webhook_outbox"
AFTER UPDATE ON "TonhubDepositAddress"
FOR EACH ROW EXECUTE FUNCTION "tonhub_native_sweep_webhook_outbox"();
