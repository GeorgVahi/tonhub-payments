-- Before cumulative activation existed, separate HELD GRAM movements on one
-- deposit could capture different market snapshots. They have no allocations
-- yet, so normalize that pending group to its earliest immutable rate before
-- the new runtime can promote it atomically. Preserve the replaced evidence in
-- an append-only resolved recovery record; the movement guard is disabled only
-- for this audited migration update and is restored in the same transaction.
CREATE TEMP TABLE tonhub_held_gram_rate_normalization ON COMMIT DROP AS
WITH ranked AS (
  SELECT
    movement."id",
    movement."depositAddressId",
    movement."rateSnapshotId",
    movement."fiatCreditMicros",
    FIRST_VALUE(movement."rateSnapshotId") OVER (
      PARTITION BY movement."depositAddressId"
      ORDER BY movement."blockchainAt" ASC,
        CASE WHEN movement."transactionLt" ~ '^[0-9]+$' THEN movement."transactionLt"::NUMERIC END ASC NULLS LAST,
        movement."transactionHash" ASC,
        movement."fingerprint" ASC
    ) AS earliest_rate_id
  FROM "TonhubPaymentMovement" movement
  WHERE movement."status" = 'HELD_UNDER_MINIMUM'
    AND movement."direction" = 'INCOMING'
    AND movement."asset" = 'GRAM'
    AND movement."assetKind" = 'NATIVE'
    AND movement."assetDecimals" = 9
    AND movement."depositAddressId" IS NOT NULL
    AND movement."rateSnapshotId" IS NOT NULL
    AND movement."fiatCreditMicros" IS NOT NULL
)
SELECT
  ranked."id" AS movement_id,
  ranked."rateSnapshotId" AS old_rate_id,
  ranked."fiatCreditMicros" AS old_fiat_credit_micros,
  ranked.earliest_rate_id AS new_rate_id,
  FLOOR(
    movement."amountAtomic"::NUMERIC * rate."price" * 1000000::NUMERIC /
    POWER(10::NUMERIC, movement."assetDecimals")
  )::TEXT AS new_fiat_credit_micros,
  invoice."orderId" AS order_id,
  invoice."id" AS invoice_id
FROM ranked
JOIN "TonhubPaymentMovement" movement ON movement."id" = ranked."id"
JOIN "TonhubRateSnapshot" rate ON rate."id" = ranked.earliest_rate_id
JOIN "TonhubDepositAddress" deposit ON deposit."id" = movement."depositAddressId"
JOIN "TonhubPaymentInvoice" invoice ON invoice."id" = deposit."invoiceId"
JOIN "TonhubPaymentOrder" payment_order ON payment_order."id" = invoice."orderId"
WHERE ranked."rateSnapshotId" IS DISTINCT FROM ranked.earliest_rate_id
  AND rate."asset" = 'GRAM'
  AND rate."baseCurrency" = 'GRAM'
  AND rate."quoteCurrency" = payment_order."fiatCurrency"
  AND rate."source" = 'coingecko';

INSERT INTO "TonhubRecoveryCase" (
  "id", "movementId", "orderId", "invoiceId", "reason", "status", "title",
  "details", "resolvedBy", "resolvedAt", "createdAt", "updatedAt"
)
SELECT
  'held-rate-normalization:' || normalization.movement_id,
  normalization.movement_id,
  normalization.order_id,
  normalization.invoice_id,
  'HELD_GRAM_RATE_NORMALIZED_DURING_ROLLOUT',
  'RESOLVED',
  'Pre-cumulative HELD GRAM rate normalized',
  jsonb_build_object(
    'oldRateSnapshotId', normalization.old_rate_id,
    'oldFiatCreditMicros', normalization.old_fiat_credit_micros,
    'newRateSnapshotId', normalization.new_rate_id,
    'newFiatCreditMicros', normalization.new_fiat_credit_micros
  ),
  'migration:20260814103000',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM tonhub_held_gram_rate_normalization normalization
ON CONFLICT DO NOTHING;

ALTER TABLE "TonhubPaymentMovement" DISABLE TRIGGER "TonhubPaymentMovement_append_only";
UPDATE "TonhubPaymentMovement" movement
SET "rateSnapshotId" = normalization.new_rate_id,
    "fiatCreditMicros" = normalization.new_fiat_credit_micros
FROM tonhub_held_gram_rate_normalization normalization
WHERE movement."id" = normalization.movement_id;
ALTER TABLE "TonhubPaymentMovement" ENABLE TRIGGER "TonhubPaymentMovement_append_only";

ALTER TABLE "TonhubAssetSweep"
ADD COLUMN "automaticSequence" INTEGER,
ADD COLUMN "triggerReason" TEXT,
ADD COLUMN "triggerFiatMicros" TEXT,
ADD COLUMN "triggerCreditedFiatMicros" TEXT,
ADD COLUMN "triggeredAt" TIMESTAMP(3);

