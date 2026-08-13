CREATE TABLE "TonhubAdminLoginThrottle" (
    "id" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,
    "blockedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TonhubAdminLoginThrottle_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TonhubAdminLoginThrottle_blockedUntil_idx"
ON "TonhubAdminLoginThrottle"("blockedUntil");
CREATE INDEX "TonhubAdminLoginThrottle_updatedAt_idx"
ON "TonhubAdminLoginThrottle"("updatedAt");

ALTER TABLE "TonhubAdminLoginThrottle"
ADD CONSTRAINT "TonhubAdminLoginThrottle_attempts_check"
CHECK ("attempts" >= 0 AND "attempts" <= 6);

ALTER TABLE "TonhubAssetSweep"
ADD COLUMN "gasServiceAddress" TEXT;

CREATE TABLE "TonhubRegisteredRefund" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "network" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "assetKind" TEXT NOT NULL,
    "assetDecimals" INTEGER NOT NULL,
    "amountAtomic" TEXT NOT NULL,
    "fromAddress" TEXT,
    "toAddress" TEXT NOT NULL,
    "jettonMasterAddress" TEXT,
    "transactionHash" TEXT NOT NULL,
    "transactionLt" TEXT,
    "blockchainAt" TIMESTAMP(3) NOT NULL,
    "registeredBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TonhubRegisteredRefund_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TonhubRegisteredRefund_network_transactionHash_asset_key"
ON "TonhubRegisteredRefund"("network", "transactionHash", "asset");
CREATE INDEX "TonhubRegisteredRefund_orderId_blockchainAt_idx"
ON "TonhubRegisteredRefund"("orderId", "blockchainAt");
CREATE INDEX "TonhubRegisteredRefund_invoiceId_blockchainAt_idx"
ON "TonhubRegisteredRefund"("invoiceId", "blockchainAt");

ALTER TABLE "TonhubRegisteredRefund"
ADD CONSTRAINT "TonhubRegisteredRefund_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "TonhubPaymentOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TonhubRegisteredRefund"
ADD CONSTRAINT "TonhubRegisteredRefund_invoiceId_fkey"
FOREIGN KEY ("invoiceId") REFERENCES "TonhubPaymentInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TonhubRegisteredRefund"
ADD CONSTRAINT "TonhubRegisteredRefund_assetDecimals_check" CHECK ("assetDecimals" BETWEEN 0 AND 255),
ADD CONSTRAINT "TonhubRegisteredRefund_amount_check" CHECK ("amountAtomic" ~ '^[1-9][0-9]*$'),
ADD CONSTRAINT "TonhubRegisteredRefund_hash_check" CHECK ("transactionHash" ~ '^[0-9a-f]{64}$'),
ADD CONSTRAINT "TonhubRegisteredRefund_addresses_check" CHECK (
  LENGTH("toAddress") > 0 AND ("fromAddress" IS NULL OR LENGTH("fromAddress") > 0)
),
ADD CONSTRAINT "TonhubRegisteredRefund_lt_check" CHECK (
  "transactionLt" IS NULL OR (
    "transactionLt" ~ '^(0|[1-9][0-9]*)$' AND
    "transactionLt"::NUMERIC <= 18446744073709551615
  )
),
ADD CONSTRAINT "TonhubRegisteredRefund_asset_identity_check" CHECK (
  ("asset" = 'GRAM' AND "assetKind" = 'NATIVE' AND "assetDecimals" = 9 AND "jettonMasterAddress" IS NULL) OR
  ("asset" = 'USDT' AND "assetKind" = 'JETTON' AND "assetDecimals" = 6 AND "network" = 'mainnet' AND "jettonMasterAddress" = '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe')
);

CREATE TRIGGER "TonhubRegisteredRefund_append_only"
BEFORE UPDATE OR DELETE ON "TonhubRegisteredRefund"
FOR EACH ROW EXECUTE FUNCTION "tonhub_reject_immutable_row_change"();
CREATE TRIGGER "TonhubRegisteredRefund_no_truncate"
BEFORE TRUNCATE ON "TonhubRegisteredRefund"
FOR EACH STATEMENT EXECUTE FUNCTION "tonhub_reject_immutable_row_change"();
