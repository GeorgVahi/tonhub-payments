-- The public label may evolve (USD₮), but persisted asset identity remains the
-- stable machine code USDT. Both supported assets live on the same TON invoice.
CREATE TYPE "TonhubOrderAdjustmentKind" AS ENUM ('PAYMENT_METHOD_DISCOUNT', 'REVERSAL');

ALTER TABLE "TonhubPaymentOrder"
ADD COLUMN "discountFiatMicros" TEXT NOT NULL DEFAULT '0',
ADD COLUMN "minimumOrderFiatMicros" TEXT NOT NULL DEFAULT '0',
ADD COLUMN "gramDiscountMaxFiatMicros" TEXT NOT NULL DEFAULT '0',
ADD COLUMN "intermediateSweepTriggerBps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "intermediateSweepMinFiatMicros" TEXT NOT NULL DEFAULT '0',
ADD COLUMN "maxAutomaticSweepsPerAsset" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "TonhubPaymentOrder"
ADD CONSTRAINT "TonhubPaymentOrder_checkout_policy_check" CHECK (
  "discountFiatMicros" ~ '^[0-9]+$' AND
  "discountFiatMicros"::NUMERIC <= "fiatAmountMicros"::NUMERIC AND
  "minimumOrderFiatMicros" ~ '^[0-9]+$' AND
  "minimumOrderFiatMicros"::NUMERIC <= "fiatAmountMicros"::NUMERIC AND
  "gramDiscountMaxFiatMicros" ~ '^[0-9]+$' AND
  "gramDiscountMaxFiatMicros"::NUMERIC <= "fiatAmountMicros"::NUMERIC AND
  "intermediateSweepTriggerBps" BETWEEN 0 AND 10000 AND
  "intermediateSweepMinFiatMicros" ~ '^[0-9]+$' AND
  "maxAutomaticSweepsPerAsset" BETWEEN 0 AND 2
);

ALTER TABLE "TonhubPaymentInvoice"
ADD COLUMN "paymentSelectionLockedAsset" TEXT,
ADD COLUMN "paymentSelectionLockedAt" TIMESTAMP(3);

ALTER TABLE "TonhubPaymentInvoice"
ADD CONSTRAINT "TonhubPaymentInvoice_payment_selection_lock_check" CHECK (
  ("paymentSelectionLockedAsset" IS NULL) = ("paymentSelectionLockedAt" IS NULL) AND
  (
    "paymentSelectionLockedAsset" IS NULL OR
    (
      "paymentSelectionLockedAsset" IN ('GRAM', 'USDT') AND
      "paymentSelectionLockedAsset" = "checkoutAsset" AND
      "paymentSelectionLockedAt" >= "createdAt"
    )
  )
);

CREATE TABLE "TonhubPaymentQuote" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "network" TEXT NOT NULL,
  "asset" TEXT NOT NULL,
  "assetKind" TEXT NOT NULL,
  "assetDecimals" INTEGER NOT NULL,
  "fiatCurrency" TEXT NOT NULL,
  "grossFiatMicros" TEXT NOT NULL,
  "discountFiatMicros" TEXT NOT NULL DEFAULT '0',
  "netFiatMicros" TEXT NOT NULL,
  "amountAtomic" TEXT NOT NULL,
  "rateSnapshotId" TEXT NOT NULL,
  "quotedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TonhubPaymentQuote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TonhubPaymentQuote_amounts_check" CHECK (
    "grossFiatMicros" ~ '^[1-9][0-9]*$' AND
    "discountFiatMicros" ~ '^[0-9]+$' AND
    "netFiatMicros" ~ '^[1-9][0-9]*$' AND
    "amountAtomic" ~ '^[1-9][0-9]*$' AND
    "grossFiatMicros"::NUMERIC = "netFiatMicros"::NUMERIC + "discountFiatMicros"::NUMERIC
  ),
  CONSTRAINT "TonhubPaymentQuote_time_check" CHECK (
    "quotedAt" <= "createdAt" AND "createdAt" <= "expiresAt" AND "quotedAt" < "expiresAt"
  ),
  CONSTRAINT "TonhubPaymentQuote_asset_identity_check" CHECK (
    ("asset" = 'GRAM' AND "assetKind" = 'NATIVE' AND "assetDecimals" = 9 AND "network" IN ('testnet', 'mainnet')) OR
    ("asset" = 'USDT' AND "assetKind" = 'JETTON' AND "assetDecimals" = 6 AND "network" = 'mainnet')
  )
);

