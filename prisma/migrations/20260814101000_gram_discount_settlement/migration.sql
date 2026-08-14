-- A credited movement is part of the evidence for an active payment-method
-- discount. Reversing that credit must first append the matching adjustment
-- reversal, just as crediting USDT must remove an all-GRAM discount first.
ALTER TABLE "TonhubPaymentInvoice"
DROP CONSTRAINT "TonhubPaymentInvoice_payment_selection_lock_check";

ALTER TABLE "TonhubPaymentInvoice"
ADD CONSTRAINT "TonhubPaymentInvoice_payment_selection_lock_check" CHECK (
  ("paymentSelectionLockedAsset" IS NULL) = ("paymentSelectionLockedAt" IS NULL) AND
  (
    "paymentSelectionLockedAsset" IS NULL OR
    (
      "paymentSelectionLockedAsset" IN ('GRAM', 'USDT') AND
      "paymentSelectionLockedAsset" = "checkoutAsset" AND
      "paymentSelectionLockedAt" >= DATE_TRUNC('second', "createdAt")
    )
  )
);

CREATE OR REPLACE FUNCTION "tonhub_guard_usdt_credit_after_discount"() RETURNS trigger AS $$
DECLARE
  movement_asset TEXT;
  reversed_credit_kind "TonhubMovementAllocationKind";
BEGIN
  IF NEW."kind" <> 'CREDIT' AND NEW."kind" <> 'REVERSAL' THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM "TonhubPaymentOrder"
  WHERE "id" = NEW."orderId"
  FOR UPDATE;

  IF NEW."kind" = 'CREDIT' THEN
    SELECT "asset" INTO movement_asset
    FROM "TonhubPaymentMovement"
    WHERE "id" = NEW."movementId";

    IF movement_asset <> 'USDT' THEN
      RETURN NEW;
    END IF;
  ELSE
    SELECT "kind" INTO reversed_credit_kind
    FROM "TonhubMovementAllocation"
    WHERE "id" = NEW."reversesAllocationId";

    IF reversed_credit_kind IS DISTINCT FROM 'CREDIT' THEN
      RETURN NEW;
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "TonhubOrderAdjustment" AS discount
    LEFT JOIN "TonhubOrderAdjustment" AS reversal
      ON reversal."reversesAdjustmentId" = discount."id" AND reversal."kind" = 'REVERSAL'
    WHERE discount."orderId" = NEW."orderId" AND
          discount."kind" = 'PAYMENT_METHOD_DISCOUNT' AND
          reversal."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'movement allocation change requires reversal of the active GRAM-only discount first'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