ALTER TABLE "TonhubAssetSweep"
ADD CONSTRAINT "TonhubAssetSweep_automatic_trigger_shape_check" CHECK (
  (
    "automaticSequence" IS NULL AND
    "triggerReason" IS NULL AND
    "triggerFiatMicros" IS NULL AND
    "triggerCreditedFiatMicros" IS NULL AND
    "triggeredAt" IS NULL
  ) OR (
    "automaticSequence" BETWEEN 1 AND 2 AND
    "triggerReason" IN ('INTERMEDIATE_RATIO', 'INTERMEDIATE_VALUE', 'TERMINAL_PAID') AND
    "triggerFiatMicros" ~ '^[1-9][0-9]*$' AND
    "triggerCreditedFiatMicros" ~ '^[1-9][0-9]*$' AND
    "triggerFiatMicros"::NUMERIC <= "triggerCreditedFiatMicros"::NUMERIC AND
    "triggeredAt" IS NOT NULL AND
    "orderId" IS NOT NULL AND
    "invoiceId" IS NOT NULL AND
    (("asset" = 'GRAM' AND "assetKind" = 'NATIVE') OR
     ("asset" = 'USDT' AND "assetKind" = 'JETTON'))
  )
),
ADD CONSTRAINT "TonhubAssetSweep_automatic_gram_lifecycle_check" CHECK (
  "automaticSequence" IS NULL OR "asset" <> 'GRAM' OR (
    "assetKind" = 'NATIVE' AND
    (
      "status" <> 'QUEUED' OR (
        "amountAtomic" IS NULL AND "reserveAtomic" IS NULL AND
        "recipientAddress" IS NULL AND "seqno" IS NULL AND
        "sentAt" IS NULL AND "confirmedAt" IS NULL AND "transactionHash" IS NULL
      )
    ) AND
    (
      "status" NOT IN ('SENT', 'CONFIRMED') OR (
        "amountAtomic" ~ '^[1-9][0-9]*$' AND
        "reserveAtomic" ~ '^[0-9]+$' AND
        LENGTH("recipientAddress") > 0 AND
        "seqno" IS NOT NULL
      )
    ) AND
    ("status" <> 'SENT' OR "sentAt" IS NOT NULL) AND
    ("status" <> 'CONFIRMED' OR (
      "sentAt" IS NOT NULL AND "confirmedAt" IS NOT NULL AND
      "transactionHash" IS NOT NULL AND LENGTH("transactionHash") > 0
    ))
  )
);

CREATE UNIQUE INDEX "TonhubAssetSweep_orderId_asset_automaticSequence_key"
ON "TonhubAssetSweep"("orderId", "asset", "automaticSequence")
WHERE "automaticSequence" IS NOT NULL;

CREATE INDEX "TonhubAssetSweep_orderId_asset_automaticSequence_idx"
ON "TonhubAssetSweep"("orderId", "asset", "automaticSequence");

