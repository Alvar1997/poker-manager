-- Módulo 05: caja central (libro financiero de partida doble, transferencias
-- bancarias con verificación manual, arqueos de efectivo) y corrección de la
-- política de apertura: ZERO_OPENING_BALANCE reemplaza a NEW_FUND_PER_SESSION.
-- Aditiva salvo ese cambio de enum, que convierte el valor existente.
-- CreateEnum
CREATE TYPE "FinancialAccountKind" AS ENUM ('CASH_ON_HAND', 'BANK', 'CASH_IN_TRANSIT', 'OWNER_CONTRIBUTIONS', 'CASH_WITHDRAWALS', 'PLAYER_PURCHASES', 'PLAYER_DEBT_PAYMENTS', 'PLAYER_SETTLEMENTS', 'RECONCILIATION_DIFFERENCES');

-- CreateEnum
CREATE TYPE "FinancialAccountScope" AS ENUM ('SESSION', 'GLOBAL');

-- CreateEnum
CREATE TYPE "CashTransactionType" AS ENUM ('CASH_CONTRIBUTION', 'CASH_WITHDRAWAL', 'CASH_TRANSFER', 'BANK_TRANSFER_RECEIPT', 'BANK_TRANSFER_PAYOUT', 'PURCHASE_PAYMENT', 'DEBT_PAYMENT', 'PLAYER_SETTLEMENT', 'REVERSAL', 'CASH_RECONCILIATION_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "CashWithdrawalDestination" AS ENUM ('OWNER_CUSTODY', 'SAFEKEEPING', 'CONTRIBUTION_RETURN', 'SESSION_CLOSING');

-- CreateEnum
CREATE TYPE "EntryDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "BankTransferStatus" AS ENUM ('PENDING_VERIFICATION', 'CONFIRMED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BankTransferKind" AS ENUM ('PLAYER_PAYMENT', 'CASH_DEPOSIT');

-- CreateEnum
CREATE TYPE "CashReconciliationType" AS ENUM ('OPENING', 'CONTROL', 'CLOSING');

-- CreateEnum
CREATE TYPE "CashReconciliationStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CashDifferenceStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'ADJUSTED');

-- AlterEnum
BEGIN;
CREATE TYPE "InitialCashPolicy_new" AS ENUM ('ZERO_OPENING_BALANCE');
ALTER TABLE "public"."operational_settings" ALTER COLUMN "initialCashPolicy" DROP DEFAULT;
-- Conversión explícita: la política anterior (fondo nuevo por sesión) se
-- reemplaza por apertura en $0. No se borra ni modifica ningún movimiento.
ALTER TABLE "operational_settings" ALTER COLUMN "initialCashPolicy" TYPE "InitialCashPolicy_new"
  USING (CASE "initialCashPolicy"::text
           WHEN 'NEW_FUND_PER_SESSION' THEN 'ZERO_OPENING_BALANCE'
           ELSE "initialCashPolicy"::text
         END)::"InitialCashPolicy_new";
ALTER TYPE "InitialCashPolicy" RENAME TO "InitialCashPolicy_old";
ALTER TYPE "InitialCashPolicy_new" RENAME TO "InitialCashPolicy";
DROP TYPE "public"."InitialCashPolicy_old";
ALTER TABLE "operational_settings" ALTER COLUMN "initialCashPolicy" SET DEFAULT 'ZERO_OPENING_BALANCE';
COMMIT;

-- AlterTable
ALTER TABLE "operational_settings" ADD COLUMN     "allowNegativeCashBalance" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "carryCashToNextSession" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "openingCashBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "requireOpeningCashFund" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "initialCashPolicy" SET DEFAULT 'ZERO_OPENING_BALANCE';

-- CreateTable
CREATE TABLE "financial_accounts" (
    "id" TEXT NOT NULL,
    "kind" "FinancialAccountKind" NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cashBoxId" TEXT NOT NULL,
    "isMoney" BOOLEAN NOT NULL,
    "scope" "FinancialAccountScope" NOT NULL,
    "nonNegative" BOOLEAN NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "financial_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_account_balances" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "nonNegative" BOOLEAN NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "financial_account_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_transactions" (
    "id" TEXT NOT NULL,
    "folio" TEXT NOT NULL,
    "transactionType" "CashTransactionType" NOT NULL,
    "cashBoxId" TEXT NOT NULL,
    "sessionId" TEXT,
    "tableId" TEXT,
    "playerId" TEXT,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "reason" TEXT NOT NULL,
    "notes" TEXT,
    "counterpartyName" TEXT,
    "withdrawalDestination" "CashWithdrawalDestination",
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "reversesTransactionId" TEXT,
    "createdById" TEXT,
    "confirmedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_transaction_entries" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "direction" "EntryDirection" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_transaction_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_transfer_verifications" (
    "id" TEXT NOT NULL,
    "kind" "BankTransferKind" NOT NULL,
    "status" "BankTransferStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "paymentAccountId" TEXT NOT NULL,
    "declaredAmount" DECIMAL(14,2) NOT NULL,
    "confirmedAmount" DECIMAL(14,2),
    "bankReference" TEXT,
    "senderName" TEXT,
    "creditAccountKind" "FinancialAccountKind" NOT NULL,
    "sessionId" TEXT,
    "tableId" TEXT,
    "playerId" TEXT,
    "referenceType" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "notes" TEXT,
    "rejectionReason" TEXT,
    "verificationNotes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "transactionId" TEXT,
    "depositTransactionId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_transfer_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_reconciliations" (
    "id" TEXT NOT NULL,
    "cashBoxId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "reconciliationType" "CashReconciliationType" NOT NULL,
    "status" "CashReconciliationStatus" NOT NULL DEFAULT 'DRAFT',
    "differenceStatus" "CashDifferenceStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "expectedAmount" DECIMAL(14,2) NOT NULL,
    "countedAmount" DECIMAL(14,2) NOT NULL,
    "differenceAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "balanceVersion" INTEGER NOT NULL,
    "notes" TEXT,
    "explanation" TEXT,
    "adjustmentTransactionId" TEXT,
    "createdById" TEXT,
    "confirmedById" TEXT,
    "adjustedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "adjustedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "cash_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_reconciliation_details" (
    "id" TEXT NOT NULL,
    "reconciliationId" TEXT NOT NULL,
    "unitValue" DECIMAL(12,2) NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "cash_reconciliation_details_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "financial_accounts_kind_key" ON "financial_accounts"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "financial_accounts_code_key" ON "financial_accounts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "financial_account_balances_accountId_scopeKey_key" ON "financial_account_balances"("accountId", "scopeKey");

-- CreateIndex
CREATE UNIQUE INDEX "cash_transactions_folio_key" ON "cash_transactions"("folio");

-- CreateIndex
CREATE UNIQUE INDEX "cash_transactions_idempotencyKey_key" ON "cash_transactions"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "cash_transactions_reversesTransactionId_key" ON "cash_transactions"("reversesTransactionId");

-- CreateIndex
CREATE INDEX "cash_transactions_transactionType_createdAt_idx" ON "cash_transactions"("transactionType", "createdAt");

-- CreateIndex
CREATE INDEX "cash_transactions_sessionId_idx" ON "cash_transactions"("sessionId");

-- CreateIndex
CREATE INDEX "cash_transactions_playerId_idx" ON "cash_transactions"("playerId");

-- CreateIndex
CREATE INDEX "cash_transactions_tableId_idx" ON "cash_transactions"("tableId");

-- CreateIndex
CREATE INDEX "cash_transactions_referenceType_referenceId_idx" ON "cash_transactions"("referenceType", "referenceId");

-- CreateIndex
CREATE INDEX "cash_transactions_createdById_idx" ON "cash_transactions"("createdById");

-- CreateIndex
CREATE INDEX "cash_transactions_createdAt_idx" ON "cash_transactions"("createdAt");

-- CreateIndex
CREATE INDEX "cash_transaction_entries_transactionId_idx" ON "cash_transaction_entries"("transactionId");

-- CreateIndex
CREATE INDEX "cash_transaction_entries_accountId_scopeKey_idx" ON "cash_transaction_entries"("accountId", "scopeKey");

-- CreateIndex
CREATE UNIQUE INDEX "bank_transfer_verifications_idempotencyKey_key" ON "bank_transfer_verifications"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "bank_transfer_verifications_transactionId_key" ON "bank_transfer_verifications"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "bank_transfer_verifications_depositTransactionId_key" ON "bank_transfer_verifications"("depositTransactionId");

-- CreateIndex
CREATE INDEX "bank_transfer_verifications_status_createdAt_idx" ON "bank_transfer_verifications"("status", "createdAt");

-- CreateIndex
CREATE INDEX "bank_transfer_verifications_paymentAccountId_bankReference_idx" ON "bank_transfer_verifications"("paymentAccountId", "bankReference");

-- CreateIndex
CREATE INDEX "bank_transfer_verifications_referenceType_referenceId_idx" ON "bank_transfer_verifications"("referenceType", "referenceId");

-- CreateIndex
CREATE UNIQUE INDEX "cash_reconciliations_adjustmentTransactionId_key" ON "cash_reconciliations"("adjustmentTransactionId");

-- CreateIndex
CREATE INDEX "cash_reconciliations_sessionId_reconciliationType_idx" ON "cash_reconciliations"("sessionId", "reconciliationType");

-- CreateIndex
CREATE INDEX "cash_reconciliations_status_idx" ON "cash_reconciliations"("status");

-- CreateIndex
CREATE UNIQUE INDEX "cash_reconciliation_details_reconciliationId_unitValue_key" ON "cash_reconciliation_details"("reconciliationId", "unitValue");

-- AddForeignKey
ALTER TABLE "financial_accounts" ADD CONSTRAINT "financial_accounts_cashBoxId_fkey" FOREIGN KEY ("cashBoxId") REFERENCES "cash_boxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_account_balances" ADD CONSTRAINT "financial_account_balances_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "financial_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_transactions" ADD CONSTRAINT "cash_transactions_cashBoxId_fkey" FOREIGN KEY ("cashBoxId") REFERENCES "cash_boxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_transactions" ADD CONSTRAINT "cash_transactions_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "poker_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_transactions" ADD CONSTRAINT "cash_transactions_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_transactions" ADD CONSTRAINT "cash_transactions_reversesTransactionId_fkey" FOREIGN KEY ("reversesTransactionId") REFERENCES "cash_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_transactions" ADD CONSTRAINT "cash_transactions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_transactions" ADD CONSTRAINT "cash_transactions_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_transaction_entries" ADD CONSTRAINT "cash_transaction_entries_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "cash_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_transaction_entries" ADD CONSTRAINT "cash_transaction_entries_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "financial_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transfer_verifications" ADD CONSTRAINT "bank_transfer_verifications_paymentAccountId_fkey" FOREIGN KEY ("paymentAccountId") REFERENCES "payment_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transfer_verifications" ADD CONSTRAINT "bank_transfer_verifications_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "poker_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transfer_verifications" ADD CONSTRAINT "bank_transfer_verifications_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transfer_verifications" ADD CONSTRAINT "bank_transfer_verifications_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transfer_verifications" ADD CONSTRAINT "bank_transfer_verifications_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transfer_verifications" ADD CONSTRAINT "bank_transfer_verifications_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "cash_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transfer_verifications" ADD CONSTRAINT "bank_transfer_verifications_depositTransactionId_fkey" FOREIGN KEY ("depositTransactionId") REFERENCES "cash_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_reconciliations" ADD CONSTRAINT "cash_reconciliations_cashBoxId_fkey" FOREIGN KEY ("cashBoxId") REFERENCES "cash_boxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_reconciliations" ADD CONSTRAINT "cash_reconciliations_adjustmentTransactionId_fkey" FOREIGN KEY ("adjustmentTransactionId") REFERENCES "cash_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_reconciliations" ADD CONSTRAINT "cash_reconciliations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_reconciliations" ADD CONSTRAINT "cash_reconciliations_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_reconciliations" ADD CONSTRAINT "cash_reconciliations_adjustedById_fkey" FOREIGN KEY ("adjustedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_reconciliation_details" ADD CONSTRAINT "cash_reconciliation_details_reconciliationId_fkey" FOREIGN KEY ("reconciliationId") REFERENCES "cash_reconciliations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ── Invariantes de la política de efectivo (no editables) ──────────────
ALTER TABLE "operational_settings" ADD CONSTRAINT "operational_settings_cash_invariants"
  CHECK ("openingCashBalance" = 0 AND NOT "requireOpeningCashFund"
         AND NOT "carryCashToNextSession" AND NOT "allowNegativeCashBalance");

-- ── Libro financiero ───────────────────────────────────────────────────
ALTER TABLE "cash_transaction_entries" ADD CONSTRAINT "cash_entries_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "financial_account_balances" ADD CONSTRAINT "financial_balances_non_negative"
  CHECK (NOT "nonNegative" OR "balance" >= 0);
ALTER TABLE "financial_account_balances" ADD CONSTRAINT "financial_balances_version_non_negative" CHECK ("version" >= 0);

-- Un solo cobro/pago por operación de origen (no doble contabilización).
CREATE UNIQUE INDEX "cash_transactions_one_per_origin"
  ON "cash_transactions" ("transactionType", "referenceType", "referenceId")
  WHERE "referenceId" IS NOT NULL
    AND "transactionType" IN ('PURCHASE_PAYMENT', 'DEBT_PAYMENT', 'PLAYER_SETTLEMENT', 'BANK_TRANSFER_RECEIPT');

-- Transferencias: importes positivos y un solo componente bancario vivo por operación.
ALTER TABLE "bank_transfer_verifications" ADD CONSTRAINT "bank_transfers_amounts_positive"
  CHECK ("declaredAmount" > 0 AND ("confirmedAmount" IS NULL OR "confirmedAmount" > 0));
CREATE UNIQUE INDEX "bank_transfers_one_live_per_origin"
  ON "bank_transfer_verifications" ("kind", "referenceType", "referenceId")
  WHERE "status" IN ('PENDING_VERIFICATION', 'CONFIRMED');

-- Arqueos de efectivo: importes no negativos; OPENING siempre espera $0.
ALTER TABLE "cash_reconciliations" ADD CONSTRAINT "cash_reconciliations_amounts_valid"
  CHECK ("expectedAmount" >= 0 AND "countedAmount" >= 0
         AND ("reconciliationType" <> 'OPENING' OR "expectedAmount" = 0));
ALTER TABLE "cash_reconciliation_details" ADD CONSTRAINT "cash_reconciliation_details_valid"
  CHECK ("unitValue" > 0 AND "quantity" >= 0);
CREATE UNIQUE INDEX "cash_reconciliations_one_draft_per_session"
  ON "cash_reconciliations" ("sessionId") WHERE "status" = 'DRAFT';

-- ── Partida doble: cada transacción debe cuadrar (verificado al COMMIT) ──
CREATE FUNCTION "cash_transaction_must_balance"() RETURNS trigger AS $$
DECLARE debit NUMERIC; credit NUMERIC; n INT;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN "direction" = 'DEBIT' THEN "amount" END), 0),
         COALESCE(SUM(CASE WHEN "direction" = 'CREDIT' THEN "amount" END), 0),
         COUNT(*)
    INTO debit, credit, n
    FROM "cash_transaction_entries" WHERE "transactionId" = NEW."transactionId";
  IF n < 2 OR debit <> credit THEN
    RAISE EXCEPTION 'Transacción financiera % descuadrada (débitos %, créditos %)', NEW."transactionId", debit, credit;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "cash_transaction_entries_balanced"
  AFTER INSERT ON "cash_transaction_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "cash_transaction_must_balance"();

-- ── Inmutabilidad ──────────────────────────────────────────────────────
CREATE FUNCTION "cash_ledger_prevent_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% es de solo inserción (%)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "cash_transactions_immutable" BEFORE UPDATE OR DELETE ON "cash_transactions"
  FOR EACH ROW EXECUTE FUNCTION "cash_ledger_prevent_mutation"();
CREATE TRIGGER "cash_transaction_entries_immutable" BEFORE UPDATE OR DELETE ON "cash_transaction_entries"
  FOR EACH ROW EXECUTE FUNCTION "cash_ledger_prevent_mutation"();

-- Transferencias: sin DELETE; una vez resueltas (no pendientes) no cambian.
CREATE FUNCTION "bank_transfers_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bank_transfer_verifications no admite DELETE';
  END IF;
  IF OLD."status" <> 'PENDING_VERIFICATION' THEN
    RAISE EXCEPTION 'Una transferencia confirmada, rechazada o cancelada es inmutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "bank_transfer_verifications_guard" BEFORE UPDATE OR DELETE ON "bank_transfer_verifications"
  FOR EACH ROW EXECUTE FUNCTION "bank_transfers_guard"();

-- Arqueos de efectivo: sin DELETE; confirmados solo cambian por su ajuste.
CREATE FUNCTION "cash_reconciliations_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cash_reconciliations no admite DELETE';
  END IF;
  IF OLD."status" <> 'DRAFT' AND (
       NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."expectedAmount" IS DISTINCT FROM OLD."expectedAmount"
    OR NEW."countedAmount" IS DISTINCT FROM OLD."countedAmount"
    OR NEW."differenceAmount" IS DISTINCT FROM OLD."differenceAmount"
    OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId"
    OR NEW."reconciliationType" IS DISTINCT FROM OLD."reconciliationType"
    OR NEW."balanceVersion" IS DISTINCT FROM OLD."balanceVersion"
    OR NEW."confirmedAt" IS DISTINCT FROM OLD."confirmedAt"
    OR NEW."confirmedById" IS DISTINCT FROM OLD."confirmedById"
    OR (OLD."differenceStatus" = 'ADJUSTED' AND NEW."differenceStatus" IS DISTINCT FROM OLD."differenceStatus")
  ) THEN
    RAISE EXCEPTION 'Un arqueo de efectivo confirmado es inmutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "cash_reconciliations_guard" BEFORE UPDATE OR DELETE ON "cash_reconciliations"
  FOR EACH ROW EXECUTE FUNCTION "cash_reconciliations_guard"();

CREATE FUNCTION "cash_reconciliation_details_guard"() RETURNS trigger AS $$
DECLARE parent_status "CashReconciliationStatus";
BEGIN
  SELECT "status" INTO parent_status FROM "cash_reconciliations" WHERE "id" = OLD."reconciliationId";
  IF parent_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'El desglose de un arqueo confirmado es inmutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "cash_reconciliation_details_guard" BEFORE UPDATE OR DELETE ON "cash_reconciliation_details"
  FOR EACH ROW EXECUTE FUNCTION "cash_reconciliation_details_guard"();
