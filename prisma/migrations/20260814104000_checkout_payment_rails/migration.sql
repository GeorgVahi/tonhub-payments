-- A checkout rail can change only while the attempt has no movement evidence.
-- The concrete instruction must always be the immutable quote selected for the
-- same invoice; after the first movement the complete instruction is frozen.
CREATE OR REPLACE FUNCTION "tonhub_assert_checkout_payment_rail_integrity"() RETURNS void AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "TonhubPaymentInvoice" AS invoice
    LEFT JOIN "TonhubPaymentQuote" AS selected_quote
      ON selected_quote."invoiceId" = invoice."id"
     AND selected_quote."asset" = invoice."checkoutAsset"
    LEFT JOIN "TonhubDepositAddress" AS deposit
      ON deposit."invoiceId" = invoice."id"
    WHERE EXISTS (
      SELECT 1 FROM "TonhubPaymentQuote" AS any_quote
      WHERE any_quote."invoiceId" = invoice."id"
    ) AND (
      selected_quote."id" IS NULL OR
      selected_quote."orderId" IS DISTINCT FROM invoice."orderId" OR
      selected_quote."network" IS DISTINCT FROM invoice."network" OR
      selected_quote."fiatCurrency" IS DISTINCT FROM invoice."fiatCurrency" OR
      invoice."asset" IS DISTINCT FROM selected_quote."asset" OR
      invoice."assetKind" IS DISTINCT FROM selected_quote."assetKind" OR
      invoice."assetDecimals" IS DISTINCT FROM selected_quote."assetDecimals" OR
      invoice."amountAtomic" IS DISTINCT FROM selected_quote."amountAtomic" OR
      invoice."amountNano" IS DISTINCT FROM selected_quote."amountAtomic" OR
      invoice."providerName" IS DISTINCT FROM (CASE
        WHEN selected_quote."assetKind" = 'JETTON' THEN 'ton-jetton-direct'
        ELSE 'ton-direct'
      END) OR
      invoice."addressStrategy" <> 'unique-address' OR
      deposit."id" IS NULL OR
      deposit."network" IS DISTINCT FROM invoice."network" OR
      deposit."address" IS DISTINCT FROM invoice."address" OR
      deposit."addressRaw" IS DISTINCT FROM invoice."addressRaw" OR
      deposit."walletVersion" IS DISTINCT FROM invoice."walletVersion" OR
      deposit."walletWorkchain" IS DISTINCT FROM invoice."walletWorkchain" OR
      deposit."walletContext" IS DISTINCT FROM invoice."walletContext" OR
      deposit."walletNetworkGlobalId" IS DISTINCT FROM invoice."walletNetworkGlobalId" OR
      deposit."walletPublicKeyHash" IS DISTINCT FROM invoice."walletPublicKeyHash" OR
      (
        EXISTS (
          SELECT 1
          FROM "TonhubPaymentMovement" AS movement
          WHERE movement."depositAddressId" = deposit."id"
            AND movement."direction" = 'INCOMING'
            AND movement."status" <> 'REJECTED'
        ) AND (
          invoice."paymentSelectionLockedAt" IS NULL OR
          invoice."paymentSelectionLockedAsset" IS DISTINCT FROM invoice."checkoutAsset"
        )
      )
    )
  ) THEN
    RAISE EXCEPTION 'quote-backed invoice payment rail integrity check failed'
      USING ERRCODE = '55000';
  END IF;
END;
$$ LANGUAGE plpgsql;

SELECT "tonhub_assert_checkout_payment_rail_integrity"();

CREATE OR REPLACE FUNCTION "tonhub_guard_invoice_payment_selection"() RETURNS trigger AS $$
DECLARE
  selected_quote "TonhubPaymentQuote"%ROWTYPE;
  legacy_instruction_backfill BOOLEAN;
