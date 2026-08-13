-- Orders created without a merchant id are valid; PostgreSQL keeps non-null ids unique.
ALTER TABLE "TonhubPaymentOrder" ALTER COLUMN "externalId" DROP NOT NULL;

-- Refuse to merge legacy data into an already-created order with different terms.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "TonhubPaymentInvoice" invoice
        JOIN "TonhubPaymentOrder" payment_order
          ON payment_order."externalId" = invoice."externalId"
        WHERE invoice."orderId" IS NULL
          AND invoice."externalId" IS NOT NULL
          AND (
              payment_order."fiatAmountMicros" <> (GREATEST(invoice."fiatAmountCents", 0)::bigint * 10000)::text OR
              payment_order."fiatCurrency" <> invoice."fiatCurrency"
          )
    ) THEN
        RAISE EXCEPTION 'legacy invoice terms conflict with an existing TonhubPaymentOrder';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "TonhubPaymentInvoice" invoice
        JOIN "TonhubPaymentOrder" payment_order
          ON payment_order."id" = 'legacy-order:' || invoice."id"
        WHERE invoice."orderId" IS NULL
          AND (
              payment_order."externalId" IS DISTINCT FROM invoice."externalId" OR
              payment_order."fiatAmountMicros" <> (GREATEST(invoice."fiatAmountCents", 0)::bigint * 10000)::text OR
              payment_order."fiatCurrency" <> invoice."fiatCurrency"
          )
    ) THEN
        RAISE EXCEPTION 'legacy invoice id conflicts with an existing TonhubPaymentOrder';
    END IF;
END $$;

WITH legacy_invoice AS (
    SELECT
        invoice.*,
        (GREATEST(invoice."fiatAmountCents", 0)::bigint * 10000)::text AS fiat_micros,
        CASE
            WHEN invoice."status" = 'PAID' THEN
                (GREATEST(invoice."fiatAmountCents", 0)::bigint * 10000)::text
            WHEN invoice."paidNano" ~ '^[0-9]+$'
              AND invoice."amountNano" ~ '^[0-9]+$'
              AND invoice."amountNano"::numeric > 0
              AND invoice."paidNano"::numeric > 0 THEN
                LEAST(
                    GREATEST(invoice."fiatAmountCents", 0)::numeric * 10000,
                    TRUNC(
                        GREATEST(invoice."fiatAmountCents", 0)::numeric * 10000 *
                        invoice."paidNano"::numeric / invoice."amountNano"::numeric
                    )
                )::text
            ELSE '0'
        END AS credited_micros
    FROM "TonhubPaymentInvoice" invoice
    WHERE invoice."orderId" IS NULL
)
INSERT INTO "TonhubPaymentOrder" (
    "id",
    "externalId",
    "fiatAmountMicros",
    "fiatCurrency",
    "creditedFiatMicros",
    "overpaymentFiatMicros",
    "status",
    "paidAt",
    "expiresAt",
    "cancelledAt",
    "createdAt",
    "updatedAt",
    "metadata"
)
SELECT
    'legacy-order:' || legacy_invoice."id",
    legacy_invoice."externalId",
    legacy_invoice.fiat_micros,
    legacy_invoice."fiatCurrency",
    legacy_invoice.credited_micros,
    '0',
    CASE
        WHEN legacy_invoice."status" = 'PENDING' THEN 'PENDING'::"TonhubPaymentOrderStatus"
        WHEN legacy_invoice."status" = 'PARTIAL' THEN 'PARTIAL'::"TonhubPaymentOrderStatus"
        WHEN legacy_invoice."status" = 'PAID' THEN 'PAID'::"TonhubPaymentOrderStatus"
        WHEN legacy_invoice."status" = 'EXPIRED' AND legacy_invoice.credited_micros::numeric > 0
          THEN 'RECOVERY'::"TonhubPaymentOrderStatus"
        WHEN legacy_invoice."status" = 'EXPIRED' THEN 'EXPIRED'::"TonhubPaymentOrderStatus"
        WHEN legacy_invoice."status" = 'CANCELLED' THEN 'CANCELLED'::"TonhubPaymentOrderStatus"
        ELSE 'FAILED'::"TonhubPaymentOrderStatus"
    END,
    CASE WHEN legacy_invoice."status" = 'PAID' THEN legacy_invoice."observedAt" ELSE NULL END,
    COALESCE(legacy_invoice."partialPaymentExpiresAt", legacy_invoice."expiresAt"),
    NULL,
    legacy_invoice."createdAt",
    legacy_invoice."updatedAt",
    legacy_invoice."metadata"
FROM legacy_invoice
WHERE legacy_invoice."externalId" IS NULL
   OR NOT EXISTS (
       SELECT 1
       FROM "TonhubPaymentOrder" payment_order
       WHERE payment_order."externalId" = legacy_invoice."externalId"
   )
ON CONFLICT DO NOTHING;

UPDATE "TonhubPaymentInvoice" invoice
SET "orderId" = COALESCE(
    (
        SELECT payment_order."id"
        FROM "TonhubPaymentOrder" payment_order
        WHERE invoice."externalId" IS NOT NULL
          AND payment_order."externalId" = invoice."externalId"
        LIMIT 1
    ),
    'legacy-order:' || invoice."id"
)
WHERE invoice."orderId" IS NULL;

UPDATE "TonhubPaymentInvoice" invoice
SET
    "checkoutAsset" = CASE WHEN invoice."asset" = 'TON' THEN 'GRAM' ELSE invoice."asset" END,
    "assetKind" = 'NATIVE',
    "assetDecimals" = 9,
    "fiatAmountMicros" = payment_order."fiatAmountMicros",
    "creditedFiatMicros" = payment_order."creditedFiatMicros",
    "remainingFiatMicros" = (
        GREATEST(
            payment_order."fiatAmountMicros"::numeric - payment_order."creditedFiatMicros"::numeric,
            0
        )
    )::text,
    "amountAtomic" = invoice."amountNano",
    "paidAmountAtomic" = invoice."paidNano",
    "firstMovementAt" = COALESCE(
        invoice."partialPaymentStartedAt",
        CASE
            WHEN invoice."paidNano" ~ '^[0-9]+$' AND invoice."paidNano"::numeric > 0
              THEN invoice."observedAt"
            ELSE NULL
        END
    ),
    "scanPriorityAt" = CASE
        WHEN invoice."status" IN ('PENDING', 'PARTIAL') THEN invoice."createdAt"
        ELSE NULL
    END,
    "settlementReason" = CASE
        WHEN invoice."status" = 'PAID' THEN 'LEGACY_PAID_BACKFILL'
        WHEN invoice."status" = 'EXPIRED' THEN 'LEGACY_EXPIRED_BACKFILL'
        ELSE invoice."settlementReason"
    END
FROM "TonhubPaymentOrder" payment_order
WHERE invoice."orderId" = payment_order."id";
