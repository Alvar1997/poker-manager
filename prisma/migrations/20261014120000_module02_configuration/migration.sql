-- Módulo 02: configuración general, caja central, mesas, juegos de fichas,
-- denominaciones, métodos de pago, cuenta bancaria, folios, políticas y WhatsApp.
-- Migración aditiva: no modifica ni elimina datos existentes.
-- CreateEnum
CREATE TYPE "DateFormat" AS ENUM ('DD_MM_YYYY', 'YYYY_MM_DD');

-- CreateEnum
CREATE TYPE "TimeFormat" AS ENUM ('H12', 'H24');

-- CreateEnum
CREATE TYPE "PaymentMethodCode" AS ENUM ('CASH', 'BANK_TRANSFER');

-- CreateEnum
CREATE TYPE "PaymentAccountType" AS ENUM ('BANK');

-- CreateEnum
CREATE TYPE "FolioDocumentType" AS ENUM ('SESSION', 'PURCHASE', 'DEBT_PAYMENT', 'SETTLEMENT', 'CASH_MOVEMENT', 'CHIP_MOVEMENT', 'CASH_CLOSING');

-- CreateEnum
CREATE TYPE "InitialCashPolicy" AS ENUM ('NEW_FUND_PER_SESSION');

-- CreateEnum
CREATE TYPE "ClosingCashPolicy" AS ENUM ('FULL_WITHDRAWAL');

-- CreateEnum
CREATE TYPE "WhatsAppProvider" AS ENUM ('META_CLOUD_API');

-- CreateEnum
CREATE TYPE "WhatsAppConfigurationStatus" AS ENUM ('PENDING_CONFIGURATION', 'CONFIGURED');

