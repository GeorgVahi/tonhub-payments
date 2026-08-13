-- Existing attempts are grandfathered so the allocation cutover never
-- retroactively rejects a partial accepted by the legacy state machine.
UPDATE "TonhubPaymentInvoice"
SET "activationThresholdFiatMicros" = '0'
WHERE "activationThresholdFiatMicros" IS NULL;

ALTER TABLE "TonhubDepositAddress"
ADD COLUMN "settlementNextAttemptAt" TIMESTAMP(3);

CREATE INDEX "TonhubDepositAddress_settlementNextAttemptAt_id_idx"
ON "TonhubDepositAddress"("settlementNextAttemptAt", "id");

ALTER TABLE "TonhubPaymentInvoice"
ADD CONSTRAINT "TonhubPaymentInvoice_activation_threshold_check" CHECK (
    "activationThresholdFiatMicros" IS NULL OR
    (
        "fiatAmountMicros" IS NOT NULL AND
        "activationThresholdFiatMicros"::NUMERIC <= "fiatAmountMicros"::NUMERIC
    )
);

CREATE FUNCTION "tonhub_guard_invoice_settlement_policy"() RETURNS trigger AS $$
BEGIN
    IF OLD."activationThresholdFiatMicros" IS NOT NULL AND
       NEW."activationThresholdFiatMicros" IS DISTINCT FROM OLD."activationThresholdFiatMicros" THEN
        RAISE EXCEPTION 'invoice activation threshold is immutable once assigned'
          USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TonhubPaymentInvoice_guard_settlement_policy"
BEFORE UPDATE ON "TonhubPaymentInvoice"
FOR EACH ROW EXECUTE FUNCTION "tonhub_guard_invoice_settlement_policy"();

-- A movement enters a particular recovery reason at most once. Repeated
-- worker/check retries return the original queue item instead of duplicating it.
CREATE UNIQUE INDEX "TonhubRecoveryCase_movement_reason_key"
ON "TonhubRecoveryCase"("movementId", "reason")
WHERE "movementId" IS NOT NULL;

-- The first CREDIT allocation of GRAM on an order is its immutable rate lock.
-- Lock the order row so direct SQL writers cannot race two different first rates.
CREATE FUNCTION "tonhub_enforce_gram_rate_lock"() RETURNS trigger AS $$
DECLARE
    movement_asset TEXT;
    movement_rate_id TEXT;
    locked_rate_id TEXT;
BEGIN
    IF NEW."kind" <> 'CREDIT' THEN
        RETURN NEW;
    END IF;

    PERFORM 1
    FROM "TonhubPaymentOrder"
    WHERE "id" = NEW."orderId"
    FOR UPDATE;

    SELECT "asset", "rateSnapshotId" INTO movement_asset, movement_rate_id
    FROM "TonhubPaymentMovement"
    WHERE "id" = NEW."movementId";

    IF movement_asset <> 'GRAM' THEN
        RETURN NEW;
    END IF;

    SELECT movement."rateSnapshotId" INTO locked_rate_id
    FROM "TonhubMovementAllocation" AS allocation
    JOIN "TonhubPaymentMovement" AS movement ON movement."id" = allocation."movementId"
    WHERE allocation."orderId" = NEW."orderId" AND
          allocation."kind" = 'CREDIT' AND
          movement."asset" = 'GRAM'
    ORDER BY allocation."allocatedAt" ASC, allocation."id" ASC
    LIMIT 1;

    IF locked_rate_id IS NOT NULL AND movement_rate_id IS DISTINCT FROM locked_rate_id THEN
        RAISE EXCEPTION 'GRAM credit must use the order locked rate snapshot'
          USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TonhubMovementAllocation_enforce_gram_rate_lock"
BEFORE INSERT ON "TonhubMovementAllocation"
FOR EACH ROW EXECUTE FUNCTION "tonhub_enforce_gram_rate_lock"();
