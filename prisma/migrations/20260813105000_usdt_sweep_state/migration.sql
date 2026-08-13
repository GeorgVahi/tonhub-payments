ALTER TABLE "TonhubAssetSweep"
ADD COLUMN "queryId" TEXT,
ADD COLUMN "gasTopupSeqno" INTEGER,
ADD COLUMN "reserveTopupAmountNano" TEXT,
ADD COLUMN "reserveTopupSeqno" INTEGER,
ADD COLUMN "gasServicePlanKey" TEXT;

ALTER TABLE "TonhubAssetSweep"
ADD CONSTRAINT "TonhubAssetSweep_seqnos_check" CHECK (
  "attempts" >= 0 AND
  ("seqno" IS NULL OR "seqno" >= 0) AND
  ("gasTopupSeqno" IS NULL OR "gasTopupSeqno" >= 0) AND
  ("reserveTopupSeqno" IS NULL OR "reserveTopupSeqno" >= 0)
),
ADD CONSTRAINT "TonhubAssetSweep_queryId_check" CHECK (
  "queryId" IS NULL OR (
    "queryId" ~ '^[0-9]{1,20}$' AND
    "queryId"::NUMERIC <= 18446744073709551615
  )
),
ADD CONSTRAINT "TonhubAssetSweep_usdt_lifecycle_check" CHECK (
  "asset" <> 'USDT' OR (
    "assetKind" = 'JETTON' AND
    (("gasTopupAmountNano" IS NULL) = ("gasTopupSeqno" IS NULL)) AND
    (("reserveTopupAmountNano" IS NULL) = ("reserveTopupSeqno" IS NULL)) AND
    (
      "reserveTopupAmountNano" IS NULL OR
      "reserveTopupAmountNano" ~ '^[1-9][0-9]*$'
    ) AND
    (
      "status" NOT IN ('GAS_TOPUP_REQUIRED', 'GAS_TOPUP_SENT') OR
      (
        "gasTopupAmountNano" ~ '^[1-9][0-9]*$' AND
        "gasTopupSeqno" IS NOT NULL AND
        "gasServicePlanKey" IS NOT NULL
      )
    ) AND
    (
      "status" NOT IN ('READY', 'SENT', 'CONFIRMED') OR
      (
        "amountAtomic" IS NOT NULL AND
        "amountAtomic" ~ '^[1-9][0-9]*$' AND
        "reserveAtomic" IS NOT NULL AND
        "reserveAtomic" = '0' AND
        "recipientAddress" IS NOT NULL AND
        LENGTH("recipientAddress") > 0 AND
        "queryId" IS NOT NULL AND
        "seqno" IS NOT NULL
      )
    ) AND
    ("status" <> 'SENT' OR "sentAt" IS NOT NULL) AND
    (
      "status" <> 'CONFIRMED' OR
      (
        "transactionHash" IS NOT NULL AND
        LENGTH("transactionHash") > 0 AND
        "sentAt" IS NOT NULL AND
        "confirmedAt" IS NOT NULL
      )
    )
  )
);

CREATE UNIQUE INDEX "TonhubAssetSweep_queryId_key"
ON "TonhubAssetSweep"("queryId")
WHERE "queryId" IS NOT NULL;

-- Serializes persisted top-up plans across every sweep and both initial-gas
-- and reserve-repair purposes, even after a process lease expires.
CREATE UNIQUE INDEX "TonhubAssetSweep_gasServicePlanKey_key"
ON "TonhubAssetSweep"("gasServicePlanKey");

-- Step 12 could already have journaled official USDT while the adapter flag was
-- enabled. Queue one rollout sweep per verified deposit whose immutable ledger
-- still has a positive USDT balance; replay and the active-sweep index keep this
-- backfill idempotent.
WITH "officialUsdtBalance" AS (
  SELECT
    movement."depositAddressId",
    SUM(
      CASE movement."direction"::TEXT
        WHEN 'INCOMING' THEN movement."amountAtomic"::NUMERIC
        ELSE -movement."amountAtomic"::NUMERIC
      END
    ) AS "unsweptAtomic"
  FROM "TonhubPaymentMovement" movement
  WHERE movement."network" = 'mainnet'
    AND movement."asset" = 'USDT'
    AND movement."assetKind" = 'JETTON'
    AND movement."assetDecimals" = 6
    AND movement."status"::TEXT <> 'REJECTED'
    AND movement."jettonMasterAddress" = '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe'
  GROUP BY movement."depositAddressId"
), "backfillCandidate" AS (
  SELECT DISTINCT ON (movement."depositAddressId")
    movement."id" AS "movementId",
    deposit."id" AS "depositAddressId",
    invoice."orderId",
    invoice."id" AS "invoiceId"
  FROM "TonhubPaymentMovement" movement
  JOIN "officialUsdtBalance" balance
    ON balance."depositAddressId" = movement."depositAddressId"
   AND balance."unsweptAtomic" > 0
  JOIN "TonhubDepositAddress" deposit
    ON deposit."id" = movement."depositAddressId"
  JOIN "TonhubPaymentInvoice" invoice
    ON invoice."id" = deposit."invoiceId"
  JOIN "TonhubDepositAssetAccount" account
    ON account."depositAddressId" = deposit."id"
   AND account."asset" = 'USDT'
  WHERE movement."network" = 'mainnet'
    AND movement."direction"::TEXT = 'INCOMING'
    AND movement."asset" = 'USDT'
    AND movement."assetKind" = 'JETTON'
    AND movement."assetDecimals" = 6
    AND movement."status"::TEXT <> 'REJECTED'
    AND movement."jettonMasterAddress" = '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe'
    AND movement."rawPayload" ->> 'officialUsdt' = 'true'
    AND movement."rawPayload" ->> 'internalTestAsset' IS DISTINCT FROM 'true'
    AND deposit."network" = 'mainnet'
    AND invoice."network" = 'mainnet'
    AND deposit."addressRaw" = invoice."addressRaw"
    AND movement."toAddress" = deposit."addressRaw"
    AND movement."ownerAddress" = deposit."addressRaw"
    AND account."network" = 'mainnet'
    AND account."assetKind" = 'JETTON'
    AND account."assetDecimals" = 6
    AND account."status" = 'VERIFIED'
    AND account."jettonMasterAddress" = movement."jettonMasterAddress"
    AND account."assetWalletAddress" = movement."jettonWalletAddress"
    AND NOT EXISTS (
      SELECT 1
      FROM "TonhubAssetSweep" sweep
      WHERE sweep."depositAddressId" = deposit."id"
        AND sweep."asset" = 'USDT'
        AND sweep."status" IN (
          'QUEUED', 'GAS_CHECK', 'GAS_TOPUP_REQUIRED', 'GAS_TOPUP_SENT',
          'READY', 'SENT', 'FAILED'
        )
    )
  ORDER BY movement."depositAddressId", movement."blockchainAt" DESC, movement."id" DESC
)
INSERT INTO "TonhubAssetSweep" (
  "id", "idempotencyKey", "depositAddressId", "orderId", "invoiceId",
  "asset", "assetKind", "status", "createdAt", "updatedAt"
)
SELECT
  'usdt-sweep-backfill:' || candidate."movementId",
  'official-usdt-movement:' || candidate."movementId",
  candidate."depositAddressId",
  candidate."orderId",
  candidate."invoiceId",
  'USDT',
  'JETTON',
  'QUEUED',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "backfillCandidate" candidate
ON CONFLICT DO NOTHING;
