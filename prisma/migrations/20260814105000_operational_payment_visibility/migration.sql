-- Keep webhook delivery semantics stable while making the immutable checkout
-- policy, selected rail, actual credited assets, and automatic sweep trigger
-- visible to the merchant. Existing outbox rows stay append-only schema v1;
-- only newly enqueued events use the additive schema v2 payload.

CREATE OR REPLACE FUNCTION "tonhub_invoice_webhook_outbox"() RETURNS trigger AS $$
DECLARE
  topic_name TEXT;
  event_key TEXT;
  current_invoice "TonhubPaymentInvoice"%ROWTYPE;
  payment_order "TonhubPaymentOrder"%ROWTYPE;
  credited_assets JSONB;
  gross_fiat_micros TEXT;
  discount_fiat_micros TEXT;
  net_fiat_micros TEXT;
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

  SELECT * INTO current_invoice
  FROM "TonhubPaymentInvoice"
  WHERE "id" = NEW."id";

  IF current_invoice."id" IS NULL OR (
    topic_name = 'invoice.partial' AND current_invoice."status" <> 'PARTIAL'
  ) OR (
    topic_name = 'invoice.paid' AND current_invoice."status" <> 'PAID'
  ) OR (
    topic_name = 'invoice.expired' AND current_invoice."status" <> 'EXPIRED'
  ) THEN
    RETURN NEW;
  END IF;

  IF current_invoice."orderId" IS NOT NULL THEN
    SELECT * INTO payment_order
    FROM "TonhubPaymentOrder"
    WHERE "id" = current_invoice."orderId";
  END IF;

  SELECT COALESCE(jsonb_agg(active_asset."asset" ORDER BY active_asset."asset"), '[]'::JSONB)
  INTO credited_assets
  FROM (
    SELECT DISTINCT movement."asset"
    FROM "TonhubMovementAllocation" credit
    JOIN "TonhubPaymentMovement" movement ON movement."id" = credit."movementId"
    LEFT JOIN "TonhubMovementAllocation" reversal
      ON reversal."reversesAllocationId" = credit."id"
     AND reversal."kind" = 'REVERSAL'
    WHERE credit."kind" = 'CREDIT'
      AND reversal."id" IS NULL
      AND (
        (current_invoice."orderId" IS NOT NULL AND credit."orderId" = current_invoice."orderId") OR
        (current_invoice."orderId" IS NULL AND credit."invoiceId" = current_invoice."id")
      )
    UNION
    SELECT 'GRAM' AS "asset"
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(current_invoice."observedPayments") = 'array'
            THEN current_invoice."observedPayments"
          ELSE '[]'::JSONB
        END
      ) observed_payment
      WHERE jsonb_typeof(observed_payment.value) = 'object'
        AND COALESCE(observed_payment.value ->> 'transactionId', '') <> ''
        AND COALESCE(
          observed_payment.value ->> 'amountNano',
          observed_payment.value ->> 'amountAtomic',
          ''
        ) ~ '^[1-9][0-9]*$'
        AND COALESCE(NULLIF(observed_payment.value ->> 'asset', ''), 'GRAM') = 'GRAM'
    )
  ) active_asset;

  gross_fiat_micros := COALESCE(
    payment_order."fiatAmountMicros",
    current_invoice."fiatAmountMicros",
    (current_invoice."fiatAmountCents"::NUMERIC * 10000)::TEXT
  );
  discount_fiat_micros := COALESCE(payment_order."discountFiatMicros", '0');
  net_fiat_micros := (gross_fiat_micros::NUMERIC - discount_fiat_micros::NUMERIC)::TEXT;
  event_key := topic_name || ':' || current_invoice."id" || ':' || current_invoice."version"::TEXT || ':' || txid_current()::TEXT;

  PERFORM "tonhub_enqueue_webhook_event"(
    event_key,
    topic_name,
    'TonhubPaymentInvoice',
    NEW."id",
    jsonb_build_object(
      'schemaVersion', 2,
      'invoiceId', current_invoice."id",
      'orderId', current_invoice."orderId",
      'externalId', payment_order."externalId",
      'status', current_invoice."status",
      'orderStatus', COALESCE(payment_order."status"::TEXT, current_invoice."status"::TEXT),
      'network', current_invoice."network",
      'asset', current_invoice."checkoutAsset",
      'selectedAsset', current_invoice."checkoutAsset",
      'creditedAssets', credited_assets,
      'assetKind', current_invoice."assetKind",
      'assetDecimals', current_invoice."assetDecimals",
      'paymentSelectionLockedAsset', current_invoice."paymentSelectionLockedAsset",
      'paymentSelectionLockedAt', current_invoice."paymentSelectionLockedAt",
      'fiatCurrency', current_invoice."fiatCurrency",
      'fiatAmountMicros', current_invoice."fiatAmountMicros",
      'grossFiatMicros', gross_fiat_micros,
      'discountFiatMicros', discount_fiat_micros,
      'netFiatMicros', net_fiat_micros,
      'creditedFiatMicros', current_invoice."creditedFiatMicros",
      'remainingFiatMicros', current_invoice."remainingFiatMicros",
      'orderCreditedFiatMicros', COALESCE(payment_order."creditedFiatMicros", current_invoice."creditedFiatMicros"),
      'orderOverpaymentFiatMicros', COALESCE(payment_order."overpaymentFiatMicros", '0'),
      'occurredAt', COALESCE(current_invoice."observedAt", current_invoice."updatedAt", CURRENT_TIMESTAMP)
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER "TonhubPaymentInvoice_webhook_outbox" ON "TonhubPaymentInvoice";
CREATE CONSTRAINT TRIGGER "TonhubPaymentInvoice_webhook_outbox"
AFTER UPDATE ON "TonhubPaymentInvoice"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "tonhub_invoice_webhook_outbox"();

CREATE OR REPLACE FUNCTION "tonhub_asset_sweep_webhook_outbox"() RETURNS trigger AS $$
DECLARE
  payment_order "TonhubPaymentOrder"%ROWTYPE;
BEGIN
  IF NEW."status" = 'FAILED' AND OLD."status" IS DISTINCT FROM 'FAILED' THEN
    IF NEW."orderId" IS NOT NULL THEN
      SELECT * INTO payment_order
      FROM "TonhubPaymentOrder"
      WHERE "id" = NEW."orderId";
    END IF;
    IF NEW."automaticSequence" IS NOT NULL AND payment_order."id" IS NULL THEN
      RAISE EXCEPTION 'automatic sweep % has no owned payment order', NEW."id";
    END IF;
    PERFORM "tonhub_enqueue_webhook_event"(
      'sweep.failed:asset:' || NEW."id" || ':' || txid_current()::TEXT,
      'sweep.failed',
      'TonhubAssetSweep',
      NEW."id",
      jsonb_build_object(
        'schemaVersion', 2,
        'sweepId', NEW."id",
        'depositAddressId', NEW."depositAddressId",
        'orderId', NEW."orderId",
        'invoiceId', NEW."invoiceId",
        'asset', NEW."asset",
        'assetKind', NEW."assetKind",
        'automaticSequence', NEW."automaticSequence",
        'triggerReason', NEW."triggerReason",
        'triggerFiatMicros', NEW."triggerFiatMicros",
        'triggerCreditedFiatMicros', NEW."triggerCreditedFiatMicros",
        'fiatCurrency', payment_order."fiatCurrency",
        'triggeredAt', NEW."triggeredAt",
        'attempts', NEW."attempts",
        'error', NEW."lastError",
        'occurredAt', NEW."updatedAt"
      )
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