CREATE UNIQUE INDEX "TonhubPaymentQuote_invoiceId_asset_key"
ON "TonhubPaymentQuote"("invoiceId", "asset");
CREATE INDEX "TonhubPaymentQuote_orderId_idx"
ON "TonhubPaymentQuote"("orderId");
CREATE INDEX "TonhubPaymentQuote_rateSnapshotId_idx"
ON "TonhubPaymentQuote"("rateSnapshotId");
CREATE INDEX "TonhubPaymentQuote_expiresAt_idx"
ON "TonhubPaymentQuote"("expiresAt");

CREATE TABLE "TonhubOrderAdjustment" (
  "id" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "quoteId" TEXT NOT NULL,
  "kind" "TonhubOrderAdjustmentKind" NOT NULL DEFAULT 'PAYMENT_METHOD_DISCOUNT',
  "reversesAdjustmentId" TEXT,
  "fiatAmountMicros" TEXT NOT NULL,
  "fiatCurrency" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "evidence" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TonhubOrderAdjustment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TonhubOrderAdjustment_amount_check" CHECK ("fiatAmountMicros" ~ '^[1-9][0-9]*$'),
  CONSTRAINT "TonhubOrderAdjustment_text_check" CHECK (
    LENGTH("idempotencyKey") > 0 AND LENGTH("reason") > 0
  ),
  CONSTRAINT "TonhubOrderAdjustment_reversal_shape_check" CHECK (
    ("kind" = 'PAYMENT_METHOD_DISCOUNT' AND "reversesAdjustmentId" IS NULL) OR
    ("kind" = 'REVERSAL' AND "reversesAdjustmentId" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "TonhubOrderAdjustment_idempotencyKey_key"
ON "TonhubOrderAdjustment"("idempotencyKey");
CREATE UNIQUE INDEX "TonhubOrderAdjustment_reversesAdjustmentId_key"
ON "TonhubOrderAdjustment"("reversesAdjustmentId");
CREATE UNIQUE INDEX "TonhubOrderAdjustment_one_discount_per_invoice_key"
ON "TonhubOrderAdjustment"("invoiceId")
WHERE "kind" = 'PAYMENT_METHOD_DISCOUNT';
CREATE INDEX "TonhubOrderAdjustment_orderId_createdAt_idx"
ON "TonhubOrderAdjustment"("orderId", "createdAt");
CREATE INDEX "TonhubOrderAdjustment_invoiceId_createdAt_idx"
ON "TonhubOrderAdjustment"("invoiceId", "createdAt");

ALTER TABLE "TonhubPaymentQuote"
ADD CONSTRAINT "TonhubPaymentQuote_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "TonhubPaymentOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TonhubPaymentQuote"
ADD CONSTRAINT "TonhubPaymentQuote_invoiceId_fkey"
FOREIGN KEY ("invoiceId") REFERENCES "TonhubPaymentInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TonhubPaymentQuote"
ADD CONSTRAINT "TonhubPaymentQuote_rateSnapshotId_fkey"
FOREIGN KEY ("rateSnapshotId") REFERENCES "TonhubRateSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TonhubOrderAdjustment"
ADD CONSTRAINT "TonhubOrderAdjustment_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "TonhubPaymentOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TonhubOrderAdjustment"
ADD CONSTRAINT "TonhubOrderAdjustment_invoiceId_fkey"
FOREIGN KEY ("invoiceId") REFERENCES "TonhubPaymentInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TonhubOrderAdjustment"
ADD CONSTRAINT "TonhubOrderAdjustment_quoteId_fkey"
FOREIGN KEY ("quoteId") REFERENCES "TonhubPaymentQuote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TonhubOrderAdjustment"
ADD CONSTRAINT "TonhubOrderAdjustment_reversesAdjustmentId_fkey"
FOREIGN KEY ("reversesAdjustmentId") REFERENCES "TonhubOrderAdjustment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "tonhub_order_discount_total"(payment_order_id TEXT)
RETURNS NUMERIC AS $$
  SELECT COALESCE(SUM(
    CASE WHEN adjustment."kind" = 'PAYMENT_METHOD_DISCOUNT'
      THEN adjustment."fiatAmountMicros"::NUMERIC
      ELSE -adjustment."fiatAmountMicros"::NUMERIC
    END
  ), 0)
  FROM "TonhubOrderAdjustment" AS adjustment
  WHERE adjustment."orderId" = payment_order_id;
$$ LANGUAGE sql STABLE;

CREATE FUNCTION "tonhub_guard_order_checkout_policy"() RETURNS trigger AS $$
DECLARE
  adjustment_discount NUMERIC;
BEGIN
  IF ROW(
    OLD."fiatAmountMicros", OLD."fiatCurrency", OLD."minimumOrderFiatMicros",
    OLD."gramDiscountMaxFiatMicros", OLD."intermediateSweepTriggerBps",
    OLD."intermediateSweepMinFiatMicros", OLD."maxAutomaticSweepsPerAsset"
  ) IS DISTINCT FROM ROW(
    NEW."fiatAmountMicros", NEW."fiatCurrency", NEW."minimumOrderFiatMicros",
    NEW."gramDiscountMaxFiatMicros", NEW."intermediateSweepTriggerBps",
    NEW."intermediateSweepMinFiatMicros", NEW."maxAutomaticSweepsPerAsset"
  ) THEN
    RAISE EXCEPTION 'order checkout terms and policy snapshots are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW."discountFiatMicros" IS DISTINCT FROM OLD."discountFiatMicros" THEN
    adjustment_discount := "tonhub_order_discount_total"(NEW."id");
    IF NEW."discountFiatMicros"::NUMERIC <> adjustment_discount THEN
      RAISE EXCEPTION 'order discount summary must equal append-only adjustment evidence'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TonhubPaymentOrder_guard_checkout_policy"
BEFORE UPDATE ON "TonhubPaymentOrder"
FOR EACH ROW EXECUTE FUNCTION "tonhub_guard_order_checkout_policy"();

CREATE FUNCTION "tonhub_guard_invoice_payment_selection"() RETURNS trigger AS $$
BEGIN
  IF OLD."paymentSelectionLockedAt" IS NOT NULL AND ROW(
    OLD."checkoutAsset", OLD."paymentSelectionLockedAsset", OLD."paymentSelectionLockedAt"
  ) IS DISTINCT FROM ROW(
    NEW."checkoutAsset", NEW."paymentSelectionLockedAsset", NEW."paymentSelectionLockedAt"
  ) THEN
    RAISE EXCEPTION 'invoice payment selection is immutable after its first movement'
      USING ERRCODE = '55000';
  END IF;
  IF ROW(
    OLD."orderId", OLD."network", OLD."fiatAmountMicros", OLD."fiatCurrency",
    OLD."createdAt", OLD."priceLockedUntil", OLD."expiresAt"
  ) IS DISTINCT FROM ROW(
    NEW."orderId", NEW."network", NEW."fiatAmountMicros", NEW."fiatCurrency",
    NEW."createdAt", NEW."priceLockedUntil", NEW."expiresAt"
  ) AND EXISTS (
    SELECT 1 FROM "TonhubPaymentQuote" WHERE "invoiceId" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'invoice quote ownership and pricing basis are immutable once quoted'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TonhubPaymentInvoice_guard_payment_selection"
BEFORE UPDATE ON "TonhubPaymentInvoice"
FOR EACH ROW EXECUTE FUNCTION "tonhub_guard_invoice_payment_selection"();

CREATE FUNCTION "tonhub_validate_payment_quote"() RETURNS trigger AS $$
DECLARE
  invoice "TonhubPaymentInvoice"%ROWTYPE;
  payment_order "TonhubPaymentOrder"%ROWTYPE;
  rate_snapshot "TonhubRateSnapshot"%ROWTYPE;
  payment_step NUMERIC;
  expected_atomic NUMERIC;
  quote_deadline TIMESTAMP(3);
BEGIN
  SELECT * INTO payment_order
  FROM "TonhubPaymentOrder"
  WHERE "id" = NEW."orderId"
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'a payment quote requires an owning order'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO invoice
  FROM "TonhubPaymentInvoice"
  WHERE "id" = NEW."invoiceId"
  FOR UPDATE;

  IF NOT FOUND OR invoice."orderId" IS NULL OR invoice."fiatAmountMicros" IS NULL THEN
    RAISE EXCEPTION 'a payment quote requires an order-owned neutral invoice'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO rate_snapshot
  FROM "TonhubRateSnapshot"
  WHERE "id" = NEW."rateSnapshotId"
  FOR KEY SHARE;

  quote_deadline := COALESCE(invoice."priceLockedUntil", invoice."expiresAt");
  IF NOT FOUND OR quote_deadline IS NULL OR NEW."quotedAt" < invoice."createdAt" OR
     NEW."expiresAt" > quote_deadline OR
     NEW."orderId" IS DISTINCT FROM invoice."orderId" OR
     NEW."network" IS DISTINCT FROM invoice."network" OR
     NEW."fiatCurrency" IS DISTINCT FROM invoice."fiatCurrency" OR
     NEW."fiatCurrency" IS DISTINCT FROM payment_order."fiatCurrency" OR
     NEW."grossFiatMicros" IS DISTINCT FROM invoice."fiatAmountMicros" OR
     NEW."grossFiatMicros" IS DISTINCT FROM payment_order."fiatAmountMicros" OR
     rate_snapshot."asset" IS DISTINCT FROM NEW."asset" OR
     rate_snapshot."baseCurrency" IS DISTINCT FROM NEW."asset" OR
     rate_snapshot."quoteCurrency" IS DISTINCT FROM NEW."fiatCurrency" OR
     rate_snapshot."observedAt" > NEW."quotedAt" OR
     rate_snapshot."fetchedAt" > NEW."quotedAt" OR
     "tonhub_rate_snapshot_is_valid"(rate_snapshot) IS NOT TRUE THEN
    RAISE EXCEPTION 'payment quote does not match its invoice, order, rate, or deadline'
      USING ERRCODE = '23514';
  END IF;

  IF (NEW."asset" = 'USDT' AND NEW."discountFiatMicros" <> '0') OR
     (NEW."asset" = 'GRAM' AND NEW."discountFiatMicros"::NUMERIC > payment_order."gramDiscountMaxFiatMicros"::NUMERIC) THEN
    RAISE EXCEPTION 'payment quote discount violates the snapshotted asset policy'
      USING ERRCODE = '23514';
  END IF;

  payment_step := POWER(10::NUMERIC, NEW."assetDecimals" - 2);
  expected_atomic := CEIL(
    CEIL(
      NEW."netFiatMicros"::NUMERIC * POWER(10::NUMERIC, NEW."assetDecimals") /
      (rate_snapshot."price" * 1000000::NUMERIC)
    ) / payment_step
  ) * payment_step;

  IF NEW."amountAtomic"::NUMERIC <> expected_atomic THEN
    RAISE EXCEPTION 'payment quote amount does not match exact rounded rate valuation'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TonhubPaymentQuote_validate_insert"
BEFORE INSERT ON "TonhubPaymentQuote"
FOR EACH ROW EXECUTE FUNCTION "tonhub_validate_payment_quote"();

CREATE TRIGGER "TonhubPaymentQuote_append_only"
BEFORE UPDATE OR DELETE ON "TonhubPaymentQuote"
FOR EACH ROW EXECUTE FUNCTION "tonhub_reject_immutable_row_change"();
CREATE TRIGGER "TonhubPaymentQuote_no_truncate"
BEFORE TRUNCATE ON "TonhubPaymentQuote"
FOR EACH STATEMENT EXECUTE FUNCTION "tonhub_reject_immutable_row_change"();

CREATE FUNCTION "tonhub_validate_order_adjustment"() RETURNS trigger AS $$
DECLARE
  original "TonhubOrderAdjustment"%ROWTYPE;
  payment_order "TonhubPaymentOrder"%ROWTYPE;
  invoice "TonhubPaymentInvoice"%ROWTYPE;
  quote "TonhubPaymentQuote"%ROWTYPE;
  effective_credit NUMERIC;
  active_discount NUMERIC;
  has_usdt_credit BOOLEAN;
BEGIN
  SELECT * INTO payment_order
  FROM "TonhubPaymentOrder"
  WHERE "id" = NEW."orderId"
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'an order adjustment requires an owning order'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."kind" = 'REVERSAL' THEN
    SELECT * INTO original
    FROM "TonhubOrderAdjustment"
    WHERE "id" = NEW."reversesAdjustmentId"
    FOR KEY SHARE;

    IF NOT FOUND OR original."kind" <> 'PAYMENT_METHOD_DISCOUNT' OR ROW(
      NEW."orderId", NEW."invoiceId", NEW."quoteId", NEW."fiatAmountMicros", NEW."fiatCurrency"
    ) IS DISTINCT FROM ROW(
      original."orderId", original."invoiceId", original."quoteId",
      original."fiatAmountMicros", original."fiatCurrency"
    ) THEN
      RAISE EXCEPTION 'an adjustment reversal must exactly mirror one payment-method discount'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO invoice
  FROM "TonhubPaymentInvoice"
  WHERE "id" = NEW."invoiceId"
  FOR KEY SHARE;

  SELECT * INTO quote
  FROM "TonhubPaymentQuote"
  WHERE "id" = NEW."quoteId"
  FOR KEY SHARE;

  SELECT
    COALESCE(SUM(CASE WHEN allocation."kind" = 'CREDIT'
      THEN allocation."fiatCreditMicros"::NUMERIC
      ELSE -allocation."fiatCreditMicros"::NUMERIC END), 0),
    COALESCE(BOOL_OR(movement."asset" = 'USDT' AND allocation."kind" = 'CREDIT'), FALSE)
  INTO effective_credit, has_usdt_credit
  FROM "TonhubMovementAllocation" AS allocation
  JOIN "TonhubPaymentMovement" AS movement ON movement."id" = allocation."movementId"
  WHERE allocation."orderId" = NEW."orderId";

  active_discount := "tonhub_order_discount_total"(NEW."orderId");

  IF payment_order."id" IS NULL OR invoice."id" IS NULL OR quote."id" IS NULL OR
     invoice."orderId" IS DISTINCT FROM payment_order."id" OR
     quote."invoiceId" IS DISTINCT FROM invoice."id" OR quote."asset" <> 'GRAM' OR
     invoice."paymentSelectionLockedAsset" IS DISTINCT FROM 'GRAM' OR
     NEW."fiatCurrency" IS DISTINCT FROM payment_order."fiatCurrency" OR
     NEW."fiatCurrency" IS DISTINCT FROM quote."fiatCurrency" OR
     NEW."fiatAmountMicros"::NUMERIC > quote."discountFiatMicros"::NUMERIC OR
     has_usdt_credit OR effective_credit >= payment_order."fiatAmountMicros"::NUMERIC OR
     effective_credit + active_discount + NEW."fiatAmountMicros"::NUMERIC <>
       payment_order."fiatAmountMicros"::NUMERIC THEN
    RAISE EXCEPTION 'payment-method discount requires an all-GRAM shortfall matching its locked quote'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TonhubOrderAdjustment_validate_insert"
BEFORE INSERT ON "TonhubOrderAdjustment"
FOR EACH ROW EXECUTE FUNCTION "tonhub_validate_order_adjustment"();

CREATE FUNCTION "tonhub_materialize_order_discount"() RETURNS trigger AS $$
BEGIN
  UPDATE "TonhubPaymentOrder"
  SET "discountFiatMicros" = "tonhub_order_discount_total"(NEW."orderId")::TEXT,
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = NEW."orderId";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TonhubOrderAdjustment_materialize_order_discount"
AFTER INSERT ON "TonhubOrderAdjustment"
FOR EACH ROW EXECUTE FUNCTION "tonhub_materialize_order_discount"();

CREATE TRIGGER "TonhubOrderAdjustment_append_only"
BEFORE UPDATE OR DELETE ON "TonhubOrderAdjustment"
FOR EACH ROW EXECUTE FUNCTION "tonhub_reject_immutable_row_change"();
CREATE TRIGGER "TonhubOrderAdjustment_no_truncate"
BEFORE TRUNCATE ON "TonhubOrderAdjustment"
FOR EACH STATEMENT EXECUTE FUNCTION "tonhub_reject_immutable_row_change"();

CREATE FUNCTION "tonhub_guard_usdt_credit_after_discount"() RETURNS trigger AS $$
DECLARE
  movement_asset TEXT;
BEGIN
  IF NEW."kind" <> 'CREDIT' THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM "TonhubPaymentOrder"
  WHERE "id" = NEW."orderId"
  FOR UPDATE;

  SELECT "asset" INTO movement_asset
  FROM "TonhubPaymentMovement"
  WHERE "id" = NEW."movementId";

  IF movement_asset = 'USDT' AND EXISTS (
    SELECT 1
    FROM "TonhubOrderAdjustment" AS discount
    LEFT JOIN "TonhubOrderAdjustment" AS reversal
      ON reversal."reversesAdjustmentId" = discount."id" AND reversal."kind" = 'REVERSAL'
    WHERE discount."orderId" = NEW."orderId" AND
          discount."kind" = 'PAYMENT_METHOD_DISCOUNT' AND
          reversal."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'USDT credit requires reversal of the active GRAM-only discount first'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TonhubMovementAllocation_guard_active_discount"
BEFORE INSERT ON "TonhubMovementAllocation"
FOR EACH ROW EXECUTE FUNCTION "tonhub_guard_usdt_credit_after_discount"();