CREATE OR REPLACE FUNCTION tonhub_validate_automatic_asset_sweep()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  payment_order "TonhubPaymentOrder"%ROWTYPE;
  owning_invoice "TonhubPaymentInvoice"%ROWTYPE;
  owning_deposit "TonhubDepositAddress"%ROWTYPE;
  previous_sequence INTEGER;
  previous_credit NUMERIC;
  legacy_confirmed_at TIMESTAMP(3);
  asset_credit NUMERIC;
  total_credit NUMERIC;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."automaticSequence" IS NOT NULL THEN
      RAISE EXCEPTION 'automatic asset sweep evidence is append-only'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND ROW(
    OLD."id", OLD."idempotencyKey", OLD."createdAt",
    OLD."automaticSequence", OLD."triggerReason", OLD."triggerFiatMicros",
    OLD."triggerCreditedFiatMicros", OLD."triggeredAt", OLD."orderId",
    OLD."invoiceId", OLD."depositAddressId", OLD."asset", OLD."assetKind"
  ) IS DISTINCT FROM ROW(
    NEW."id", NEW."idempotencyKey", NEW."createdAt",
    NEW."automaticSequence", NEW."triggerReason", NEW."triggerFiatMicros",
    NEW."triggerCreditedFiatMicros", NEW."triggeredAt", NEW."orderId",
    NEW."invoiceId", NEW."depositAddressId", NEW."asset", NEW."assetKind"
  ) THEN
    RAISE EXCEPTION 'asset sweep ownership and automatic trigger evidence are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."automaticSequence" IS NOT NULL AND OLD."asset" = 'GRAM' THEN
    IF OLD."status" = 'READY' AND NEW."status" = 'SENT' AND (
      OLD."amountAtomic" IS NULL OR OLD."reserveAtomic" IS NULL OR
      OLD."recipientAddress" IS NULL OR OLD."seqno" IS NULL OR
      ROW(OLD."amountAtomic", OLD."reserveAtomic", OLD."recipientAddress", OLD."seqno")
        IS DISTINCT FROM
      ROW(NEW."amountAtomic", NEW."reserveAtomic", NEW."recipientAddress", NEW."seqno")
    ) THEN
      RAISE EXCEPTION 'GRAM sweep must persist its complete plan before broadcast'
        USING ERRCODE = '23514';
    END IF;
    IF OLD."status" IS DISTINCT FROM NEW."status" AND ROW(
      OLD."amountAtomic", OLD."reserveAtomic", OLD."recipientAddress", OLD."seqno",
      OLD."sentAt", OLD."confirmedAt", OLD."transactionHash"
    ) IS DISTINCT FROM ROW(
      NEW."amountAtomic", NEW."reserveAtomic", NEW."recipientAddress", NEW."seqno",
      NEW."sentAt", NEW."confirmedAt", NEW."transactionHash"
    ) AND NOT (OLD."status" = 'READY' AND NEW."status" = 'SENT') AND
      NOT (OLD."status" = 'SENT' AND NEW."status" = 'CONFIRMED') THEN
      RAISE EXCEPTION 'GRAM sweep transition cannot forge transfer evidence' USING ERRCODE = '55000';
    END IF;
    IF (
      OLD."amountAtomic" IS NOT NULL OR OLD."reserveAtomic" IS NOT NULL OR
      OLD."recipientAddress" IS NOT NULL OR OLD."seqno" IS NOT NULL
    ) AND ROW(
      OLD."amountAtomic", OLD."reserveAtomic", OLD."recipientAddress", OLD."seqno"
    ) IS DISTINCT FROM ROW(
      NEW."amountAtomic", NEW."reserveAtomic", NEW."recipientAddress", NEW."seqno"
    ) THEN
      RAISE EXCEPTION 'persisted GRAM sweep plan is immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD."sentAt" IS NOT NULL AND OLD."sentAt" IS DISTINCT FROM NEW."sentAt" THEN
      RAISE EXCEPTION 'GRAM sweep sent evidence is immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD."confirmedAt" IS NOT NULL AND OLD."confirmedAt" IS DISTINCT FROM NEW."confirmedAt" THEN
      RAISE EXCEPTION 'GRAM sweep confirmation evidence is immutable' USING ERRCODE = '55000';
    END IF;
    IF NOT (
      NEW."status" = OLD."status" OR
      (OLD."status" = 'QUEUED' AND NEW."status" IN ('READY', 'FAILED')) OR
      (OLD."status" = 'READY' AND NEW."status" IN ('SENT', 'FAILED')) OR
      (OLD."status" = 'SENT' AND NEW."status" IN ('CONFIRMED', 'FAILED')) OR
      (OLD."status" = 'FAILED' AND NEW."status" IN ('READY', 'SENT'))
    ) THEN
      RAISE EXCEPTION 'invalid automatic GRAM sweep lifecycle transition' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."automaticSequence" IS NOT NULL THEN
    IF OLD."transactionHash" IS NOT NULL AND
       OLD."transactionHash" IS DISTINCT FROM NEW."transactionHash" THEN
      RAISE EXCEPTION 'automatic sweep transaction hash is immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD."transactionHash" IS NULL AND NEW."transactionHash" IS NOT NULL AND NOT (
      OLD."status" = 'SENT' AND NEW."status" = 'CONFIRMED' AND NEW."confirmedAt" IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'automatic sweep transaction hash requires exact confirmation transition'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' OR NEW."automaticSequence" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."asset" = 'GRAM' AND NEW."status" <> 'QUEUED' THEN
    RAISE EXCEPTION 'automatic GRAM sweep must be inserted in QUEUED state' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" <> 'QUEUED' OR NEW."amountAtomic" IS NOT NULL OR
     NEW."reserveAtomic" IS NOT NULL OR NEW."recipientAddress" IS NOT NULL OR
     NEW."transactionHash" IS NOT NULL OR NEW."seqno" IS NOT NULL OR
     NEW."queryId" IS NOT NULL OR NEW."gasTopupAmountNano" IS NOT NULL OR
     NEW."gasServiceAddress" IS NOT NULL OR NEW."gasTopupSeqno" IS NOT NULL OR
     NEW."reserveTopupAmountNano" IS NOT NULL OR NEW."reserveTopupSeqno" IS NOT NULL OR
     NEW."gasServicePlanKey" IS NOT NULL OR NEW."gasTopupTransactionHash" IS NOT NULL OR
     NEW."attempts" <> 0 OR NEW."leaseOwner" IS NOT NULL OR NEW."leaseExpiresAt" IS NOT NULL OR
     NEW."startedAt" IS NOT NULL OR NEW."sentAt" IS NOT NULL OR
     NEW."confirmedAt" IS NOT NULL OR NEW."lastError" IS NOT NULL THEN
    RAISE EXCEPTION 'automatic sweep must be inserted as an unplanned QUEUED job'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO payment_order
  FROM "TonhubPaymentOrder"
  WHERE "id" = NEW."orderId"
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'automatic sweep order does not exist' USING ERRCODE = '23514';
  END IF;
  IF NEW."triggeredAt" < payment_order."createdAt" THEN
    RAISE EXCEPTION 'automatic sweep trigger predates its order' USING ERRCODE = '23514';
  END IF;
  IF NEW."idempotencyKey" IS DISTINCT FROM
     'automatic:' || payment_order."id" || ':' || NEW."asset"::TEXT || ':' || NEW."automaticSequence"::TEXT THEN
    RAISE EXCEPTION 'automatic sweep idempotency key does not match immutable ownership'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO owning_invoice
  FROM "TonhubPaymentInvoice"
  WHERE "id" = NEW."invoiceId"
  FOR KEY SHARE;
  SELECT * INTO owning_deposit
  FROM "TonhubDepositAddress"
  WHERE "id" = NEW."depositAddressId"
  FOR KEY SHARE;
  IF owning_invoice."orderId" IS DISTINCT FROM payment_order."id" OR
     owning_deposit."invoiceId" IS DISTINCT FROM owning_invoice."id" THEN
    RAISE EXCEPTION 'automatic sweep ownership is inconsistent' USING ERRCODE = '23514';
  END IF;
  IF NEW."asset" = 'USDT' AND (
    owning_invoice."network" <> 'mainnet' OR owning_deposit."network" <> 'mainnet' OR
    owning_invoice."addressRaw" IS DISTINCT FROM owning_deposit."addressRaw" OR
    NOT EXISTS (
      SELECT 1 FROM "TonhubDepositAssetAccount" account
      WHERE account."depositAddressId" = owning_deposit."id"
        AND account."network" = 'mainnet'
        AND account."asset" = 'USDT'
        AND account."assetKind" = 'JETTON'
        AND account."assetDecimals" = 6
        AND account."status" = 'VERIFIED'
        AND account."jettonMasterAddress" = '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe'
        AND account."assetWalletAddress" IS NOT NULL
    ) OR EXISTS (
      SELECT 1
      FROM "TonhubMovementAllocation" allocation
      JOIN "TonhubPaymentMovement" movement ON movement."id" = allocation."movementId"
      JOIN "TonhubDepositAssetAccount" account
        ON account."depositAddressId" = movement."depositAddressId"
       AND account."asset" = 'USDT'
      WHERE allocation."orderId" = payment_order."id"
        AND allocation."kind" = 'CREDIT'
        AND movement."asset" = 'USDT'
        AND movement."depositAddressId" = owning_deposit."id"
        AND NOT EXISTS (
          SELECT 1 FROM "TonhubMovementAllocation" reversal
          WHERE reversal."reversesAllocationId" = allocation."id"
        )
        AND (
          movement."network" <> 'mainnet' OR movement."direction" <> 'INCOMING' OR
          movement."assetKind" <> 'JETTON' OR movement."assetDecimals" <> 6 OR
          movement."jettonMasterAddress" IS DISTINCT FROM
            '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe' OR
          movement."jettonWalletAddress" IS DISTINCT FROM account."assetWalletAddress" OR
          movement."ownerAddress" IS DISTINCT FROM owning_deposit."addressRaw" OR
          movement."toAddress" IS DISTINCT FROM owning_deposit."addressRaw" OR
          movement."rawPayload" ->> 'officialUsdt' IS DISTINCT FROM 'true' OR
          movement."rawPayload" ->> 'internalTestAsset' = 'true' OR
          account."network" <> 'mainnet' OR account."assetKind" <> 'JETTON' OR
          account."assetDecimals" <> 6 OR account."status" <> 'VERIFIED' OR
          account."jettonMasterAddress" IS DISTINCT FROM movement."jettonMasterAddress"
        )
    )
  ) THEN
    RAISE EXCEPTION 'automatic USDT sweep lacks official mainnet ownership evidence'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."asset" = 'GRAM' AND EXISTS (
    SELECT 1
    FROM "TonhubMovementAllocation" allocation
    JOIN "TonhubPaymentMovement" movement ON movement."id" = allocation."movementId"
    WHERE allocation."orderId" = payment_order."id"
      AND allocation."kind" = 'CREDIT'
      AND movement."asset" = 'GRAM'
      AND movement."depositAddressId" = owning_deposit."id"
      AND NOT EXISTS (
        SELECT 1 FROM "TonhubMovementAllocation" reversal
        WHERE reversal."reversesAllocationId" = allocation."id"
      )
      AND (
        movement."network" IS DISTINCT FROM owning_deposit."network" OR
        owning_invoice."network" IS DISTINCT FROM owning_deposit."network" OR
        movement."direction" <> 'INCOMING' OR movement."assetKind" <> 'NATIVE' OR
        movement."assetDecimals" <> 9 OR movement."status" <> 'CREDITED' OR
        movement."toAddress" IS DISTINCT FROM owning_deposit."addressRaw"
      )
  ) THEN
    RAISE EXCEPTION 'automatic GRAM sweep lacks native deposit ownership evidence'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(MAX(sweep."automaticSequence"), 0),
         COALESCE(MAX(sweep."triggerCreditedFiatMicros"::NUMERIC)
           FILTER (WHERE sweep."depositAddressId" = NEW."depositAddressId"), 0)
  INTO previous_sequence, previous_credit
  FROM "TonhubAssetSweep" sweep
  WHERE sweep."orderId" = payment_order."id"
    AND sweep."asset" = NEW."asset"
    AND sweep."automaticSequence" IS NOT NULL;

  IF previous_sequence = 0 THEN
    SELECT MAX(sweep."confirmedAt")
    INTO legacy_confirmed_at
    FROM "TonhubAssetSweep" sweep
    WHERE sweep."depositAddressId" = NEW."depositAddressId"
      AND sweep."asset" = NEW."asset"
      AND sweep."automaticSequence" IS NULL
      AND sweep."status" = 'CONFIRMED';
    IF legacy_confirmed_at IS NOT NULL THEN
      SELECT COALESCE(SUM(
        CASE allocation."kind"::TEXT
          WHEN 'CREDIT' THEN allocation."fiatCreditMicros"::NUMERIC
          ELSE -allocation."fiatCreditMicros"::NUMERIC
        END
      ), 0)
      INTO previous_credit
      FROM "TonhubMovementAllocation" allocation
      JOIN "TonhubPaymentMovement" movement ON movement."id" = allocation."movementId"
      WHERE allocation."orderId" = payment_order."id"
        AND movement."asset" = NEW."asset"
        AND movement."depositAddressId" = NEW."depositAddressId"
        AND movement."blockchainAt" <= legacy_confirmed_at;
    END IF;
  END IF;

  IF NEW."automaticSequence" <> previous_sequence + 1 OR
     NEW."automaticSequence" > payment_order."maxAutomaticSweepsPerAsset" THEN
    RAISE EXCEPTION 'automatic sweep sequence exceeds the immutable order policy'
      USING ERRCODE = '23514';
  END IF;
  IF previous_sequence > 0 AND NOT EXISTS (
    SELECT 1 FROM "TonhubAssetSweep" previous_sweep
    WHERE previous_sweep."orderId" = payment_order."id"
      AND previous_sweep."asset" = NEW."asset"
      AND previous_sweep."automaticSequence" = previous_sequence
      AND previous_sweep."status" = 'CONFIRMED'
  ) THEN
    RAISE EXCEPTION 'previous automatic sweep must be confirmed before the next sequence'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(
    CASE allocation."kind"::TEXT
      WHEN 'CREDIT' THEN allocation."fiatCreditMicros"::NUMERIC
      ELSE -allocation."fiatCreditMicros"::NUMERIC
    END
  ), 0)
  INTO asset_credit
  FROM "TonhubMovementAllocation" allocation
  JOIN "TonhubPaymentMovement" movement ON movement."id" = allocation."movementId"
  WHERE allocation."orderId" = payment_order."id"
    AND movement."asset" = NEW."asset"
    AND movement."depositAddressId" = NEW."depositAddressId";

  SELECT COALESCE(SUM(
    CASE allocation."kind"::TEXT
      WHEN 'CREDIT' THEN allocation."fiatCreditMicros"::NUMERIC
      ELSE -allocation."fiatCreditMicros"::NUMERIC
    END
  ), 0)
  INTO total_credit
  FROM "TonhubMovementAllocation" allocation
  WHERE allocation."orderId" = payment_order."id";

  IF NEW."triggerCreditedFiatMicros"::NUMERIC <> asset_credit OR
     NEW."triggerFiatMicros"::NUMERIC <> asset_credit - previous_credit OR
     asset_credit <= previous_credit THEN
    RAISE EXCEPTION 'automatic sweep trigger is not backed by unscheduled credited fiat'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."triggerReason" = 'TERMINAL_PAID' THEN
    IF payment_order."status" <> 'PAID' THEN
      RAISE EXCEPTION 'terminal automatic sweep requires a paid order'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF payment_order."status" NOT IN ('PENDING', 'PARTIAL') OR
       NEW."automaticSequence" >= payment_order."maxAutomaticSweepsPerAsset" THEN
      RAISE EXCEPTION 'intermediate sweep must reserve the final automatic sweep slot'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."triggerReason" = 'INTERMEDIATE_RATIO' AND
       total_credit * 10000 < payment_order."fiatAmountMicros"::NUMERIC *
         payment_order."intermediateSweepTriggerBps" THEN
      RAISE EXCEPTION 'intermediate ratio sweep is below the snapshotted threshold'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."triggerReason" = 'INTERMEDIATE_VALUE' AND
       NEW."triggerFiatMicros"::NUMERIC < payment_order."intermediateSweepMinFiatMicros"::NUMERIC THEN
      RAISE EXCEPTION 'intermediate value sweep is below the snapshotted threshold'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "TonhubAssetSweep_validate_automatic_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "TonhubAssetSweep"
