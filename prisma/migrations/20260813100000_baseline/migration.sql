-- CreateEnum
CREATE TYPE "TonhubPaymentInvoiceStatus" AS ENUM ('PENDING', 'PARTIAL', 'PAID', 'EXPIRED', 'CANCELLED', 'FAILED');

-- CreateTable
CREATE TABLE "TonhubPaymentInvoice" (
    "id" TEXT NOT NULL,
    "externalId" TEXT,
    "network" TEXT NOT NULL,
    "asset" TEXT NOT NULL DEFAULT 'GRAM',
    "fiatAmountCents" INTEGER NOT NULL,
    "fiatCurrency" TEXT NOT NULL DEFAULT 'EUR',
    "address" TEXT NOT NULL,
    "addressRaw" TEXT NOT NULL,
    "addressStrategy" TEXT NOT NULL DEFAULT 'unique-address',
    "walletVersion" TEXT NOT NULL,
    "walletWorkchain" INTEGER NOT NULL,
    "walletContext" INTEGER NOT NULL,
    "walletNetworkGlobalId" INTEGER NOT NULL,
    "walletPublicKeyHash" TEXT NOT NULL,
    "amountNano" TEXT NOT NULL,
    "paidNano" TEXT NOT NULL DEFAULT '0',
    "reference" TEXT NOT NULL,
    "status" "TonhubPaymentInvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "providerName" TEXT NOT NULL DEFAULT 'ton-direct',
    "observedTransactionHash" TEXT,
    "observedAt" TIMESTAMP(3),
    "partialPaymentStartedAt" TIMESTAMP(3),
    "partialPaymentExpiresAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "priceLockedAt" TIMESTAMP(3),
    "priceLockedUntil" TIMESTAMP(3),
    "observedPayments" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,
    "payload" JSONB,

    CONSTRAINT "TonhubPaymentInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TonhubDepositAddress" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT,
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "addressRaw" TEXT NOT NULL,
    "walletVersion" TEXT NOT NULL,
    "walletWorkchain" INTEGER NOT NULL,
    "walletContext" INTEGER NOT NULL,
    "walletNetworkGlobalId" INTEGER NOT NULL,
    "walletPublicKeyHash" TEXT NOT NULL,
    "invoiceKind" TEXT NOT NULL DEFAULT 'tonhub-payment',
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "assignedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "sweepStatus" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "sweepAmountNano" TEXT,
    "sweepReserveNano" TEXT,
    "sweepRecipientAddress" TEXT,
    "sweepTransactionHash" TEXT,
    "sweepSeqno" INTEGER,
    "sweepStartedAt" TIMESTAMP(3),
    "sweepSentAt" TIMESTAMP(3),
    "sweepConfirmedAt" TIMESTAMP(3),
    "sweepLastError" TEXT,
    "sweepAttempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TonhubDepositAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TonhubPaymentTransaction" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "providerName" TEXT NOT NULL DEFAULT 'ton-direct',
    "providerTransactionId" TEXT,
    "status" "TonhubPaymentInvoiceStatus" NOT NULL,
    "amountNano" TEXT NOT NULL,
    "asset" TEXT NOT NULL DEFAULT 'GRAM',
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TonhubPaymentTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TonhubPaymentInvoice_externalId_key" ON "TonhubPaymentInvoice"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "TonhubPaymentInvoice_reference_key" ON "TonhubPaymentInvoice"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "TonhubPaymentInvoice_observedTransactionHash_key" ON "TonhubPaymentInvoice"("observedTransactionHash");

-- CreateIndex
CREATE INDEX "TonhubPaymentInvoice_network_address_status_idx" ON "TonhubPaymentInvoice"("network", "address", "status");

-- CreateIndex
CREATE INDEX "TonhubPaymentInvoice_network_status_createdAt_idx" ON "TonhubPaymentInvoice"("network", "status", "createdAt");

-- CreateIndex
CREATE INDEX "TonhubPaymentInvoice_status_expiresAt_idx" ON "TonhubPaymentInvoice"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "TonhubPaymentInvoice_status_priceLockedUntil_idx" ON "TonhubPaymentInvoice"("status", "priceLockedUntil");

-- CreateIndex
CREATE INDEX "TonhubPaymentInvoice_status_partialPaymentExpiresAt_idx" ON "TonhubPaymentInvoice"("status", "partialPaymentExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "TonhubDepositAddress_invoiceId_key" ON "TonhubDepositAddress"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "TonhubDepositAddress_address_key" ON "TonhubDepositAddress"("address");

-- CreateIndex
CREATE INDEX "TonhubDepositAddress_network_status_createdAt_idx" ON "TonhubDepositAddress"("network", "status", "createdAt");

-- CreateIndex
CREATE INDEX "TonhubDepositAddress_network_sweepStatus_paidAt_idx" ON "TonhubDepositAddress"("network", "sweepStatus", "paidAt");

-- CreateIndex
CREATE INDEX "TonhubDepositAddress_invoiceKind_status_idx" ON "TonhubDepositAddress"("invoiceKind", "status");

-- CreateIndex
CREATE INDEX "TonhubDepositAddress_sweepStatus_updatedAt_idx" ON "TonhubDepositAddress"("sweepStatus", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TonhubDepositAddress_network_walletVersion_walletPublicKeyH_key" ON "TonhubDepositAddress"("network", "walletVersion", "walletPublicKeyHash", "walletContext");

-- CreateIndex
CREATE INDEX "TonhubPaymentTransaction_invoiceId_idx" ON "TonhubPaymentTransaction"("invoiceId");

-- CreateIndex
CREATE INDEX "TonhubPaymentTransaction_providerTransactionId_idx" ON "TonhubPaymentTransaction"("providerTransactionId");

-- AddForeignKey
ALTER TABLE "TonhubDepositAddress" ADD CONSTRAINT "TonhubDepositAddress_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "TonhubPaymentInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TonhubPaymentTransaction" ADD CONSTRAINT "TonhubPaymentTransaction_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "TonhubPaymentInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
