-- New enum types are additive; the legacy invoice status remains unchanged.
CREATE TYPE "TonhubPaymentOrderStatus" AS ENUM ('PENDING', 'PARTIAL', 'PAID', 'EXPIRED', 'CANCELLED', 'FAILED', 'RECOVERY');
CREATE TYPE "TonhubPaymentMovementDirection" AS ENUM ('INCOMING', 'OUTGOING');
CREATE TYPE "TonhubPaymentMovementStatus" AS ENUM ('OBSERVED', 'VALIDATED', 'RATE_PENDING', 'HELD_UNDER_MINIMUM', 'CREDITED', 'RECOVERY', 'REJECTED');
CREATE TYPE "TonhubMovementAllocationKind" AS ENUM ('CREDIT', 'REVERSAL');
CREATE TYPE "TonhubAssetSweepStatus" AS ENUM ('QUEUED', 'GAS_CHECK', 'GAS_TOPUP_REQUIRED', 'GAS_TOPUP_SENT', 'READY', 'SENT', 'CONFIRMED', 'FAILED');
CREATE TYPE "TonhubRecoveryCaseStatus" AS ENUM ('OPEN', 'REVIEWED', 'RESOLVED', 'IGNORED');
CREATE TYPE "TonhubOutboxEventStatus" AS ENUM ('PENDING', 'DELIVERING', 'DELIVERED', 'FAILED');

-- Keep every legacy column intact so the existing GRAM runtime remains deployable.
ALTER TABLE "TonhubPaymentInvoice" ADD COLUMN "activationThresholdFiatMicros" TEXT,
ADD COLUMN "amountAtomic" TEXT,
ADD COLUMN "assetDecimals" INTEGER NOT NULL DEFAULT 9,
ADD COLUMN "assetKind" TEXT NOT NULL DEFAULT 'NATIVE',
ADD COLUMN "checkoutAsset" TEXT NOT NULL DEFAULT 'GRAM',
ADD COLUMN "creditedFiatMicros" TEXT NOT NULL DEFAULT '0',
ADD COLUMN "fiatAmountMicros" TEXT,
ADD COLUMN "firstMovementAt" TIMESTAMP(3),
ADD COLUMN "lastScannedAt" TIMESTAMP(3),
ADD COLUMN "orderId" TEXT,
ADD COLUMN "paidAmountAtomic" TEXT,
ADD COLUMN "remainingFiatMicros" TEXT,
ADD COLUMN "scanPriorityAt" TIMESTAMP(3),
ADD COLUMN "settlementReason" TEXT,
ADD COLUMN "terminalMonitorUntil" TIMESTAMP(3),
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "TonhubPaymentOrder" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "fiatAmountMicros" TEXT NOT NULL,
    "fiatCurrency" TEXT NOT NULL,
    "creditedFiatMicros" TEXT NOT NULL DEFAULT '0',
    "overpaymentFiatMicros" TEXT NOT NULL DEFAULT '0',
    "status" "TonhubPaymentOrderStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "TonhubPaymentOrder_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TonhubPaymentOrder_amounts_check" CHECK (
        "fiatAmountMicros" ~ '^[0-9]+$' AND
        "creditedFiatMicros" ~ '^[0-9]+$' AND
        "overpaymentFiatMicros" ~ '^[0-9]+$'
    )
);

CREATE TABLE "TonhubDepositAssetAccount" (
    "id" TEXT NOT NULL,
    "depositAddressId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "assetKind" TEXT NOT NULL,
    "assetDecimals" INTEGER NOT NULL,
    "jettonMasterAddress" TEXT,
    "assetWalletAddress" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "verifiedAt" TIMESTAMP(3),
    "verificationError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TonhubDepositAssetAccount_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TonhubDepositAssetAccount_decimals_check" CHECK ("assetDecimals" BETWEEN 0 AND 255)
);

CREATE TABLE "TonhubRateSnapshot" (
    "id" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "baseCurrency" TEXT NOT NULL,
    "quoteCurrency" TEXT NOT NULL,
    "price" DECIMAL(36,18) NOT NULL,
    "source" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB,

    CONSTRAINT "TonhubRateSnapshot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TonhubRateSnapshot_price_check" CHECK ("price" > 0)
);