FOR EACH ROW EXECUTE FUNCTION tonhub_validate_automatic_asset_sweep();

CREATE OR REPLACE FUNCTION tonhub_reject_asset_sweep_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'asset sweep history cannot be truncated' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "TonhubAssetSweep_reject_truncate"
BEFORE TRUNCATE ON "TonhubAssetSweep"
FOR EACH STATEMENT EXECUTE FUNCTION tonhub_reject_asset_sweep_truncate();

-- The established order-attempt contract treats credited movements on more
-- than one physical deposit as a recovery case. Do not silently choose one
-- wallet for rollout sweeping and strand the other one.
CREATE TEMP TABLE tonhub_multi_funded_asset ON COMMIT DROP AS
WITH deposit_credit AS (
  SELECT allocation."orderId" AS order_id,
    movement."asset",
    movement."depositAddressId" AS deposit_address_id,
    SUM(CASE allocation."kind"::TEXT
      WHEN 'CREDIT' THEN allocation."fiatCreditMicros"::NUMERIC
      ELSE -allocation."fiatCreditMicros"::NUMERIC
    END) AS fiat_credit
  FROM "TonhubMovementAllocation" allocation
  JOIN "TonhubPaymentMovement" movement ON movement."id" = allocation."movementId"
  WHERE movement."asset" IN ('GRAM', 'USDT')
    AND movement."depositAddressId" IS NOT NULL
  GROUP BY allocation."orderId", movement."asset", movement."depositAddressId"
)
SELECT order_id, "asset", COUNT(*)::INTEGER AS funded_deposit_count
FROM deposit_credit
WHERE fiat_credit > 0
GROUP BY order_id, "asset"
HAVING COUNT(*) > 1;

