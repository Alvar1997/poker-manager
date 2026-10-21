-- Corrección: inventario operativo por VALOR NOMINAL (compras y recompras se
-- capturan solo por importe). Las cantidades por denominación quedan como
-- composición física de referencia, verificada en los arqueos.
-- Migración aditiva: no borra movimientos ni reinicia el inventario.

-- AlterEnum
ALTER TYPE "ChipMovementType" ADD VALUE 'COMPOSITION_UPDATE';

-- AlterEnum
ALTER TYPE "ChipOperationType" ADD VALUE 'COMPOSITION_UPDATE';

-- AlterTable
ALTER TABLE "chip_reservations" ADD COLUMN     "amount" DECIMAL(14,2);

-- AlterTable
ALTER TABLE "chip_set_inventory_states" ADD COLUMN     "breakdownExact" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "circulationNominal" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "custodyNominal" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "reservedNominal" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "chip_stock_counts" ADD COLUMN     "breakdownExact" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "compositionOperationId" TEXT,
ADD COLUMN     "resultingInventoryVersion" INTEGER;

-- CreateTable
CREATE TABLE "chip_nominal_movements" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "chipSetId" TEXT NOT NULL,
    "movementType" "ChipMovementType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "custodyBefore" DECIMAL(14,2) NOT NULL,
    "custodyAfter" DECIMAL(14,2) NOT NULL,
    "circulationBefore" DECIMAL(14,2) NOT NULL,
    "circulationAfter" DECIMAL(14,2) NOT NULL,
    "reason" TEXT,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "tableId" TEXT,
    "sessionId" TEXT,
    "playerId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chip_nominal_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chip_nominal_movements_chipSetId_createdAt_idx" ON "chip_nominal_movements"("chipSetId", "createdAt");

-- CreateIndex
CREATE INDEX "chip_nominal_movements_tableId_createdAt_idx" ON "chip_nominal_movements"("tableId", "createdAt");

-- CreateIndex
CREATE INDEX "chip_nominal_movements_sessionId_idx" ON "chip_nominal_movements"("sessionId");

-- CreateIndex
CREATE INDEX "chip_nominal_movements_referenceType_referenceId_idx" ON "chip_nominal_movements"("referenceType", "referenceId");

-- CreateIndex
CREATE UNIQUE INDEX "chip_stock_counts_compositionOperationId_key" ON "chip_stock_counts"("compositionOperationId");

-- AddForeignKey
ALTER TABLE "chip_nominal_movements" ADD CONSTRAINT "chip_nominal_movements_operationId_chipSetId_fkey" FOREIGN KEY ("operationId", "chipSetId") REFERENCES "chip_inventory_operations"("id", "chipSetId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_nominal_movements" ADD CONSTRAINT "chip_nominal_movements_chipSetId_fkey" FOREIGN KEY ("chipSetId") REFERENCES "chip_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_nominal_movements" ADD CONSTRAINT "chip_nominal_movements_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "poker_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_nominal_movements" ADD CONSTRAINT "chip_nominal_movements_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_nominal_movements" ADD CONSTRAINT "chip_nominal_movements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Saldo nominal inicial = valor de las existencias registradas ───────
-- (custodia, reservado y circulación ya registrados por denominación; no se
-- inventa nada: es el mismo valor expresado en importe).
UPDATE "chip_set_inventory_states" st SET
  "custodyNominal" = COALESCE((SELECT SUM(b."quantity" * d."value") FROM "chip_inventory_balances" b
                               JOIN "chip_denominations" d ON d."id" = b."denominationId"
                               WHERE b."chipSetId" = st."chipSetId" AND b."location" = 'CUSTODY'), 0),
  "reservedNominal" = COALESCE((SELECT SUM(b."reserved" * d."value") FROM "chip_inventory_balances" b
                                JOIN "chip_denominations" d ON d."id" = b."denominationId"
                                WHERE b."chipSetId" = st."chipSetId" AND b."location" = 'CUSTODY'), 0),
  "circulationNominal" = COALESCE((SELECT SUM(b."quantity" * d."value") FROM "chip_inventory_balances" b
                                   JOIN "chip_denominations" d ON d."id" = b."denominationId"
                                   WHERE b."chipSetId" = st."chipSetId" AND b."location" = 'CIRCULATION'), 0);

-- Vigencia explícita de los arqueos ya confirmados (misma regla que antes).
UPDATE "chip_stock_counts" SET "resultingInventoryVersion" =
  "inventoryVersion" + (CASE WHEN "countType" = 'INITIAL' THEN 1 ELSE 0 END)
                     + (CASE WHEN "reconciliationOperationId" IS NOT NULL THEN 1 ELSE 0 END)
WHERE "status" = 'CONFIRMED';

UPDATE "chip_reservations" r SET "amount" = (
  SELECT SUM(i."quantity" * d."value") FROM "chip_reservation_items" i
  JOIN "chip_denominations" d ON d."id" = i."denominationId" WHERE i."reservationId" = r."id")
WHERE "amount" IS NULL AND EXISTS (SELECT 1 FROM "chip_reservation_items" i WHERE i."reservationId" = r."id");

-- ── Invariantes nominales ───────────────────────────────────────────────
ALTER TABLE "chip_set_inventory_states" ADD CONSTRAINT "chip_states_nominal_valid"
  CHECK ("custodyNominal" >= 0 AND "reservedNominal" >= 0 AND "circulationNominal" >= 0
         AND "reservedNominal" <= "custodyNominal");
ALTER TABLE "chip_nominal_movements" ADD CONSTRAINT "chip_nominal_movements_valid"
  CHECK ("amount" > 0 AND "custodyBefore" >= 0 AND "custodyAfter" >= 0
         AND "circulationBefore" >= 0 AND "circulationAfter" >= 0);
ALTER TABLE "chip_reservations" ADD CONSTRAINT "chip_reservations_amount_positive"
  CHECK ("amount" IS NULL OR "amount" > 0);

CREATE TRIGGER "chip_nominal_movements_immutable"
  BEFORE UPDATE OR DELETE ON "chip_nominal_movements"
  FOR EACH ROW EXECUTE FUNCTION "chip_ledger_prevent_mutation"();

-- ── Arqueos: la versión resultante solo cambia al conciliar ────────────
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
    OR (OLD."reconciliationStatus" = 'RECONCILED'
        AND NEW."reconciliationStatus" IS DISTINCT FROM OLD."reconciliationStatus")
  ) THEN
    RAISE EXCEPTION 'Un arqueo confirmado o cancelado es inmutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