CREATE TABLE "TonhubPaymentMovement" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "depositAddressId" TEXT,
    "network" TEXT NOT NULL,
    "direction" "TonhubPaymentMovementDirection" NOT NULL,
    "asset" TEXT NOT NULL,
    "assetKind" TEXT NOT NULL,
    "assetDecimals" INTEGER NOT NULL,
    "amountAtomic" TEXT NOT NULL,
    "fromAddress" TEXT,
    "toAddress" TEXT NOT NULL,
    "ownerAddress" TEXT,
    "jettonMasterAddress" TEXT,
    "jettonWalletAddress" TEXT,
    "transactionHash" TEXT NOT NULL,
    "transactionLt" TEXT,
    "traceId" TEXT,
    "queryId" TEXT,
    "blockchainAt" TIMESTAMP(3) NOT NULL,
    "status" "TonhubPaymentMovementStatus" NOT NULL DEFAULT 'OBSERVED',
    "validationCode" TEXT,
    "rateSnapshotId" TEXT,
    "fiatCreditMicros" TEXT,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TonhubPaymentMovement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TonhubPaymentMovement_amount_check" CHECK ("amountAtomic" ~ '^[0-9]+$'),
    CONSTRAINT "TonhubPaymentMovement_credit_check" CHECK ("fiatCreditMicros" IS NULL OR "fiatCreditMicros" ~ '^[0-9]+$'),
    CONSTRAINT "TonhubPaymentMovement_decimals_check" CHECK ("assetDecimals" BETWEEN 0 AND 255),
    CONSTRAINT "TonhubPaymentMovement_credited_evidence_check" CHECK (
        "status" <> 'CREDITED' OR
        ("validationCode" IS NOT NULL AND "rateSnapshotId" IS NOT NULL AND "fiatCreditMicros" IS NOT NULL)
    ),
    CONSTRAINT "TonhubPaymentMovement_rejected_evidence_check" CHECK (
        "status" <> 'REJECTED' OR "validationCode" IS NOT NULL
    )
);

CREATE TABLE "TonhubMovementAllocation" (
    "id" TEXT NOT NULL,
    "movementId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "kind" "TonhubMovementAllocationKind" NOT NULL DEFAULT 'CREDIT',
    "reversesAllocationId" TEXT,
    "fiatCreditMicros" TEXT NOT NULL,
    "allocatedBy" TEXT NOT NULL DEFAULT 'system',
    "allocatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "TonhubMovementAllocation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TonhubMovementAllocation_credit_check" CHECK ("fiatCreditMicros" ~ '^[0-9]+$'),
    CONSTRAINT "TonhubMovementAllocation_kind_check" CHECK (
        ("kind" = 'CREDIT' AND "reversesAllocationId" IS NULL) OR
        ("kind" = 'REVERSAL' AND "reversesAllocationId" IS NOT NULL)
    )
);

CREATE TABLE "TonhubScanCursor" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "streamType" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "lastLt" TEXT,
    "lastTimestamp" TIMESTAMP(3),
    "lastHash" TEXT,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TonhubScanCursor_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TonhubAssetSweep" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "depositAddressId" TEXT NOT NULL,
    "orderId" TEXT,
    "invoiceId" TEXT,
    "asset" TEXT NOT NULL,
    "assetKind" TEXT NOT NULL,
    "status" "TonhubAssetSweepStatus" NOT NULL DEFAULT 'QUEUED',
    "amountAtomic" TEXT,
    "reserveAtomic" TEXT,
    "recipientAddress" TEXT,
    "transactionHash" TEXT,
    "seqno" INTEGER,
    "gasTopupAmountNano" TEXT,
    "gasTopupTransactionHash" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TonhubAssetSweep_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TonhubAssetSweep_amounts_check" CHECK (
        ("amountAtomic" IS NULL OR "amountAtomic" ~ '^[0-9]+$') AND
        ("reserveAtomic" IS NULL OR "reserveAtomic" ~ '^[0-9]+$') AND
        ("gasTopupAmountNano" IS NULL OR "gasTopupAmountNano" ~ '^[0-9]+$')
    )
);