INSERT INTO "TonhubRecoveryCase" (
  "id", "orderId", "invoiceId", "reason", "status", "title", "details",
  "createdAt", "updatedAt"
)
SELECT
  'automatic-sweep-multiple-deposits:' || conflict.order_id || ':' || conflict."asset",
  conflict.order_id,
  NULL,
  'AUTOMATIC_SWEEP_MULTIPLE_FUNDED_DEPOSITS',
  'OPEN',
  'Automatic sweep requires multiple deposit wallets',
  jsonb_build_object(
    'asset', conflict."asset",
    'fundedDepositCount', conflict.funded_deposit_count,
    'migration', '20260814103000'
  ),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM tonhub_multi_funded_asset conflict
ON CONFLICT DO NOTHING;

UPDATE "TonhubPaymentOrder" payment_order
SET "status" = 'RECOVERY', "updatedAt" = CURRENT_TIMESTAMP
FROM tonhub_multi_funded_asset conflict
WHERE payment_order."id" = conflict.order_id
  AND payment_order."status" <> 'RECOVERY';

-- Existing credited partial orders do not need to wait for another payment to
-- enter the new policy. Backfill at most one allocation-backed intermediate job
-- per order/asset, without competing with a pre-existing manual/step-13 job.
WITH allocation_balance AS (
  SELECT
    allocation."orderId" AS order_id,
    allocation."invoiceId" AS invoice_id,
    movement."depositAddressId" AS deposit_address_id,
    movement."asset",
    SUM(CASE allocation."kind"::TEXT
      WHEN 'CREDIT' THEN allocation."fiatCreditMicros"::NUMERIC
      ELSE -allocation."fiatCreditMicros"::NUMERIC
    END) AS asset_credit
  FROM "TonhubMovementAllocation" allocation
  JOIN "TonhubPaymentMovement" movement ON movement."id" = allocation."movementId"
  WHERE movement."asset" IN ('GRAM', 'USDT')
    AND movement."depositAddressId" IS NOT NULL
    AND allocation."invoiceId" IS NOT NULL
  GROUP BY allocation."orderId", allocation."invoiceId", movement."depositAddressId", movement."asset"
), order_balance AS (
  SELECT allocation."orderId" AS order_id,
    SUM(CASE allocation."kind"::TEXT
      WHEN 'CREDIT' THEN allocation."fiatCreditMicros"::NUMERIC
      ELSE -allocation."fiatCreditMicros"::NUMERIC
    END) AS total_credit
  FROM "TonhubMovementAllocation" allocation
  GROUP BY allocation."orderId"
), ledger_balance AS (
  SELECT movement."depositAddressId" AS deposit_address_id, movement."asset",
    SUM(CASE movement."direction"::TEXT
      WHEN 'INCOMING' THEN movement."amountAtomic"::NUMERIC
      ELSE -movement."amountAtomic"::NUMERIC
    END) AS atomic_balance
  FROM "TonhubPaymentMovement" movement
  JOIN "TonhubDepositAddress" deposit ON deposit."id" = movement."depositAddressId"
  JOIN "TonhubPaymentInvoice" invoice ON invoice."id" = deposit."invoiceId"
  LEFT JOIN "TonhubDepositAssetAccount" account
    ON account."depositAddressId" = deposit."id" AND account."asset" = movement."asset"
  WHERE movement."status" <> 'REJECTED'
    AND movement."asset" IN ('GRAM', 'USDT')
    AND movement."depositAddressId" IS NOT NULL
    AND (
      (
        movement."asset" = 'GRAM' AND movement."network" = deposit."network" AND
        invoice."network" = deposit."network" AND movement."assetKind" = 'NATIVE' AND
        movement."assetDecimals" = 9 AND (
          (movement."direction" = 'INCOMING' AND movement."toAddress" = deposit."addressRaw") OR
          (movement."direction" = 'OUTGOING' AND movement."fromAddress" = deposit."addressRaw")
        )
      ) OR (
        movement."network" = 'mainnet' AND movement."assetKind" = 'JETTON' AND
        movement."assetDecimals" = 6 AND deposit."network" = 'mainnet' AND
        invoice."network" = 'mainnet' AND invoice."addressRaw" = deposit."addressRaw" AND
        movement."jettonMasterAddress" =
          '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe' AND
        movement."jettonWalletAddress" = account."assetWalletAddress" AND
        movement."ownerAddress" = deposit."addressRaw" AND
        movement."rawPayload" ->> 'officialUsdt' = 'true' AND
        movement."rawPayload" ->> 'internalTestAsset' IS DISTINCT FROM 'true' AND
        account."network" = 'mainnet' AND account."assetKind" = 'JETTON' AND
        account."assetDecimals" = 6 AND account."status" = 'VERIFIED' AND
        account."jettonMasterAddress" = movement."jettonMasterAddress" AND
        (
          (movement."direction" = 'INCOMING' AND movement."toAddress" = deposit."addressRaw") OR
          (movement."direction" = 'OUTGOING' AND movement."fromAddress" = deposit."addressRaw")
        )
      )
    )
  GROUP BY movement."depositAddressId", movement."asset"
), eligible AS (
  SELECT DISTINCT ON (payment_order."id", allocation_balance."asset")
    payment_order."id" AS order_id,
    allocation_balance.invoice_id,
    allocation_balance.deposit_address_id,
    allocation_balance."asset",
    allocation_balance.asset_credit,
    order_balance.total_credit,
    CASE
      WHEN order_balance.total_credit * 10000 >=
        payment_order."fiatAmountMicros"::NUMERIC * payment_order."intermediateSweepTriggerBps"
        THEN 'INTERMEDIATE_RATIO'
      ELSE 'INTERMEDIATE_VALUE'
    END AS trigger_reason
  FROM allocation_balance
  JOIN order_balance ON order_balance.order_id = allocation_balance.order_id
  JOIN ledger_balance ON ledger_balance.deposit_address_id = allocation_balance.deposit_address_id
    AND ledger_balance."asset" = allocation_balance."asset"
  JOIN "TonhubPaymentOrder" payment_order ON payment_order."id" = allocation_balance.order_id
  JOIN "TonhubPaymentInvoice" invoice ON invoice."id" = allocation_balance.invoice_id
    AND invoice."orderId" = payment_order."id"
  JOIN "TonhubDepositAddress" deposit ON deposit."id" = allocation_balance.deposit_address_id
    AND deposit."invoiceId" = invoice."id"
  WHERE payment_order."status" IN ('PENDING', 'PARTIAL')
    AND payment_order."maxAutomaticSweepsPerAsset" > 1
    AND allocation_balance.asset_credit > 0
    AND ledger_balance.atomic_balance > 0
    AND (
      order_balance.total_credit * 10000 >=
        payment_order."fiatAmountMicros"::NUMERIC * payment_order."intermediateSweepTriggerBps" OR
      allocation_balance.asset_credit >= payment_order."intermediateSweepMinFiatMicros"::NUMERIC
    )
    AND NOT EXISTS (
      SELECT 1 FROM "TonhubAssetSweep" existing
      WHERE existing."orderId" = payment_order."id"
        AND existing."asset" = allocation_balance."asset"
        AND existing."automaticSequence" IS NOT NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM "TonhubAssetSweep" active
      WHERE active."orderId" = payment_order."id"
        AND active."asset" = allocation_balance."asset"
        AND active."status" IN (
          'QUEUED', 'GAS_CHECK', 'GAS_TOPUP_REQUIRED', 'GAS_TOPUP_SENT', 'READY', 'SENT', 'FAILED'
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM "TonhubAssetSweep" historical
      WHERE historical."depositAddressId" = allocation_balance.deposit_address_id
        AND historical."asset" = allocation_balance."asset"
        AND historical."automaticSequence" IS NULL
        AND historical."status" = 'CONFIRMED'
    )
    AND NOT EXISTS (
      SELECT 1 FROM tonhub_multi_funded_asset conflict
      WHERE conflict.order_id = payment_order."id"
        AND conflict."asset" = allocation_balance."asset"
    )
    AND (
      allocation_balance."asset" = 'USDT' OR NOT EXISTS (
        SELECT 1
        FROM "TonhubMovementAllocation" ownership_allocation
        JOIN "TonhubPaymentMovement" ownership_movement
          ON ownership_movement."id" = ownership_allocation."movementId"
        WHERE ownership_allocation."orderId" = payment_order."id"
          AND ownership_allocation."kind" = 'CREDIT'
          AND ownership_movement."asset" = 'GRAM'
          AND ownership_movement."depositAddressId" = allocation_balance.deposit_address_id
          AND NOT EXISTS (
            SELECT 1 FROM "TonhubMovementAllocation" reversal
            WHERE reversal."reversesAllocationId" = ownership_allocation."id"
          )
          AND (
            ownership_movement."network" IS DISTINCT FROM deposit."network" OR
            invoice."network" IS DISTINCT FROM deposit."network" OR
            ownership_movement."direction" <> 'INCOMING' OR
            ownership_movement."assetKind" <> 'NATIVE' OR
            ownership_movement."assetDecimals" <> 9 OR
            ownership_movement."status" <> 'CREDITED' OR
            ownership_movement."toAddress" IS DISTINCT FROM deposit."addressRaw"
          )
      )
    )
    AND (
      allocation_balance."asset" = 'GRAM' OR NOT EXISTS (
        SELECT 1
        FROM "TonhubMovementAllocation" ownership_allocation
        JOIN "TonhubPaymentMovement" ownership_movement
          ON ownership_movement."id" = ownership_allocation."movementId"
        JOIN "TonhubDepositAssetAccount" ownership_account
          ON ownership_account."depositAddressId" = ownership_movement."depositAddressId"
         AND ownership_account."asset" = 'USDT'
        WHERE ownership_allocation."orderId" = payment_order."id"
          AND ownership_allocation."kind" = 'CREDIT'
          AND ownership_movement."asset" = 'USDT'
          AND ownership_movement."depositAddressId" = allocation_balance.deposit_address_id
          AND NOT EXISTS (
            SELECT 1 FROM "TonhubMovementAllocation" reversal
            WHERE reversal."reversesAllocationId" = ownership_allocation."id"
          )
          AND (
            ownership_movement."network" <> 'mainnet' OR
            ownership_movement."direction" <> 'INCOMING' OR
            ownership_movement."assetKind" <> 'JETTON' OR
            ownership_movement."assetDecimals" <> 6 OR
            ownership_movement."jettonMasterAddress" IS DISTINCT FROM
              '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe' OR
            ownership_movement."jettonWalletAddress" IS DISTINCT FROM ownership_account."assetWalletAddress" OR
            ownership_movement."ownerAddress" IS DISTINCT FROM deposit."addressRaw" OR
            ownership_movement."toAddress" IS DISTINCT FROM deposit."addressRaw" OR
            ownership_movement."rawPayload" ->> 'officialUsdt' IS DISTINCT FROM 'true' OR
            ownership_movement."rawPayload" ->> 'internalTestAsset' = 'true' OR
            ownership_account."network" <> 'mainnet' OR
            ownership_account."assetKind" <> 'JETTON' OR
            ownership_account."assetDecimals" <> 6 OR
            ownership_account."status" <> 'VERIFIED' OR
            ownership_account."jettonMasterAddress" IS DISTINCT FROM
              ownership_movement."jettonMasterAddress"
          )
      )
    )
  ORDER BY payment_order."id", allocation_balance."asset",
    allocation_balance.asset_credit DESC, allocation_balance.deposit_address_id ASC
)
INSERT INTO "TonhubAssetSweep" (
  "id", "idempotencyKey", "depositAddressId", "orderId", "invoiceId",
  "asset", "assetKind", "automaticSequence", "triggerReason",
  "triggerFiatMicros", "triggerCreditedFiatMicros", "triggeredAt", "status",
  "createdAt", "updatedAt"
)
SELECT
  'automatic-rollout:' || eligible.order_id || ':' || eligible."asset",
  'automatic:' || eligible.order_id || ':' || eligible."asset" || ':1',
  eligible.deposit_address_id,
  eligible.order_id,
  eligible.invoice_id,
  eligible."asset",
  CASE eligible."asset" WHEN 'GRAM' THEN 'NATIVE' ELSE 'JETTON' END,
  1,
  eligible.trigger_reason,
  eligible.asset_credit::TEXT,
  eligible.asset_credit::TEXT,
  CURRENT_TIMESTAMP,
  'QUEUED',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM eligible
ON CONFLICT DO NOTHING;
