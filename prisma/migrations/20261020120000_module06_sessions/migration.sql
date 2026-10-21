-- Módulo 06: sesiones y apertura operativa. Aditiva: no crea sesiones ni
-- arqueos; solo estructura y garantías en la base.

-- CreateEnum
CREATE TYPE "PokerSessionStatus" AS ENUM ('DRAFT', 'PREPARATION', 'OPEN', 'CLOSING', 'CLOSED', 'CANCELLED');

-- CreateTable
CREATE TABLE "poker_sessions" (
    "id" TEXT NOT NULL,
    "folio" TEXT NOT NULL,
    "cashBoxId" TEXT NOT NULL,
    "status" "PokerSessionStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT NOT NULL,
    "openedById" TEXT,
    "openedAt" TIMESTAMP(3),
    "preparationStartedAt" TIMESTAMP(3),
    "closingStartedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancellationReason" TEXT,
    "notes" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "poker_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_openings" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "chipStockCountId" TEXT NOT NULL,
    "cashReconciliationId" TEXT NOT NULL,
    "confirmedById" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inventoryVersion" INTEGER NOT NULL,
    "openingCashAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "superadminIntervention" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "session_openings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_status_history" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "fromStatus" "PokerSessionStatus",
    "toStatus" "PokerSessionStatus" NOT NULL,
    "changedById" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,

    CONSTRAINT "session_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "poker_sessions_folio_key" ON "poker_sessions"("folio");

-- CreateIndex
CREATE UNIQUE INDEX "poker_sessions_idempotencyKey_key" ON "poker_sessions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "poker_sessions_status_idx" ON "poker_sessions"("status");

-- CreateIndex
CREATE INDEX "poker_sessions_createdAt_idx" ON "poker_sessions"("createdAt");

-- CreateIndex
CREATE INDEX "poker_sessions_createdById_idx" ON "poker_sessions"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "session_openings_sessionId_key" ON "session_openings"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "session_openings_chipStockCountId_key" ON "session_openings"("chipStockCountId");

-- CreateIndex
CREATE UNIQUE INDEX "session_openings_cashReconciliationId_key" ON "session_openings"("cashReconciliationId");

-- CreateIndex
CREATE UNIQUE INDEX "session_openings_idempotencyKey_key" ON "session_openings"("idempotencyKey");

-- CreateIndex
CREATE INDEX "session_status_history_sessionId_changedAt_idx" ON "session_status_history"("sessionId", "changedAt");

-- AddForeignKey
ALTER TABLE "poker_sessions" ADD CONSTRAINT "poker_sessions_cashBoxId_fkey" FOREIGN KEY ("cashBoxId") REFERENCES "cash_boxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "poker_sessions" ADD CONSTRAINT "poker_sessions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "poker_sessions" ADD CONSTRAINT "poker_sessions_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "poker_sessions" ADD CONSTRAINT "poker_sessions_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_openings" ADD CONSTRAINT "session_openings_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "poker_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_openings" ADD CONSTRAINT "session_openings_chipStockCountId_fkey" FOREIGN KEY ("chipStockCountId") REFERENCES "chip_stock_counts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_openings" ADD CONSTRAINT "session_openings_cashReconciliationId_fkey" FOREIGN KEY ("cashReconciliationId") REFERENCES "cash_reconciliations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_openings" ADD CONSTRAINT "session_openings_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_status_history" ADD CONSTRAINT "session_status_history_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "poker_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_status_history" ADD CONSTRAINT "session_status_history_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Una sola sesión VIGENTE a la vez (garantía en PostgreSQL) ──────────
-- Dos creaciones simultáneas: la segunda viola este índice (409), aunque
-- corran en instancias serverless distintas.
CREATE UNIQUE INDEX "poker_sessions_single_active" ON "poker_sessions" ((true))
  WHERE "status" IN ('DRAFT', 'PREPARATION', 'OPEN', 'CLOSING');

-- ── Coherencia de estados ───────────────────────────────────────────────
ALTER TABLE "poker_sessions" ADD CONSTRAINT "poker_sessions_state_fields"
  CHECK (
    ("status" NOT IN ('OPEN', 'CLOSING', 'CLOSED') OR ("openedAt" IS NOT NULL AND "openedById" IS NOT NULL))
    AND ("status" <> 'CANCELLED' OR ("cancelledAt" IS NOT NULL AND "cancellationReason" IS NOT NULL
                                     AND length(trim("cancellationReason")) > 0))
    AND ("status" <> 'CLOSED' OR "closedAt" IS NOT NULL)
  );

-- Transiciones válidas, campos de sistema inmutables y sin DELETE.
CREATE FUNCTION "poker_sessions_guard"() RETURNS trigger AS $$
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
    OR (OLD."status" = 'CLOSING' AND NEW."status" = 'CLOSED')
  ) THEN
    RAISE EXCEPTION 'Transición de sesión no permitida: % → %', OLD."status", NEW."status";
  END IF;
  IF OLD."status" IN ('CLOSED', 'CANCELLED') THEN
    RAISE EXCEPTION 'Una sesión % no se modifica', OLD."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "poker_sessions_guard" BEFORE UPDATE OR DELETE ON "poker_sessions"
  FOR EACH ROW EXECUTE FUNCTION "poker_sessions_guard"();

-- Una sesión nace en DRAFT.
CREATE FUNCTION "poker_sessions_insert_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'Una sesión se crea en DRAFT';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "poker_sessions_insert_guard" BEFORE INSERT ON "poker_sessions"
  FOR EACH ROW EXECUTE FUNCTION "poker_sessions_insert_guard"();

-- ── Evidencia de apertura: $0 y solo inserción ─────────────────────────
ALTER TABLE "session_openings" ADD CONSTRAINT "session_openings_zero_cash"
  CHECK ("openingCashAmount" = 0 AND "inventoryVersion" >= 0);

CREATE FUNCTION "session_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% es de solo inserción (%)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "session_openings_immutable" BEFORE UPDATE OR DELETE ON "session_openings"
  FOR EACH ROW EXECUTE FUNCTION "session_append_only"();
CREATE TRIGGER "session_status_history_immutable" BEFORE UPDATE OR DELETE ON "session_status_history"
  FOR EACH ROW EXECUTE FUNCTION "session_append_only"();