-- CreateTable
CREATE TABLE "business_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "businessName" TEXT NOT NULL,
    "displayName" TEXT,
    "logoUrl" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "timezone" TEXT NOT NULL DEFAULT 'America/Monterrey',
    "dateFormat" "DateFormat" NOT NULL DEFAULT 'DD_MM_YYYY',
    "timeFormat" "TimeFormat" NOT NULL DEFAULT 'H12',
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_boxes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cash_boxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chip_sets" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chip_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chip_denominations" (
    "id" TEXT NOT NULL,
    "chipSetId" TEXT NOT NULL,
    "value" DECIMAL(12,2) NOT NULL,
    "name" TEXT,
    "color" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chip_denominations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "poker_tables" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "smallBlind" DECIMAL(12,2) NOT NULL,
    "bigBlind" DECIMAL(12,2) NOT NULL,
    "defaultChipSetId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "poker_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_methods" (
    "id" TEXT NOT NULL,
    "code" "PaymentMethodCode" NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_accounts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PaymentAccountType" NOT NULL DEFAULT 'BANK',
    "bankName" TEXT,
    "accountHolder" TEXT,
    "accountNumberEncrypted" TEXT,
    "accountNumberLast4" TEXT,
    "clabeEncrypted" TEXT,
    "clabeLast4" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folio_sequences" (
    "id" TEXT NOT NULL,
    "documentType" "FolioDocumentType" NOT NULL,
    "prefix" TEXT NOT NULL,
    "nextNumber" INTEGER NOT NULL DEFAULT 1,
    "padding" INTEGER NOT NULL DEFAULT 6,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastIssuedAt" TIMESTAMP(3),
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "folio_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operational_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "initialCashPolicy" "InitialCashPolicy" NOT NULL DEFAULT 'NEW_FUND_PER_SESSION',
    "closingCashPolicy" "ClosingCashPolicy" NOT NULL DEFAULT 'FULL_WITHDRAWAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operational_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "provider" "WhatsAppProvider" NOT NULL DEFAULT 'META_CLOUD_API',
    "senderPhone" TEXT,
    "phoneNumberId" TEXT,
    "businessAccountId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "configurationStatus" "WhatsAppConfigurationStatus" NOT NULL DEFAULT 'PENDING_CONFIGURATION',
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cash_boxes_code_key" ON "cash_boxes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "chip_sets_code_key" ON "chip_sets"("code");

-- CreateIndex
CREATE INDEX "chip_sets_isActive_idx" ON "chip_sets"("isActive");

-- CreateIndex
CREATE INDEX "chip_denominations_chipSetId_isActive_idx" ON "chip_denominations"("chipSetId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "chip_denominations_chipSetId_value_key" ON "chip_denominations"("chipSetId", "value");

-- CreateIndex
CREATE UNIQUE INDEX "poker_tables_code_key" ON "poker_tables"("code");

-- CreateIndex
CREATE INDEX "poker_tables_isActive_idx" ON "poker_tables"("isActive");

-- CreateIndex
CREATE INDEX "poker_tables_defaultChipSetId_idx" ON "poker_tables"("defaultChipSetId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_methods_code_key" ON "payment_methods"("code");

-- CreateIndex
CREATE UNIQUE INDEX "folio_sequences_documentType_key" ON "folio_sequences"("documentType");

-- AddForeignKey
ALTER TABLE "business_settings" ADD CONSTRAINT "business_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_boxes" ADD CONSTRAINT "cash_boxes_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_sets" ADD CONSTRAINT "chip_sets_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_sets" ADD CONSTRAINT "chip_sets_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_denominations" ADD CONSTRAINT "chip_denominations_chipSetId_fkey" FOREIGN KEY ("chipSetId") REFERENCES "chip_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_denominations" ADD CONSTRAINT "chip_denominations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_denominations" ADD CONSTRAINT "chip_denominations_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "poker_tables" ADD CONSTRAINT "poker_tables_defaultChipSetId_fkey" FOREIGN KEY ("defaultChipSetId") REFERENCES "chip_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "poker_tables" ADD CONSTRAINT "poker_tables_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "poker_tables" ADD CONSTRAINT "poker_tables_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folio_sequences" ADD CONSTRAINT "folio_sequences_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Restricciones de integridad que Prisma no expresa ──────────────────

-- Configuraciones de registro único (singleton).
ALTER TABLE "business_settings" ADD CONSTRAINT "business_settings_singleton" CHECK ("id" = 1);
ALTER TABLE "operational_settings" ADD CONSTRAINT "operational_settings_singleton" CHECK ("id" = 1);
ALTER TABLE "whatsapp_settings" ADD CONSTRAINT "whatsapp_settings_singleton" CHECK ("id" = 1);

-- Una sola caja central en esta versión.
ALTER TABLE "cash_boxes" ADD CONSTRAINT "cash_boxes_single_main" CHECK ("code" = 'MAIN');

-- Valores monetarios estrictamente positivos.
ALTER TABLE "chip_denominations" ADD CONSTRAINT "chip_denominations_value_positive" CHECK ("value" > 0);
ALTER TABLE "poker_tables" ADD CONSTRAINT "poker_tables_blinds_valid"
  CHECK ("smallBlind" > 0 AND "bigBlind" >= "smallBlind");

-- Folios: consecutivo y relleno válidos.
ALTER TABLE "folio_sequences" ADD CONSTRAINT "folio_sequences_numbers_valid"
  CHECK ("nextNumber" >= 1 AND "padding" BETWEEN 1 AND 12);

-- BANK-01/BANK-10: como máximo UNA cuenta receptora activa y principal.
CREATE UNIQUE INDEX "payment_accounts_single_active_primary"
  ON "payment_accounts" ("isPrimary") WHERE "isPrimary" AND "isActive";

-- WhatsApp no puede habilitarse sin estar configurado.
ALTER TABLE "whatsapp_settings" ADD CONSTRAINT "whatsapp_settings_enabled_requires_configuration"
  CHECK (NOT "enabled" OR "configurationStatus" = 'CONFIGURED');
