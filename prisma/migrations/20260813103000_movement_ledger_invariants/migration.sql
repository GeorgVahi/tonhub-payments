-- One immutable on-chain movement credits at most one fiat order.
CREATE UNIQUE INDEX "TonhubMovementAllocation_one_credit_per_movement_key"
ON "TonhubMovementAllocation"("movementId")
WHERE "kind" = 'CREDIT';

-- Validate every supported rate policy at the database boundary. The same
-- function also audits snapshots written before this migration.
CREATE FUNCTION "tonhub_rate_snapshot_is_valid"(candidate "TonhubRateSnapshot")
RETURNS BOOLEAN AS $$
DECLARE
    gram_eur "TonhubRateSnapshot"%ROWTYPE;
    gram_usd "TonhubRateSnapshot"%ROWTYPE;
    gram_eur_id TEXT;
    gram_usd_id TEXT;
BEGIN
    IF candidate."price" <= 0 OR candidate."asset" IS DISTINCT FROM candidate."baseCurrency" OR
       candidate."observedAt" > candidate."fetchedAt" THEN
        RETURN FALSE;
    END IF;

    IF candidate."asset" = 'GRAM' THEN
        RETURN candidate."source" = 'coingecko' AND candidate."quoteCurrency" IN ('USD', 'EUR');
    END IF;

    IF candidate."asset" <> 'USDT' OR candidate."source" <> 'usd-peg' OR
       candidate."quoteCurrency" NOT IN ('USD', 'EUR') THEN
        RETURN FALSE;
    END IF;

    IF candidate."quoteCurrency" = 'USD' THEN
        RETURN candidate."price" = 1 AND
          candidate."payload" ->> 'policy' = '1 USDT = 1 USD';
    END IF;

    IF candidate."payload" ->> 'policy' IS DISTINCT FROM '1 USDT = 1 USD' OR
       candidate."payload" ->> 'derivation' IS DISTINCT FROM 'GRAM/EUR divided by GRAM/USD' THEN
        RETURN FALSE;
    END IF;

    gram_eur_id := candidate."payload" #>> '{components,gramEur,snapshotId}';
    gram_usd_id := candidate."payload" #>> '{components,gramUsd,snapshotId}';
    IF gram_eur_id IS NULL OR gram_usd_id IS NULL OR gram_eur_id = gram_usd_id THEN
        RETURN FALSE;
    END IF;

    SELECT * INTO gram_eur FROM "TonhubRateSnapshot" WHERE "id" = gram_eur_id;
    SELECT * INTO gram_usd FROM "TonhubRateSnapshot" WHERE "id" = gram_usd_id;
    IF gram_eur."id" IS NULL OR gram_usd."id" IS NULL OR
       gram_eur."asset" <> 'GRAM' OR gram_eur."baseCurrency" <> 'GRAM' OR
       gram_eur."quoteCurrency" <> 'EUR' OR gram_eur."source" <> 'coingecko' OR
       gram_usd."asset" <> 'GRAM' OR gram_usd."baseCurrency" <> 'GRAM' OR
       gram_usd."quoteCurrency" <> 'USD' OR gram_usd."source" <> 'coingecko' THEN
        RETURN FALSE;
    END IF;

    RETURN candidate."price" = ROUND(gram_eur."price" / gram_usd."price", 18) AND
      candidate."observedAt" = GREATEST(gram_eur."observedAt", gram_usd."observedAt") AND
      candidate."fetchedAt" >= GREATEST(gram_eur."fetchedAt", gram_usd."fetchedAt") AND
      candidate."payload" #>> '{components,gramEur,quoteCurrency}' = 'EUR' AND
      candidate."payload" #>> '{components,gramEur,source}' = 'coingecko' AND
      (candidate."payload" #>> '{components,gramEur,price}')::NUMERIC = gram_eur."price" AND
      ((candidate."payload" #>> '{components,gramEur,observedAt}')::TIMESTAMPTZ AT TIME ZONE 'UTC') = gram_eur."observedAt" AND
      ((candidate."payload" #>> '{components,gramEur,fetchedAt}')::TIMESTAMPTZ AT TIME ZONE 'UTC') = gram_eur."fetchedAt" AND
      candidate."payload" #>> '{components,gramUsd,quoteCurrency}' = 'USD' AND
      candidate."payload" #>> '{components,gramUsd,source}' = 'coingecko' AND
      (candidate."payload" #>> '{components,gramUsd,price}')::NUMERIC = gram_usd."price" AND
      ((candidate."payload" #>> '{components,gramUsd,observedAt}')::TIMESTAMPTZ AT TIME ZONE 'UTC') = gram_usd."observedAt" AND
      ((candidate."payload" #>> '{components,gramUsd,fetchedAt}')::TIMESTAMPTZ AT TIME ZONE 'UTC') = gram_usd."fetchedAt";
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
    existing_snapshot "TonhubRateSnapshot"%ROWTYPE;
BEGIN
    FOR existing_snapshot IN SELECT * FROM "TonhubRateSnapshot" LOOP
        IF "tonhub_rate_snapshot_is_valid"(existing_snapshot) IS NOT TRUE THEN
            RAISE EXCEPTION 'existing rate snapshot violates payment rate policy: %', existing_snapshot."id"
              USING ERRCODE = '23514';
        END IF;
    END LOOP;
END;
$$;

CREATE FUNCTION "tonhub_validate_rate_snapshot_insert"() RETURNS trigger AS $$
BEGIN
    IF "tonhub_rate_snapshot_is_valid"(NEW) IS NOT TRUE THEN
        RAISE EXCEPTION 'rate snapshot violates payment rate policy' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TonhubRateSnapshot_validate_insert"
BEFORE INSERT ON "TonhubRateSnapshot"
FOR EACH ROW EXECUTE FUNCTION "tonhub_validate_rate_snapshot_insert"();

-- Allocation rows must agree with their terminal movement evidence and owning invoice.
CREATE OR REPLACE FUNCTION "tonhub_validate_movement_allocation"() RETURNS trigger AS $$
DECLARE
    original "TonhubMovementAllocation"%ROWTYPE;
    movement "TonhubPaymentMovement"%ROWTYPE;
    rate_snapshot "TonhubRateSnapshot"%ROWTYPE;
    order_currency TEXT;
    invoice_order_id TEXT;
    invoice_deposit_id TEXT;
    calculated_credit TEXT;
BEGIN
    IF NEW."kind" = 'CREDIT' THEN
        SELECT * INTO movement
        FROM "TonhubPaymentMovement"
        WHERE "id" = NEW."movementId"
        FOR KEY SHARE;

        IF NOT FOUND OR movement."direction" <> 'INCOMING' OR movement."status" <> 'CREDITED' OR
           movement."fiatCreditMicros" IS DISTINCT FROM NEW."fiatCreditMicros" THEN
            RAISE EXCEPTION 'a credit allocation must exactly match a CREDITED movement'
              USING ERRCODE = '23514';
        END IF;

        SELECT "fiatCurrency" INTO order_currency
        FROM "TonhubPaymentOrder"
        WHERE "id" = NEW."orderId"
        FOR KEY SHARE;

        SELECT * INTO rate_snapshot
        FROM "TonhubRateSnapshot"
        WHERE "id" = movement."rateSnapshotId"
        FOR KEY SHARE;

        IF NOT FOUND OR rate_snapshot."asset" IS DISTINCT FROM movement."asset" OR
           rate_snapshot."baseCurrency" IS DISTINCT FROM movement."asset" OR
           rate_snapshot."quoteCurrency" IS DISTINCT FROM order_currency OR
           rate_snapshot."observedAt" > movement."blockchainAt" OR
           "tonhub_rate_snapshot_is_valid"(rate_snapshot) IS NOT TRUE OR
           (movement."asset" = 'GRAM' AND ROW(movement."assetKind", movement."assetDecimals") IS DISTINCT FROM ROW('NATIVE', 9)) OR
           (movement."asset" = 'USDT' AND ROW(movement."assetKind", movement."assetDecimals") IS DISTINCT FROM ROW('JETTON', 6)) OR
           movement."asset" NOT IN ('GRAM', 'USDT') THEN
            RAISE EXCEPTION 'movement rate evidence does not match its asset, order, or blockchain time'
              USING ERRCODE = '23514';
        END IF;

        calculated_credit := FLOOR(
            movement."amountAtomic"::NUMERIC * rate_snapshot."price" * 1000000::NUMERIC /
            POWER(10::NUMERIC, movement."assetDecimals")
        )::TEXT;

        IF calculated_credit IS DISTINCT FROM NEW."fiatCreditMicros" THEN
            RAISE EXCEPTION 'movement fiat credit does not match exact rate valuation'
              USING ERRCODE = '23514';
        END IF;

        IF NEW."invoiceId" IS NULL THEN
            RAISE EXCEPTION 'automatic credit allocation requires an owning invoice'
              USING ERRCODE = '23514';
        END IF;

        SELECT invoice."orderId", deposit."id" INTO invoice_order_id, invoice_deposit_id
        FROM "TonhubPaymentInvoice" AS invoice
        LEFT JOIN "TonhubDepositAddress" AS deposit ON deposit."invoiceId" = invoice."id"
        WHERE invoice."id" = NEW."invoiceId";

        IF NOT FOUND OR movement."depositAddressId" IS NULL OR invoice_deposit_id IS NULL OR
           invoice_order_id IS DISTINCT FROM NEW."orderId" OR
           invoice_deposit_id IS DISTINCT FROM movement."depositAddressId" THEN
            RAISE EXCEPTION 'an allocation invoice, order, and deposit movement must belong together'
              USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
    END IF;

    IF NEW."reversesAllocationId" = NEW."id" THEN
        RAISE EXCEPTION 'an allocation cannot reverse itself' USING ERRCODE = '23514';
    END IF;

    SELECT * INTO original
    FROM "TonhubMovementAllocation"
    WHERE "id" = NEW."reversesAllocationId"
    FOR KEY SHARE;

    IF NOT FOUND OR original."kind" <> 'CREDIT' THEN
        RAISE EXCEPTION 'a reversal must reference an existing CREDIT allocation' USING ERRCODE = '23514';
    END IF;

    IF ROW(
        NEW."movementId", NEW."orderId", NEW."invoiceId", NEW."fiatCreditMicros"
    ) IS DISTINCT FROM ROW(
        original."movementId", original."orderId", original."invoiceId", original."fiatCreditMicros"
    ) THEN
        RAISE EXCEPTION 'a reversal must exactly mirror the original allocation' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
