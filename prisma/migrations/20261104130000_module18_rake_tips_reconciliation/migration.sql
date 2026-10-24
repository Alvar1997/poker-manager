-- Módulo 18 (simplificado): rake por mesa, propinas por empleado y diferencia de fichas al cierre.
-- Solo agrega tablas, columnas, constraints y triggers. Único cambio de datos: modalidad sugerida
-- de rake de la mesa 25/25 (conteo final) y el catálogo inicial de puestos.

-- AlterTable
ALTER TABLE "poker_tables" ADD COLUMN     "rakeMode" "RakeMode" NOT NULL DEFAULT 'MANUAL';

-- CreateTable
CREATE TABLE "rake_movements" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "kind" "RakeMovementKind" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "correctsMovementId" TEXT,
    "correctsCountId" TEXT,
    "chipOperationId" TEXT,
    "modeSnapshot" "RakeMode" NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById" TEXT NOT NULL,
    "notes" TEXT,
    "reason" TEXT,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "rake_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rake_counts" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "modeSnapshot" "RakeMode" NOT NULL,
    "registeredAmount" DECIMAL(14,2) NOT NULL,
    "countedAmount" DECIMAL(14,2) NOT NULL,
    "zeroConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "chipOperationId" TEXT,
    "notes" TEXT,
    "countedById" TEXT NOT NULL,
    "countedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "rake_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_positions" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_members" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "positionId" TEXT NOT NULL,
    "dealerId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_staff" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "staffMemberId" TEXT NOT NULL,
    "addedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_tip_counts" (
    "id" TEXT NOT NULL,
    "sessionStaffId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" "StaffTipCountStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "savedById" TEXT NOT NULL,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "chipOperationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_tip_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_tip_entries" (
    "id" TEXT NOT NULL,
    "sessionStaffId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" "StaffTipEntryKind" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT,
    "chipOperationId" TEXT,
    "recordedById" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "staff_tip_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_chip_differences" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "closureId" TEXT NOT NULL,
    "delivered" DECIMAL(14,2) NOT NULL,
    "returnedByPlayers" DECIMAL(14,2) NOT NULL,
    "rake" DECIMAL(14,2) NOT NULL,
    "tips" DECIMAL(14,2) NOT NULL,
    "otherReturns" DECIMAL(14,2) NOT NULL,
    "nominalDifference" DECIMAL(14,2) NOT NULL,
    "physicalExpected" DECIMAL(14,2),
    "physicalCounted" DECIMAL(14,2),
    "physicalDifference" DECIMAL(14,2),
    "reason" TEXT NOT NULL,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_chip_differences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rake_movements_chipOperationId_key" ON "rake_movements"("chipOperationId");

-- CreateIndex
CREATE UNIQUE INDEX "rake_movements_idempotencyKey_key" ON "rake_movements"("idempotencyKey");

-- CreateIndex
CREATE INDEX "rake_movements_sessionId_tableId_effectiveAt_idx" ON "rake_movements"("sessionId", "tableId", "effectiveAt");

-- CreateIndex
CREATE INDEX "rake_movements_cycleId_idx" ON "rake_movements"("cycleId");

-- CreateIndex
CREATE UNIQUE INDEX "rake_counts_cycleId_key" ON "rake_counts"("cycleId");

-- CreateIndex
CREATE UNIQUE INDEX "rake_counts_chipOperationId_key" ON "rake_counts"("chipOperationId");

-- CreateIndex
CREATE UNIQUE INDEX "rake_counts_idempotencyKey_key" ON "rake_counts"("idempotencyKey");

-- CreateIndex
CREATE INDEX "rake_counts_sessionId_tableId_idx" ON "rake_counts"("sessionId", "tableId");

-- CreateIndex
CREATE UNIQUE INDEX "staff_positions_code_key" ON "staff_positions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "staff_members_dealerId_key" ON "staff_members"("dealerId");

-- CreateIndex
CREATE INDEX "staff_members_isActive_name_idx" ON "staff_members"("isActive", "name");

-- CreateIndex
CREATE UNIQUE INDEX "session_staff_sessionId_staffMemberId_key" ON "session_staff"("sessionId", "staffMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "staff_tip_counts_sessionStaffId_key" ON "staff_tip_counts"("sessionStaffId");

-- CreateIndex
CREATE UNIQUE INDEX "staff_tip_counts_chipOperationId_key" ON "staff_tip_counts"("chipOperationId");

-- CreateIndex
CREATE INDEX "staff_tip_counts_sessionId_status_idx" ON "staff_tip_counts"("sessionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "staff_tip_entries_chipOperationId_key" ON "staff_tip_entries"("chipOperationId");

-- CreateIndex
CREATE UNIQUE INDEX "staff_tip_entries_idempotencyKey_key" ON "staff_tip_entries"("idempotencyKey");

-- CreateIndex
CREATE INDEX "staff_tip_entries_sessionStaffId_recordedAt_idx" ON "staff_tip_entries"("sessionStaffId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "session_chip_differences_closureId_key" ON "session_chip_differences"("closureId");

-- CreateIndex
CREATE INDEX "session_chip_differences_sessionId_idx" ON "session_chip_differences"("sessionId");

-- AddForeignKey
ALTER TABLE "rake_movements" ADD CONSTRAINT "rake_movements_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "poker_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rake_movements" ADD CONSTRAINT "rake_movements_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "poker_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rake_movements" ADD CONSTRAINT "rake_movements_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "session_table_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rake_movements" ADD CONSTRAINT "rake_movements_chipOperationId_fkey" FOREIGN KEY ("chipOperationId") REFERENCES "chip_inventory_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rake_movements" ADD CONSTRAINT "rake_movements_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rake_counts" ADD CONSTRAINT "rake_counts_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "poker_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rake_counts" ADD CONSTRAINT "rake_counts_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "poker_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rake_counts" ADD CONSTRAINT "rake_counts_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "session_table_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rake_counts" ADD CONSTRAINT "rake_counts_chipOperationId_fkey" FOREIGN KEY ("chipOperationId") REFERENCES "chip_inventory_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rake_counts" ADD CONSTRAINT "rake_counts_countedById_fkey" FOREIGN KEY ("countedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "staff_positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "dealers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_staff" ADD CONSTRAINT "session_staff_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "poker_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_staff" ADD CONSTRAINT "session_staff_staffMemberId_fkey" FOREIGN KEY ("staffMemberId") REFERENCES "staff_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_staff" ADD CONSTRAINT "session_staff_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_tip_counts" ADD CONSTRAINT "staff_tip_counts_sessionStaffId_fkey" FOREIGN KEY ("sessionStaffId") REFERENCES "session_staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_tip_counts" ADD CONSTRAINT "staff_tip_counts_savedById_fkey" FOREIGN KEY ("savedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_tip_counts" ADD CONSTRAINT "staff_tip_counts_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_tip_counts" ADD CONSTRAINT "staff_tip_counts_chipOperationId_fkey" FOREIGN KEY ("chipOperationId") REFERENCES "chip_inventory_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_tip_entries" ADD CONSTRAINT "staff_tip_entries_sessionStaffId_fkey" FOREIGN KEY ("sessionStaffId") REFERENCES "session_staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_tip_entries" ADD CONSTRAINT "staff_tip_entries_chipOperationId_fkey" FOREIGN KEY ("chipOperationId") REFERENCES "chip_inventory_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_tip_entries" ADD CONSTRAINT "staff_tip_entries_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_chip_differences" ADD CONSTRAINT "session_chip_differences_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "poker_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_chip_differences" ADD CONSTRAINT "session_chip_differences_closureId_fkey" FOREIGN KEY ("closureId") REFERENCES "session_closures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_chip_differences" ADD CONSTRAINT "session_chip_differences_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Reglas en la base ──────────────────────────────────────────────────

UPDATE "poker_tables" SET "rakeMode" = 'FINAL_COUNT' WHERE "code" = 'TABLE_25_25';

INSERT INTO "staff_positions" ("id", "code", "name", "sortOrder") VALUES
  ('staffpos_dealer', 'DEALER', 'Dealer', 1),
  ('staffpos_waiter', 'WAITER', 'Mesero', 2),
  ('staffpos_other', 'OTHER', 'Otro', 3)
ON CONFLICT ("code") DO NOTHING;

-- Rake: registros > 0; correcciones ≠ 0 con motivo y con su movimiento de fichas.
ALTER TABLE "rake_movements" ADD CONSTRAINT "rake_movements_valid"
  CHECK (("kind" = 'MANUAL_ENTRY' AND "amount" > 0 AND "chipOperationId" IS NOT NULL)
      OR ("kind" = 'CORRECTION' AND "amount" <> 0 AND "chipOperationId" IS NOT NULL
          AND "reason" IS NOT NULL AND length("reason") >= 5
          AND ("correctsMovementId" IS NOT NULL OR "correctsCountId" IS NOT NULL)));

-- Conteo del recipiente: $0 explícito; en conteo final con fichas hay entrada nominal;
-- en manual es comprobación (sin entrada: cada registro ya entró).
ALTER TABLE "rake_counts" ADD CONSTRAINT "rake_counts_valid"
  CHECK ("countedAmount" >= 0 AND "registeredAmount" >= 0
     AND ("countedAmount" > 0 OR "zeroConfirmed" = true)
     AND (("modeSnapshot" = 'FINAL_COUNT' AND (("countedAmount" > 0) = ("chipOperationId" IS NOT NULL)))
       OR ("modeSnapshot" = 'MANUAL' AND "chipOperationId" IS NULL)));

ALTER TABLE "staff_tip_counts" ADD CONSTRAINT "staff_tip_counts_valid"
  CHECK ("amount" >= 0
     AND ("status" = 'DRAFT' OR ("confirmedById" IS NOT NULL AND "confirmedAt" IS NOT NULL
          AND (("amount" > 0) = ("chipOperationId" IS NOT NULL)))));

ALTER TABLE "staff_tip_entries" ADD CONSTRAINT "staff_tip_entries_valid"
  CHECK (("kind" = 'PARTIAL' AND "amount" > 0 AND "chipOperationId" IS NULL)
      OR ("kind" = 'CORRECTION' AND "amount" <> 0 AND "chipOperationId" IS NOT NULL
          AND "reason" IS NOT NULL AND length("reason") >= 5));

ALTER TABLE "session_chip_differences" ADD CONSTRAINT "session_chip_differences_reason"
  CHECK (length("reason") >= 5);

-- Historial inmutable (solo inserción).
CREATE TRIGGER "rake_movements_append_only" BEFORE UPDATE OR DELETE ON "rake_movements"
  FOR EACH ROW EXECUTE FUNCTION "m15_append_only"();
CREATE TRIGGER "rake_counts_append_only" BEFORE UPDATE OR DELETE ON "rake_counts"
  FOR EACH ROW EXECUTE FUNCTION "m15_append_only"();
CREATE TRIGGER "staff_tip_entries_append_only" BEFORE UPDATE OR DELETE ON "staff_tip_entries"
  FOR EACH ROW EXECUTE FUNCTION "m15_append_only"();
CREATE TRIGGER "session_chip_differences_append_only" BEFORE UPDATE OR DELETE ON "session_chip_differences"
  FOR EACH ROW EXECUTE FUNCTION "m15_append_only"();
CREATE TRIGGER "session_staff_append_only" BEFORE UPDATE OR DELETE ON "session_staff"
  FOR EACH ROW EXECUTE FUNCTION "m15_append_only"();

-- Conteo de propinas: el borrador se edita; confirmado es inmutable; nunca se borra.
CREATE FUNCTION "staff_tip_counts_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Un conteo de propinas no se borra' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'CONFIRMED' THEN
    RAISE EXCEPTION 'Un conteo de propinas confirmado es inmutable: registra una corrección'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sessionStaffId" <> OLD."sessionStaffId" OR NEW."sessionId" <> OLD."sessionId" THEN
    RAISE EXCEPTION 'El conteo pertenece a su empleado y sesión' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "staff_tip_counts_guard" BEFORE UPDATE OR DELETE ON "staff_tip_counts"
  FOR EACH ROW EXECUTE FUNCTION "staff_tip_counts_guard"();

-- Staff: nunca se borra (se desactiva).
CREATE FUNCTION "m18_no_delete"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Registro histórico: no se borra' USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "staff_members_no_delete" BEFORE DELETE ON "staff_members"
  FOR EACH ROW EXECUTE FUNCTION "m18_no_delete"();

-- Arqueos de fichas: PENDING → ACCEPTED_WITH_DIFFERENCE (solo cierre; final).
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
    OR (OLD."reconciliationStatus" IN ('RECONCILED', 'SUPERSEDED', 'ACCEPTED_WITH_DIFFERENCE')
        AND NEW."reconciliationStatus" IS DISTINCT FROM OLD."reconciliationStatus")
    OR (NEW."reconciliationStatus" IN ('SUPERSEDED', 'ACCEPTED_WITH_DIFFERENCE')
        AND OLD."reconciliationStatus" IS DISTINCT FROM NEW."reconciliationStatus"
        AND (OLD."reconciliationStatus" <> 'PENDING' OR OLD."countType" <> 'CLOSING'))
  ) THEN
    RAISE EXCEPTION 'Un arqueo confirmado o cancelado es inmutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