BEGIN
  legacy_instruction_backfill :=
    OLD."asset" = 'GRAM' AND NEW."asset" = OLD."asset" AND
    OLD."checkoutAsset" = OLD."asset" AND NEW."checkoutAsset" = OLD."checkoutAsset" AND
    OLD."assetKind" = 'NATIVE' AND NEW."assetKind" = OLD."assetKind" AND
    OLD."assetDecimals" = 9 AND NEW."assetDecimals" = OLD."assetDecimals" AND
    OLD."amountAtomic" IS NULL AND NEW."amountAtomic" = OLD."amountNano" AND
    NEW."amountNano" = OLD."amountNano" AND
    NEW."providerName" IS NOT DISTINCT FROM OLD."providerName";

  IF ROW(
    OLD."address", OLD."addressRaw", OLD."addressStrategy", OLD."reference",
    OLD."walletVersion", OLD."walletWorkchain", OLD."walletContext",
    OLD."walletNetworkGlobalId", OLD."walletPublicKeyHash"
  ) IS DISTINCT FROM ROW(
    NEW."address", NEW."addressRaw", NEW."addressStrategy", NEW."reference",
    NEW."walletVersion", NEW."walletWorkchain", NEW."walletContext",
    NEW."walletNetworkGlobalId", NEW."walletPublicKeyHash"
  ) THEN
    RAISE EXCEPTION 'invoice deposit ownership and wallet derivation are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD."paymentSelectionLockedAt" IS NOT NULL AND ROW(
    OLD."asset", OLD."checkoutAsset", OLD."assetKind", OLD."assetDecimals",
    OLD."amountAtomic", OLD."amountNano", OLD."providerName",
    OLD."paymentSelectionLockedAsset", OLD."paymentSelectionLockedAt"
  ) IS DISTINCT FROM ROW(
    NEW."asset", NEW."checkoutAsset", NEW."assetKind", NEW."assetDecimals",
    NEW."amountAtomic", NEW."amountNano", NEW."providerName",
    NEW."paymentSelectionLockedAsset", NEW."paymentSelectionLockedAt"
  ) THEN
    RAISE EXCEPTION 'invoice payment instruction is immutable after its first movement'
      USING ERRCODE = '55000';
  END IF;

  IF ROW(
    OLD."asset", OLD."checkoutAsset", OLD."assetKind", OLD."assetDecimals",
    OLD."amountAtomic", OLD."amountNano", OLD."providerName"
  ) IS DISTINCT FROM ROW(
    NEW."asset", NEW."checkoutAsset", NEW."assetKind", NEW."assetDecimals",
    NEW."amountAtomic", NEW."amountNano", NEW."providerName"
  ) AND NOT legacy_instruction_backfill THEN
    IF OLD."status" <> 'PENDING' OR NEW."status" <> 'PENDING' OR
       OLD."paymentSelectionLockedAsset" IS NOT NULL OR OLD."paymentSelectionLockedAt" IS NOT NULL OR
       NEW."paymentSelectionLockedAsset" IS NOT NULL OR NEW."paymentSelectionLockedAt" IS NOT NULL OR
       OLD."firstMovementAt" IS NOT NULL OR NEW."firstMovementAt" IS NOT NULL OR
       OLD."observedAt" IS NOT NULL OR NEW."observedAt" IS NOT NULL OR
       OLD."creditedFiatMicros"::NUMERIC <> 0 OR NEW."creditedFiatMicros"::NUMERIC <> 0 OR
       COALESCE(OLD."paidAmountAtomic", OLD."paidNano", '0')::NUMERIC <> 0 OR
       COALESCE(NEW."paidAmountAtomic", NEW."paidNano", '0')::NUMERIC <> 0 OR
       EXISTS (
         SELECT 1
         FROM "TonhubDepositAddress" AS deposit
         JOIN "TonhubPaymentMovement" AS movement
           ON movement."depositAddressId" = deposit."id"
         WHERE deposit."invoiceId" = OLD."id"
           AND movement."direction" = 'INCOMING'
           AND movement."status" <> 'REJECTED'
       ) THEN
      RAISE EXCEPTION 'invoice payment method cannot change after movement or settlement evidence'
        USING ERRCODE = '55000';
    END IF;

    SELECT * INTO selected_quote
    FROM "TonhubPaymentQuote"
    WHERE "invoiceId" = OLD."id" AND "asset" = NEW."checkoutAsset"
    FOR KEY SHARE;

    IF NOT FOUND OR NEW."asset" IS DISTINCT FROM selected_quote."asset" OR
       NEW."assetKind" IS DISTINCT FROM selected_quote."assetKind" OR
       NEW."assetDecimals" IS DISTINCT FROM selected_quote."assetDecimals" OR
       NEW."amountAtomic" IS DISTINCT FROM selected_quote."amountAtomic" OR
       NEW."amountNano" IS DISTINCT FROM selected_quote."amountAtomic" OR
       NEW."providerName" IS DISTINCT FROM (CASE
         WHEN selected_quote."assetKind" = 'JETTON' THEN 'ton-jetton-direct'
         ELSE 'ton-direct'
       END) THEN
      RAISE EXCEPTION 'invoice payment instruction must match its immutable selected quote'
        USING ERRCODE = '23514';
    END IF;
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

CREATE FUNCTION "tonhub_lock_payment_selection_from_movement"() RETURNS trigger AS $$
DECLARE
  owning_invoice "TonhubPaymentInvoice"%ROWTYPE;
BEGIN
  IF NEW."direction" <> 'INCOMING' OR NEW."status" = 'REJECTED' THEN
    RETURN NEW;
  END IF;
  IF NEW."depositAddressId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT invoice.* INTO owning_invoice
  FROM "TonhubDepositAddress" AS deposit
  JOIN "TonhubPaymentInvoice" AS invoice ON invoice."id" = deposit."invoiceId"
  WHERE deposit."id" = NEW."depositAddressId"
  FOR UPDATE OF invoice;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF owning_invoice."paymentSelectionLockedAt" IS NULL AND
     owning_invoice."paymentSelectionLockedAsset" IS NULL THEN
    UPDATE "TonhubPaymentInvoice"
    SET "paymentSelectionLockedAsset" = owning_invoice."checkoutAsset",
        "paymentSelectionLockedAt" = NEW."blockchainAt"
    WHERE "id" = owning_invoice."id";
  ELSIF owning_invoice."paymentSelectionLockedAt" IS NULL OR
        owning_invoice."paymentSelectionLockedAsset" IS DISTINCT FROM owning_invoice."checkoutAsset" THEN
    RAISE EXCEPTION 'owning invoice has inconsistent payment-selection evidence'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TonhubPaymentMovement_lock_payment_selection"
BEFORE INSERT ON "TonhubPaymentMovement"
FOR EACH ROW EXECUTE FUNCTION "tonhub_lock_payment_selection_from_movement"();
