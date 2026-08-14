-- The GRAM saving is earned by an order settled exclusively with GRAM.
-- The checkout rail remains immutable evidence of the user's instruction, but
-- it must not override the assets that actually funded the order.
CREATE OR REPLACE FUNCTION "tonhub_validate_order_adjustment"() RETURNS trigger AS $$
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
     NEW."fiatCurrency" IS DISTINCT FROM payment_order."fiatCurrency" OR
     NEW."fiatCurrency" IS DISTINCT FROM quote."fiatCurrency" OR
     NEW."fiatAmountMicros"::NUMERIC > quote."discountFiatMicros"::NUMERIC OR
     has_usdt_credit OR effective_credit >= payment_order."fiatAmountMicros"::NUMERIC OR
     effective_credit + active_discount + NEW."fiatAmountMicros"::NUMERIC <>
       payment_order."fiatAmountMicros"::NUMERIC THEN
    RAISE EXCEPTION 'payment-method discount requires an all-GRAM shortfall matching its quote'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