CREATE TABLE "TonhubRecoveryCase" (
    "id" TEXT NOT NULL,
    "movementId" TEXT,
    "orderId" TEXT,
    "invoiceId" TEXT,
    "reason" TEXT NOT NULL,
    "status" "TonhubRecoveryCaseStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "details" JSONB,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TonhubRecoveryCase_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TonhubOutboxEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "TonhubOutboxEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TonhubOutboxEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TonhubAdminAuditEvent" (
    "id" TEXT NOT NULL,
    "adminUsername" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TonhubAdminAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TonhubPaymentOrder_externalId_key" ON "TonhubPaymentOrder"("externalId");
CREATE INDEX "TonhubPaymentOrder_status_createdAt_idx" ON "TonhubPaymentOrder"("status", "createdAt");
CREATE INDEX "TonhubPaymentOrder_status_expiresAt_idx" ON "TonhubPaymentOrder"("status", "expiresAt");

CREATE INDEX "TonhubDepositAssetAccount_asset_status_idx" ON "TonhubDepositAssetAccount"("asset", "status");
CREATE INDEX "TonhubDepositAssetAccount_jettonMasterAddress_assetWalletAd_idx" ON "TonhubDepositAssetAccount"("jettonMasterAddress", "assetWalletAddress");
CREATE UNIQUE INDEX "TonhubDepositAssetAccount_depositAddressId_asset_key" ON "TonhubDepositAssetAccount"("depositAddressId", "asset");
CREATE UNIQUE INDEX "TonhubDepositAssetAccount_network_assetWalletAddress_key" ON "TonhubDepositAssetAccount"("network", "assetWalletAddress");

CREATE INDEX "TonhubRateSnapshot_asset_quoteCurrency_observedAt_idx" ON "TonhubRateSnapshot"("asset", "quoteCurrency", "observedAt");
CREATE UNIQUE INDEX "TonhubRateSnapshot_asset_baseCurrency_quoteCurrency_source__key" ON "TonhubRateSnapshot"("asset", "baseCurrency", "quoteCurrency", "source", "observedAt");

CREATE UNIQUE INDEX "TonhubPaymentMovement_fingerprint_key" ON "TonhubPaymentMovement"("fingerprint");
CREATE INDEX "TonhubPaymentMovement_depositAddressId_asset_blockchainAt_idx" ON "TonhubPaymentMovement"("depositAddressId", "asset", "blockchainAt");
CREATE INDEX "TonhubPaymentMovement_network_status_blockchainAt_idx" ON "TonhubPaymentMovement"("network", "status", "blockchainAt");
CREATE INDEX "TonhubPaymentMovement_transactionHash_idx" ON "TonhubPaymentMovement"("transactionHash");
CREATE INDEX "TonhubPaymentMovement_jettonMasterAddress_jettonWalletAddre_idx" ON "TonhubPaymentMovement"("jettonMasterAddress", "jettonWalletAddress");

CREATE UNIQUE INDEX "TonhubMovementAllocation_reversesAllocationId_key" ON "TonhubMovementAllocation"("reversesAllocationId");
CREATE INDEX "TonhubMovementAllocation_movementId_kind_idx" ON "TonhubMovementAllocation"("movementId", "kind");
CREATE INDEX "TonhubMovementAllocation_orderId_allocatedAt_idx" ON "TonhubMovementAllocation"("orderId", "allocatedAt");
CREATE INDEX "TonhubMovementAllocation_invoiceId_allocatedAt_idx" ON "TonhubMovementAllocation"("invoiceId", "allocatedAt");

CREATE INDEX "TonhubScanCursor_leaseExpiresAt_idx" ON "TonhubScanCursor"("leaseExpiresAt");
CREATE UNIQUE INDEX "TonhubScanCursor_network_streamType_scopeKey_key" ON "TonhubScanCursor"("network", "streamType", "scopeKey");

CREATE INDEX "TonhubAssetSweep_status_leaseExpiresAt_idx" ON "TonhubAssetSweep"("status", "leaseExpiresAt");
CREATE UNIQUE INDEX "TonhubAssetSweep_idempotencyKey_key" ON "TonhubAssetSweep"("idempotencyKey");
CREATE INDEX "TonhubAssetSweep_depositAddressId_asset_createdAt_idx" ON "TonhubAssetSweep"("depositAddressId", "asset", "createdAt");
CREATE INDEX "TonhubAssetSweep_orderId_createdAt_idx" ON "TonhubAssetSweep"("orderId", "createdAt");
CREATE INDEX "TonhubAssetSweep_invoiceId_createdAt_idx" ON "TonhubAssetSweep"("invoiceId", "createdAt");

CREATE INDEX "TonhubRecoveryCase_status_createdAt_idx" ON "TonhubRecoveryCase"("status", "createdAt");
CREATE INDEX "TonhubRecoveryCase_movementId_idx" ON "TonhubRecoveryCase"("movementId");
CREATE INDEX "TonhubRecoveryCase_orderId_idx" ON "TonhubRecoveryCase"("orderId");
CREATE INDEX "TonhubRecoveryCase_invoiceId_idx" ON "TonhubRecoveryCase"("invoiceId");

CREATE UNIQUE INDEX "TonhubOutboxEvent_eventId_key" ON "TonhubOutboxEvent"("eventId");
CREATE INDEX "TonhubOutboxEvent_status_availableAt_idx" ON "TonhubOutboxEvent"("status", "availableAt");
CREATE INDEX "TonhubOutboxEvent_aggregateType_aggregateId_createdAt_idx" ON "TonhubOutboxEvent"("aggregateType", "aggregateId", "createdAt");
CREATE INDEX "TonhubOutboxEvent_leaseExpiresAt_idx" ON "TonhubOutboxEvent"("leaseExpiresAt");

CREATE INDEX "TonhubAdminAuditEvent_targetType_targetId_createdAt_idx" ON "TonhubAdminAuditEvent"("targetType", "targetId", "createdAt");
CREATE INDEX "TonhubAdminAuditEvent_adminUsername_createdAt_idx" ON "TonhubAdminAuditEvent"("adminUsername", "createdAt");

CREATE INDEX "TonhubPaymentInvoice_orderId_status_createdAt_idx" ON "TonhubPaymentInvoice"("orderId", "status", "createdAt");
CREATE INDEX "TonhubPaymentInvoice_status_scanPriorityAt_idx" ON "TonhubPaymentInvoice"("status", "scanPriorityAt");
CREATE INDEX "TonhubPaymentInvoice_status_terminalMonitorUntil_idx" ON "TonhubPaymentInvoice"("status", "terminalMonitorUntil");

-- One order may have multiple historical attempts, but never two active attempts.
CREATE UNIQUE INDEX "TonhubPaymentInvoice_one_active_attempt_per_order_key"
ON "TonhubPaymentInvoice"("orderId")
WHERE "orderId" IS NOT NULL AND "status" IN ('PENDING', 'PARTIAL');

-- A deposit asset may have historical sweeps, but only one in-flight lifecycle.
CREATE UNIQUE INDEX "TonhubAssetSweep_one_active_per_deposit_asset_key"
ON "TonhubAssetSweep"("depositAddressId", "asset")
WHERE "status" IN ('QUEUED', 'GAS_CHECK', 'GAS_TOPUP_REQUIRED', 'GAS_TOPUP_SENT', 'READY', 'SENT', 'FAILED');

CREATE UNIQUE INDEX "TonhubAssetSweep_transactionHash_key"
ON "TonhubAssetSweep"("transactionHash")
WHERE "transactionHash" IS NOT NULL;

CREATE UNIQUE INDEX "TonhubAssetSweep_gasTopupTransactionHash_key"
ON "TonhubAssetSweep"("gasTopupTransactionHash")
WHERE "gasTopupTransactionHash" IS NOT NULL;

ALTER TABLE "TonhubPaymentInvoice" ADD CONSTRAINT "TonhubPaymentInvoice_assetDecimals_check" CHECK ("assetDecimals" BETWEEN 0 AND 255);
ALTER TABLE "TonhubPaymentInvoice" ADD CONSTRAINT "TonhubPaymentInvoice_atomic_amounts_check" CHECK (
    ("amountAtomic" IS NULL OR "amountAtomic" ~ '^[0-9]+$') AND
    ("paidAmountAtomic" IS NULL OR "paidAmountAtomic" ~ '^[0-9]+$')
);
ALTER TABLE "TonhubPaymentInvoice" ADD CONSTRAINT "TonhubPaymentInvoice_fiat_amounts_check" CHECK (
    ("fiatAmountMicros" IS NULL OR "fiatAmountMicros" ~ '^[0-9]+$') AND
    "creditedFiatMicros" ~ '^[0-9]+$' AND
    ("remainingFiatMicros" IS NULL OR "remainingFiatMicros" ~ '^[0-9]+$') AND
    ("activationThresholdFiatMicros" IS NULL OR "activationThresholdFiatMicros" ~ '^[0-9]+$')
);

ALTER TABLE "TonhubPaymentInvoice" ADD CONSTRAINT "TonhubPaymentInvoice_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "TonhubPaymentOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TonhubDepositAssetAccount" ADD CONSTRAINT "TonhubDepositAssetAccount_depositAddressId_fkey" FOREIGN KEY ("depositAddressId") REFERENCES "TonhubDepositAddress"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TonhubPaymentMovement" ADD CONSTRAINT "TonhubPaymentMovement_depositAddressId_fkey" FOREIGN KEY ("depositAddressId") REFERENCES "TonhubDepositAddress"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TonhubPaymentMovement" ADD CONSTRAINT "TonhubPaymentMovement_rateSnapshotId_fkey" FOREIGN KEY ("rateSnapshotId") REFERENCES "TonhubRateSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TonhubMovementAllocation" ADD CONSTRAINT "TonhubMovementAllocation_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "TonhubPaymentMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TonhubMovementAllocation" ADD CONSTRAINT "TonhubMovementAllocation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "TonhubPaymentOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TonhubMovementAllocation" ADD CONSTRAINT "TonhubMovementAllocation_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "TonhubPaymentInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TonhubMovementAllocation" ADD CONSTRAINT "TonhubMovementAllocation_reversesAllocationId_fkey" FOREIGN KEY ("reversesAllocationId") REFERENCES "TonhubMovementAllocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TonhubAssetSweep" ADD CONSTRAINT "TonhubAssetSweep_depositAddressId_fkey" FOREIGN KEY ("depositAddressId") REFERENCES "TonhubDepositAddress"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TonhubAssetSweep" ADD CONSTRAINT "TonhubAssetSweep_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "TonhubPaymentOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TonhubAssetSweep" ADD CONSTRAINT "TonhubAssetSweep_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "TonhubPaymentInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TonhubRecoveryCase" ADD CONSTRAINT "TonhubRecoveryCase_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "TonhubPaymentMovement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TonhubRecoveryCase" ADD CONSTRAINT "TonhubRecoveryCase_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "TonhubPaymentOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TonhubRecoveryCase" ADD CONSTRAINT "TonhubRecoveryCase_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "TonhubPaymentInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Immutable financial facts are protected in the database, not only by repository convention.
CREATE FUNCTION "tonhub_reject_immutable_row_change"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TonhubRateSnapshot_append_only"
BEFORE UPDATE OR DELETE ON "TonhubRateSnapshot"
FOR EACH ROW EXECUTE FUNCTION "tonhub_reject_immutable_row_change"();

CREATE TRIGGER "TonhubMovementAllocation_append_only"
BEFORE UPDATE OR DELETE ON "TonhubMovementAllocation"
FOR EACH ROW EXECUTE FUNCTION "tonhub_reject_immutable_row_change"();

CREATE TRIGGER "TonhubAdminAuditEvent_append_only"
BEFORE UPDATE OR DELETE ON "TonhubAdminAuditEvent"
FOR EACH ROW EXECUTE FUNCTION "tonhub_reject_immutable_row_change"();

CREATE TRIGGER "TonhubRateSnapshot_no_truncate"
BEFORE TRUNCATE ON "TonhubRateSnapshot"
FOR EACH STATEMENT EXECUTE FUNCTION "tonhub_reject_immutable_row_change"();

CREATE TRIGGER "TonhubMovementAllocation_no_truncate"
BEFORE TRUNCATE ON "TonhubMovementAllocation"
FOR EACH STATEMENT EXECUTE FUNCTION "tonhub_reject_immutable_row_change"();

CREATE TRIGGER "TonhubAdminAuditEvent_no_truncate"
BEFORE TRUNCATE ON "TonhubAdminAuditEvent"
FOR EACH STATEMENT EXECUTE FUNCTION "tonhub_reject_immutable_row_change"();

-- A reversal is a full compensating entry for exactly one original CREDIT row.
CREATE FUNCTION "tonhub_validate_movement_allocation"() RETURNS trigger AS $$
DECLARE
    original "TonhubMovementAllocation"%ROWTYPE;
BEGIN
    IF NEW."kind" = 'CREDIT' THEN
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

CREATE TRIGGER "TonhubMovementAllocation_validate_insert"
BEFORE INSERT ON "TonhubMovementAllocation"
FOR EACH ROW EXECUTE FUNCTION "tonhub_validate_movement_allocation"();

-- A movement's lifecycle fields may advance, but its on-chain identity and raw evidence cannot change.
CREATE FUNCTION "tonhub_guard_payment_movement"() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'TonhubPaymentMovement is append-only' USING ERRCODE = '55000';
    END IF;

    IF ROW(
        OLD."id", OLD."fingerprint", OLD."depositAddressId", OLD."network", OLD."direction",
        OLD."asset", OLD."assetKind", OLD."assetDecimals", OLD."amountAtomic", OLD."fromAddress",
        OLD."toAddress", OLD."ownerAddress", OLD."jettonMasterAddress", OLD."jettonWalletAddress",
        OLD."transactionHash", OLD."transactionLt", OLD."traceId", OLD."queryId", OLD."blockchainAt",
        OLD."rawPayload", OLD."createdAt"
    ) IS DISTINCT FROM ROW(
        NEW."id", NEW."fingerprint", NEW."depositAddressId", NEW."network", NEW."direction",
        NEW."asset", NEW."assetKind", NEW."assetDecimals", NEW."amountAtomic", NEW."fromAddress",
        NEW."toAddress", NEW."ownerAddress", NEW."jettonMasterAddress", NEW."jettonWalletAddress",
        NEW."transactionHash", NEW."transactionLt", NEW."traceId", NEW."queryId", NEW."blockchainAt",
        NEW."rawPayload", NEW."createdAt"
    ) THEN
        RAISE EXCEPTION 'TonhubPaymentMovement financial facts are immutable' USING ERRCODE = '55000';
    END IF;

    IF OLD."rateSnapshotId" IS NOT NULL AND NEW."rateSnapshotId" IS DISTINCT FROM OLD."rateSnapshotId" THEN
        RAISE EXCEPTION 'TonhubPaymentMovement rate evidence cannot be replaced' USING ERRCODE = '55000';
    END IF;

    IF OLD."fiatCreditMicros" IS NOT NULL AND NEW."fiatCreditMicros" IS DISTINCT FROM OLD."fiatCreditMicros" THEN
        RAISE EXCEPTION 'TonhubPaymentMovement fiat credit cannot be replaced' USING ERRCODE = '55000';
    END IF;

    IF OLD."validationCode" IS NOT NULL AND NEW."validationCode" IS DISTINCT FROM OLD."validationCode" THEN
        RAISE EXCEPTION 'TonhubPaymentMovement validation evidence cannot be replaced' USING ERRCODE = '55000';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
        (OLD."status" = 'OBSERVED' AND NEW."status" IN ('VALIDATED', 'RATE_PENDING', 'HELD_UNDER_MINIMUM', 'CREDITED', 'RECOVERY', 'REJECTED')) OR
        (OLD."status" = 'VALIDATED' AND NEW."status" IN ('RATE_PENDING', 'HELD_UNDER_MINIMUM', 'CREDITED', 'RECOVERY', 'REJECTED')) OR
        (OLD."status" = 'RATE_PENDING' AND NEW."status" IN ('HELD_UNDER_MINIMUM', 'CREDITED', 'RECOVERY', 'REJECTED')) OR
        (OLD."status" = 'HELD_UNDER_MINIMUM' AND NEW."status" IN ('CREDITED', 'RECOVERY', 'REJECTED')) OR
        (OLD."status" = 'RECOVERY' AND NEW."status" IN ('VALIDATED', 'RATE_PENDING', 'HELD_UNDER_MINIMUM', 'CREDITED', 'REJECTED'))
    ) THEN
        RAISE EXCEPTION 'invalid TonhubPaymentMovement status transition: % -> %', OLD."status", NEW."status" USING ERRCODE = '55000';
    END IF;

    IF OLD."status" IN ('CREDITED', 'REJECTED') AND ROW(
        NEW."status", NEW."validationCode", NEW."rateSnapshotId", NEW."fiatCreditMicros"
    ) IS DISTINCT FROM ROW(
        OLD."status", OLD."validationCode", OLD."rateSnapshotId", OLD."fiatCreditMicros"
    ) THEN
        RAISE EXCEPTION 'TonhubPaymentMovement terminal evidence is immutable' USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TonhubPaymentMovement_append_only"
BEFORE UPDATE OR DELETE ON "TonhubPaymentMovement"
FOR EACH ROW EXECUTE FUNCTION "tonhub_guard_payment_movement"();

CREATE TRIGGER "TonhubPaymentMovement_no_truncate"
BEFORE TRUNCATE ON "TonhubPaymentMovement"
FOR EACH STATEMENT EXECUTE FUNCTION "tonhub_reject_immutable_row_change"();
