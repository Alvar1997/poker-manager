-- Módulo 12 — cierre de mesas, sesiones y conciliación final.
-- Ver docs/MODULE_12_CLOSURE.md.


-- CreateEnum
CREATE TYPE "SessionClosureStatus" AS ENUM ('IN_PROGRESS', 'RETURNED_TO_OPEN', 'COMPLETED');

-- CreateEnum
CREATE TYPE "SessionClosureKind" AS ENUM ('NORMAL', 'NO_ACTIVITY');

-- CreateEnum
CREATE TYPE "ClosurePrecheckStage" AS ENUM ('START', 'CONFIRM');

-- CreateEnum
CREATE TYPE "ClosureDiscrepancyKind" AS ENUM ('CHIP_INVENTORY', 'CASH');

-- CreateEnum
CREATE TYPE "ClosureDiscrepancyStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ClosureDiscrepancyResolution" AS ENUM ('RECOUNT', 'RETURNED_TO_OPEN', 'AUTHORIZED_ADJUSTMENT');

-- CreateTable
CREATE TABLE "session_closures" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" "SessionClosureStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "kind" "SessionClosureKind" NOT NULL,
    "noActivityReason" TEXT,
    "startedById" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startIdempotencyKey" TEXT NOT NULL,
    "returnedAt" TIMESTAMP(3),
    "returnedById" TEXT,
    "returnReason" TEXT,
    "forgottenOperationAt" TIMESTAMP(3),
    "returnIdempotencyKey" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_closures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "closure_status_history" (
    "id" TEXT NOT NULL,
    "closureId" TEXT NOT NULL,
    "fromStatus" "SessionClosureStatus",
    "toStatus" "SessionClosureStatus" NOT NULL,
    "changedById" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,

    CONSTRAINT "closure_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "closure_prechecks" (
    "id" TEXT NOT NULL,
    "closureId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "stage" "ClosurePrecheckStage" NOT NULL,
    "blockingCount" INTEGER NOT NULL,
    "warningCount" INTEGER NOT NULL,
    "infoCount" INTEGER NOT NULL,
    "findings" JSONB NOT NULL,
    "findingsHash" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "closure_prechecks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "closure_discrepancies" (
    "id" TEXT NOT NULL,
    "closureId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" "ClosureDiscrepancyKind" NOT NULL,
    "chipStockCountId" TEXT,
    "cashReconciliationId" TEXT,
    "expectedAmount" DECIMAL(14,2) NOT NULL,
    "countedAmount" DECIMAL(14,2) NOT NULL,
    "differenceAmount" DECIMAL(14,2) NOT NULL,
    "status" "ClosureDiscrepancyStatus" NOT NULL DEFAULT 'OPEN',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "investigationNotes" TEXT,
    "resolution" "ClosureDiscrepancyResolution",
    "resolutionNotes" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "recountChipStockCountId" TEXT,
    "recountCashReconciliationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "closure_discrepancies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "closure_adjustment_authorizations" (
    "id" TEXT NOT NULL,
    "discrepancyId" TEXT NOT NULL,
    "closureId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "authorizedById" TEXT NOT NULL,
    "chipOperationId" TEXT,
    "cashTransactionId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "closure_adjustment_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "closure_cash_withdrawals" (
    "id" TEXT NOT NULL,
    "closureId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "withdrawnById" TEXT NOT NULL,
    "recipientName" TEXT NOT NULL,
    "recipientUserId" TEXT,
    "withdrawalAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "cashTransactionId" TEXT NOT NULL,
    "cashReconciliationId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "closure_cash_withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "closure_approvals" (
    "id" TEXT NOT NULL,
    "closureId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "approvedById" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "previewHash" TEXT NOT NULL,
    "chipStockCountId" TEXT,
    "cashReconciliationId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "closure_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "closure_reports" (
    "id" TEXT NOT NULL,
    "closureId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "folio" TEXT NOT NULL,
    "kind" "SessionClosureKind" NOT NULL,
    "content" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "closure_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "session_closures_startIdempotencyKey_key" ON "session_closures"("startIdempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "session_closures_returnIdempotencyKey_key" ON "session_closures"("returnIdempotencyKey");

-- CreateIndex
CREATE INDEX "session_closures_sessionId_status_idx" ON "session_closures"("sessionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "session_closures_sessionId_attemptNumber_key" ON "session_closures"("sessionId", "attemptNumber");

-- CreateIndex
CREATE INDEX "closure_status_history_closureId_changedAt_idx" ON "closure_status_history"("closureId", "changedAt");

-- CreateIndex
CREATE INDEX "closure_prechecks_closureId_createdAt_idx" ON "closure_prechecks"("closureId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "closure_discrepancies_chipStockCountId_key" ON "closure_discrepancies"("chipStockCountId");

-- CreateIndex
CREATE UNIQUE INDEX "closure_discrepancies_cashReconciliationId_key" ON "closure_discrepancies"("cashReconciliationId");

-- CreateIndex
CREATE INDEX "closure_discrepancies_closureId_status_idx" ON "closure_discrepancies"("closureId", "status");

-- CreateIndex
CREATE INDEX "closure_discrepancies_sessionId_idx" ON "closure_discrepancies"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "closure_adjustment_authorizations_discrepancyId_key" ON "closure_adjustment_authorizations"("discrepancyId");

-- CreateIndex
CREATE UNIQUE INDEX "closure_adjustment_authorizations_chipOperationId_key" ON "closure_adjustment_authorizations"("chipOperationId");

-- CreateIndex
CREATE UNIQUE INDEX "closure_adjustment_authorizations_cashTransactionId_key" ON "closure_adjustment_authorizations"("cashTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "closure_adjustment_authorizations_idempotencyKey_key" ON "closure_adjustment_authorizations"("idempotencyKey");

-- CreateIndex
CREATE INDEX "closure_adjustment_authorizations_closureId_idx" ON "closure_adjustment_authorizations"("closureId");

-- CreateIndex
CREATE UNIQUE INDEX "closure_cash_withdrawals_closureId_key" ON "closure_cash_withdrawals"("closureId");

-- CreateIndex
CREATE UNIQUE INDEX "closure_cash_withdrawals_cashTransactionId_key" ON "closure_cash_withdrawals"("cashTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "closure_cash_withdrawals_idempotencyKey_key" ON "closure_cash_withdrawals"("idempotencyKey");

-- CreateIndex
CREATE INDEX "closure_cash_withdrawals_sessionId_idx" ON "closure_cash_withdrawals"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "closure_approvals_closureId_key" ON "closure_approvals"("closureId");

-- CreateIndex
CREATE UNIQUE INDEX "closure_approvals_sessionId_key" ON "closure_approvals"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "closure_approvals_chipStockCountId_key" ON "closure_approvals"("chipStockCountId");

-- CreateIndex
CREATE UNIQUE INDEX "closure_approvals_cashReconciliationId_key" ON "closure_approvals"("cashReconciliationId");

-- CreateIndex
CREATE UNIQUE INDEX "closure_approvals_idempotencyKey_key" ON "closure_approvals"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "closure_reports_closureId_key" ON "closure_reports"("closureId");

-- CreateIndex
CREATE UNIQUE INDEX "closure_reports_sessionId_key" ON "closure_reports"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "closure_reports_folio_key" ON "closure_reports"("folio");

-- AddForeignKey
ALTER TABLE "session_closures" ADD CONSTRAINT "session_closures_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "poker_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_closures" ADD CONSTRAINT "session_closures_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_closures" ADD CONSTRAINT "session_closures_returnedById_fkey" FOREIGN KEY ("returnedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closure_status_history" ADD CONSTRAINT "closure_status_history_closureId_fkey" FOREIGN KEY ("closureId") REFERENCES "session_closures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closure_status_history" ADD CONSTRAINT "closure_status_history_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closure_prechecks" ADD CONSTRAINT "closure_prechecks_closureId_fkey" FOREIGN KEY ("closureId") REFERENCES "session_closures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closure_prechecks" ADD CONSTRAINT "closure_prechecks_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closure_discrepancies" ADD CONSTRAINT "closure_discrepancies_closureId_fkey" FOREIGN KEY ("closureId") REFERENCES "session_closures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closure_discrepancies" ADD CONSTRAINT "closure_discrepancies_chipStockCountId_fkey" FOREIGN KEY ("chipStockCountId") REFERENCES "chip_stock_counts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closure_discrepancies" ADD CONSTRAINT "closure_discrepancies_cashReconciliationId_fkey" FOREIGN KEY ("cashReconciliationId") REFERENCES "cash_reconciliations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closure_discrepancies" ADD CONSTRAINT "closure_discrepancies_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closure_adjustment_authorizations" ADD CONSTRAINT "closure_adjustment_authorizations_discrepancyId_fkey" FOREIGN KEY ("discrepancyId") REFERENCES "closure_discrepancies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closure_adjustment_authorizations" ADD CONSTRAINT "closure_adjustment_authorizations_closureId_fkey" FOREIGN KEY ("closureId") REFERENCES "session_closures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closure_adjustment_authorizations" ADD CONSTRAINT "closure_adjustment_authorizations_authorizedById_fkey" FOREIGN KEY ("authorizedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closure_adjustment_authorizations" ADD CONSTRAINT "closure_adjustment_authorizations_chipOperationId_fkey" FOREIGN KEY ("chipOperationId") REFERENCES "chip_inventory_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closure_adjustment_authorizations" ADD CONSTRAINT "closure_adjustment_authorizations_cashTransactionId_fkey" FOREIGN KEY ("cashTransactionId") REFERENCES "cash_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closure_cash_withdrawals" ADD CONSTRAINT "closure_cash_withdrawals_closureId_fkey" FOREIGN KEY ("closureId") REFERENCES "session_closures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closure_cash_withdrawals" ADD CONSTRAINT "closure_cash_withdrawals_withdrawnById_fkey" FOREIGN KEY ("withdrawnById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closure_cash_withdrawals" ADD CONSTRAINT "closure_cash_withdrawals_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closure_cash_withdrawals" ADD CONSTRAINT "closure_cash_withdrawals_cashTransactionId_fkey" FOREIGN KEY ("cashTransactionId") REFERENCES "cash_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closure_cash_withdrawals" ADD CONSTRAINT "closure_cash_withdrawals_cashReconciliationId_fkey" FOREIGN KEY ("cashReconciliationId") REFERENCES "cash_reconciliations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closure_approvals" ADD CONSTRAINT "closure_approvals_closureId_fkey" FOREIGN KEY ("closureId") REFERENCES "session_closures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closure_approvals" ADD CONSTRAINT "closure_approvals_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closure_approvals" ADD CONSTRAINT "closure_approvals_chipStockCountId_fkey" FOREIGN KEY ("chipStockCountId") REFERENCES "chip_stock_counts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closure_approvals" ADD CONSTRAINT "closure_approvals_cashReconciliationId_fkey" FOREIGN KEY ("cashReconciliationId") REFERENCES "cash_reconciliations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closure_reports" ADD CONSTRAINT "closure_reports_closureId_fkey" FOREIGN KEY ("closureId") REFERENCES "session_closures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closure_reports" ADD CONSTRAINT "closure_reports_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "poker_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closure_reports" ADD CONSTRAINT "closure_reports_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ════════════════════════════════════════════════════════════════════
-- Reglas en la base (Módulo 12). Ninguna sesión existente se cierra ni
-- cambia de estado: solo se agregan tablas, índices y controles.
-- ════════════════════════════════════════════════════════════════════

-- ── Sesión: se permite CLOSING → OPEN (regreso auditado, DEC-10/11) ───
-- CLOSED sigue siendo terminal (nunca CLOSED → OPEN/CLOSING, DEC-12).
CREATE OR REPLACE FUNCTION "poker_sessions_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'poker_sessions no admite DELETE (se cancela, no se borra)';
  END IF;
  IF NEW."folio" IS DISTINCT FROM OLD."folio"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."cashBoxId" IS DISTINCT FROM OLD."cashBoxId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
     OR (OLD."openedAt" IS NOT NULL AND NEW."openedAt" IS DISTINCT FROM OLD."openedAt")
     OR (OLD."openedById" IS NOT NULL AND NEW."openedById" IS DISTINCT FROM OLD."openedById")
     OR (OLD."closedAt" IS NOT NULL AND NEW."closedAt" IS DISTINCT FROM OLD."closedAt")
     OR (OLD."cancelledAt" IS NOT NULL AND NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt")
  THEN
    RAISE EXCEPTION 'Folio, creador, caja y fechas reales de una sesión son inmutables';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'DRAFT' AND NEW."status" IN ('PREPARATION', 'CANCELLED'))
    OR (OLD."status" = 'PREPARATION' AND NEW."status" IN ('OPEN', 'CANCELLED'))
    OR (OLD."status" = 'OPEN' AND NEW."status" = 'CLOSING')
    OR (OLD."status" = 'CLOSING' AND NEW."status" IN ('OPEN', 'CLOSED'))
  ) THEN
    RAISE EXCEPTION 'Transición de sesión no permitida: % → %', OLD."status", NEW."status";
  END IF;
  IF OLD."status" IN ('CLOSED', 'CANCELLED') THEN
    RAISE EXCEPTION 'Una sesión % no se modifica', OLD."status";
  END IF;
  -- Solo el cierre definitivo fija la hora de cierre.
  IF NEW."closedAt" IS NOT NULL AND NEW."status" <> 'CLOSED' THEN
    RAISE EXCEPTION 'Solo una sesión CLOSED tiene hora de cierre';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Caja: el efectivo de una sesión CLOSED/CANCELLED no se mueve ──────
-- (DEC-12, LIQ-DEC-20). Los pagos posteriores usan custodia o banco.
CREATE FUNCTION "cash_entries_closed_session_guard"() RETURNS trigger AS $$
DECLARE
  account_kind "FinancialAccountKind";
  session_status "PokerSessionStatus";
BEGIN
  SELECT "kind" INTO account_kind FROM "financial_accounts" WHERE "id" = NEW."accountId";
  IF account_kind = 'CASH_ON_HAND' THEN
    SELECT "status" INTO session_status FROM "poker_sessions" WHERE "id" = NEW."scopeKey";
    IF session_status IN ('CLOSED', 'CANCELLED') THEN
      RAISE EXCEPTION 'La caja de una sesión % no admite movimientos nuevos', session_status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "cash_entries_closed_session_guard" BEFORE INSERT ON "cash_transaction_entries"
  FOR EACH ROW EXECUTE FUNCTION "cash_entries_closed_session_guard"();

-- ── Arqueos de fichas: PENDING → RECONCILED | SUPERSEDED (final) ──────
CREATE OR REPLACE FUNCTION "chip_counts_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'chip_stock_counts no admite DELETE';
  END IF;
  IF OLD."status" <> 'DRAFT' AND (
       NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."countType" IS DISTINCT FROM OLD."countType"
    OR NEW."chipSetId" IS DISTINCT FROM OLD."chipSetId"
    OR NEW."containerId" IS DISTINCT FROM OLD."containerId"
    OR NEW."inventoryVersion" IS DISTINCT FROM OLD."inventoryVersion"
    OR NEW."expectedTotal" IS DISTINCT FROM OLD."expectedTotal"
    OR NEW."countedTotal" IS DISTINCT FROM OLD."countedTotal"
    OR NEW."differenceTotal" IS DISTINCT FROM OLD."differenceTotal"
    OR NEW."confirmedAt" IS DISTINCT FROM OLD."confirmedAt"
    OR NEW."confirmedById" IS DISTINCT FROM OLD."confirmedById"
    OR NEW."countedById" IS DISTINCT FROM OLD."countedById"
    OR NEW."notes" IS DISTINCT FROM OLD."notes"
    OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId"
    OR NEW."breakdownExact" IS DISTINCT FROM OLD."breakdownExact"
    OR NEW."compositionOperationId" IS DISTINCT FROM OLD."compositionOperationId"
    OR (NEW."resultingInventoryVersion" IS DISTINCT FROM OLD."resultingInventoryVersion"
        AND OLD."reconciliationStatus" <> 'PENDING')
    OR (OLD."reconciliationStatus" IN ('RECONCILED', 'SUPERSEDED')
        AND NEW."reconciliationStatus" IS DISTINCT FROM OLD."reconciliationStatus")
    OR (NEW."reconciliationStatus" = 'SUPERSEDED'
        AND OLD."reconciliationStatus" IS DISTINCT FROM NEW."reconciliationStatus"
        AND (OLD."reconciliationStatus" <> 'PENDING' OR OLD."countType" <> 'CLOSING'))
  ) THEN
    RAISE EXCEPTION 'Un arqueo confirmado o cancelado es inmutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Arqueos de efectivo: PENDING → ADJUSTED | SUPERSEDED (final) ──────
CREATE OR REPLACE FUNCTION "cash_reconciliations_guard"() RETURNS trigger AS $$
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
    OR (OLD."differenceStatus" IN ('ADJUSTED', 'SUPERSEDED') AND NEW."differenceStatus" IS DISTINCT FROM OLD."differenceStatus")
    OR (NEW."differenceStatus" = 'SUPERSEDED'
        AND OLD."differenceStatus" IS DISTINCT FROM NEW."differenceStatus"
        AND (OLD."differenceStatus" <> 'PENDING' OR OLD."reconciliationType" <> 'CLOSING'))
  ) THEN
    RAISE EXCEPTION 'Un arqueo de efectivo confirmado es inmutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Intentos de cierre ────────────────────────────────────────────────
-- Un solo intento EN CURSO y un solo cierre COMPLETADO por sesión.
CREATE UNIQUE INDEX "session_closures_one_in_progress" ON "session_closures" ("sessionId") WHERE "status" = 'IN_PROGRESS';
CREATE UNIQUE INDEX "session_closures_one_completed" ON "session_closures" ("sessionId") WHERE "status" = 'COMPLETED';

ALTER TABLE "session_closures" ADD CONSTRAINT "session_closures_consistency" CHECK (
  "attemptNumber" >= 1
  AND ("status" <> 'RETURNED_TO_OPEN' OR ("returnedAt" IS NOT NULL AND "returnedById" IS NOT NULL AND length(btrim(coalesce("returnReason", ''))) > 0))
  AND ("status" <> 'COMPLETED' OR "completedAt" IS NOT NULL)
  AND ("status" <> 'COMPLETED' OR "kind" = 'NORMAL' OR length(btrim(coalesce("noActivityReason", ''))) > 0)
);

CREATE FUNCTION "session_closures_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'session_closures no admite DELETE';
  END IF;
  IF NEW."sessionId" IS DISTINCT FROM OLD."sessionId"
     OR NEW."attemptNumber" IS DISTINCT FROM OLD."attemptNumber"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."startedById" IS DISTINCT FROM OLD."startedById"
     OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
     OR NEW."startIdempotencyKey" IS DISTINCT FROM OLD."startIdempotencyKey"
  THEN
    RAISE EXCEPTION 'Los datos de inicio de un cierre son inmutables';
  END IF;
  IF OLD."status" <> 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'Un intento de cierre % es inmutable', OLD."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "session_closures_guard" BEFORE UPDATE OR DELETE ON "session_closures"
  FOR EACH ROW EXECUTE FUNCTION "session_closures_guard"();

-- ── Discrepancias físicas: importes inmutables; se resuelven una vez ──
ALTER TABLE "closure_discrepancies" ADD CONSTRAINT "closure_discrepancies_amounts" CHECK (
  -- Puede ser $0 con diferencias por denominación (composición distinta
  -- con composición exacta): sigue siendo una diferencia física.
  "differenceAmount" = "countedAmount" - "expectedAmount"
  AND "expectedAmount" >= 0 AND "countedAmount" >= 0
  AND (("kind" = 'CHIP_INVENTORY' AND "chipStockCountId" IS NOT NULL AND "cashReconciliationId" IS NULL)
    OR ("kind" = 'CASH' AND "cashReconciliationId" IS NOT NULL AND "chipStockCountId" IS NULL))
  AND (("status" = 'OPEN' AND "resolution" IS NULL AND "resolvedAt" IS NULL)
    OR ("status" = 'RESOLVED' AND "resolution" IS NOT NULL AND "resolvedAt" IS NOT NULL AND "resolvedById" IS NOT NULL))
);

CREATE FUNCTION "closure_discrepancies_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'closure_discrepancies no admite DELETE';
  END IF;
  IF NEW."closureId" IS DISTINCT FROM OLD."closureId"
     OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."chipStockCountId" IS DISTINCT FROM OLD."chipStockCountId"
     OR NEW."cashReconciliationId" IS DISTINCT FROM OLD."cashReconciliationId"
     OR NEW."expectedAmount" IS DISTINCT FROM OLD."expectedAmount"
     OR NEW."countedAmount" IS DISTINCT FROM OLD."countedAmount"
     OR NEW."differenceAmount" IS DISTINCT FROM OLD."differenceAmount"
     OR NEW."detectedAt" IS DISTINCT FROM OLD."detectedAt"
  THEN
    RAISE EXCEPTION 'La diferencia original de un arqueo de cierre es inmutable';
  END IF;
  IF OLD."status" = 'RESOLVED' THEN
    RAISE EXCEPTION 'Una diferencia resuelta es inmutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "closure_discrepancies_guard" BEFORE UPDATE OR DELETE ON "closure_discrepancies"
  FOR EACH ROW EXECUTE FUNCTION "closure_discrepancies_guard"();

-- ── Retiro final, ajustes y autorización ──────────────────────────────
ALTER TABLE "closure_cash_withdrawals" ADD CONSTRAINT "closure_cash_withdrawals_valid" CHECK (
  "amount" > 0 AND length(btrim("recipientName")) > 0
);
ALTER TABLE "closure_adjustment_authorizations" ADD CONSTRAINT "closure_adjustments_valid" CHECK (
  length(btrim("reason")) > 0
  AND (("chipOperationId" IS NOT NULL) <> ("cashTransactionId" IS NOT NULL))
);
ALTER TABLE "closure_prechecks" ADD CONSTRAINT "closure_prechecks_counts" CHECK (
  "blockingCount" >= 0 AND "warningCount" >= 0 AND "infoCount" >= 0
);

-- ── Solo inserción (evidencia del cierre) ─────────────────────────────
CREATE FUNCTION "closure_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% es de solo inserción (%)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "closure_status_history_immutable" BEFORE UPDATE OR DELETE ON "closure_status_history"
  FOR EACH ROW EXECUTE FUNCTION "closure_append_only"();
CREATE TRIGGER "closure_prechecks_immutable" BEFORE UPDATE OR DELETE ON "closure_prechecks"
  FOR EACH ROW EXECUTE FUNCTION "closure_append_only"();
CREATE TRIGGER "closure_adjustments_immutable" BEFORE UPDATE OR DELETE ON "closure_adjustment_authorizations"
  FOR EACH ROW EXECUTE FUNCTION "closure_append_only"();
CREATE TRIGGER "closure_cash_withdrawals_immutable" BEFORE UPDATE OR DELETE ON "closure_cash_withdrawals"
  FOR EACH ROW EXECUTE FUNCTION "closure_append_only"();
CREATE TRIGGER "closure_approvals_immutable" BEFORE UPDATE OR DELETE ON "closure_approvals"
  FOR EACH ROW EXECUTE FUNCTION "closure_append_only"();
CREATE TRIGGER "closure_reports_immutable" BEFORE UPDATE OR DELETE ON "closure_reports"
  FOR EACH ROW EXECUTE FUNCTION "closure_append_only"();
