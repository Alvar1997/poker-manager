-- Módulo 04: inventario físico de fichas (maletines, existencias, libro de
-- movimientos, arqueos, conciliación y reservas). Aditiva: no modifica datos.
-- CreateEnum
CREATE TYPE "ChipLocation" AS ENUM ('CUSTODY', 'CIRCULATION', 'RETIRED');

-- CreateEnum
CREATE TYPE "ChipOperationType" AS ENUM ('INITIAL_STOCK', 'STOCK_ENTRY', 'STOCK_WITHDRAWAL', 'INVENTORY_ADJUSTMENT', 'COUNT_RECONCILIATION', 'CHIP_DELIVERY', 'CHIP_RETURN', 'INTERNAL_TRANSFER', 'CHIP_CONVERSION');

-- CreateEnum
CREATE TYPE "ChipMovementType" AS ENUM ('INITIAL_STOCK', 'STOCK_ENTRY', 'STOCK_WITHDRAWAL', 'INVENTORY_ADJUSTMENT', 'CHIP_DELIVERY', 'CHIP_RETURN', 'INTERNAL_TRANSFER', 'CHIP_CONVERSION', 'REVERSAL');

-- CreateEnum
CREATE TYPE "ChipWithdrawalCategory" AS ENUM ('DAMAGE', 'CONFIRMED_LOSS', 'PERMANENT_RETIREMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "ChipAdjustmentKind" AS ENUM ('SHORTAGE', 'SURPLUS', 'CORRECTION');

-- CreateEnum
CREATE TYPE "ChipCountType" AS ENUM ('INITIAL', 'OPENING', 'CONTROL', 'CLOSING');

-- CreateEnum
CREATE TYPE "ChipCountStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ChipReconciliationStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'RECONCILED');

-- CreateEnum
CREATE TYPE "ChipReservationStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED');

-- CreateTable
CREATE TABLE "chip_containers" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "chipSetId" TEXT NOT NULL,
    "description" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chip_containers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chip_set_inventory_states" (
    "chipSetId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "initializedAt" TIMESTAMP(3),
    "initializedById" TEXT,
    "initialCountId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chip_set_inventory_states_pkey" PRIMARY KEY ("chipSetId")
);

-- CreateTable
CREATE TABLE "chip_inventory_balances" (
    "id" TEXT NOT NULL,
    "chipSetId" TEXT NOT NULL,
    "denominationId" TEXT NOT NULL,
    "containerId" TEXT NOT NULL,
    "location" "ChipLocation" NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chip_inventory_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chip_inventory_operations" (
    "id" TEXT NOT NULL,
    "type" "ChipOperationType" NOT NULL,
    "chipSetId" TEXT NOT NULL,
    "containerId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "adjustmentKind" "ChipAdjustmentKind",
    "withdrawalCategory" "ChipWithdrawalCategory",
    "reason" TEXT,
    "notes" TEXT,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "stockCountId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chip_inventory_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chip_inventory_movements" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "chipSetId" TEXT NOT NULL,
    "denominationId" TEXT NOT NULL,
    "containerId" TEXT NOT NULL,
    "containerCode" TEXT NOT NULL,
    "unitValue" DECIMAL(12,2) NOT NULL,
    "movementType" "ChipMovementType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "fromLocation" "ChipLocation",
    "toLocation" "ChipLocation",
    "custodyBefore" INTEGER NOT NULL,
    "custodyAfter" INTEGER NOT NULL,
    "reason" TEXT,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chip_inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chip_stock_counts" (
    "id" TEXT NOT NULL,
    "chipSetId" TEXT NOT NULL,
    "containerId" TEXT NOT NULL,
    "countType" "ChipCountType" NOT NULL,
    "status" "ChipCountStatus" NOT NULL DEFAULT 'DRAFT',
    "reconciliationStatus" "ChipReconciliationStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "inventoryVersion" INTEGER NOT NULL,
    "expectedTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "countedTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "differenceTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "reconciliationReason" TEXT,
    "reconciliationOperationId" TEXT,
    "sessionId" TEXT,
    "countedById" TEXT,
    "confirmedById" TEXT,
    "reconciledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "reconciledAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "chip_stock_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chip_stock_count_details" (
    "id" TEXT NOT NULL,
    "stockCountId" TEXT NOT NULL,
    "chipSetId" TEXT NOT NULL,
    "denominationId" TEXT NOT NULL,
    "unitValue" DECIMAL(12,2) NOT NULL,
    "expectedQuantity" INTEGER NOT NULL,
    "countedQuantity" INTEGER,
    "differenceQuantity" INTEGER,

    CONSTRAINT "chip_stock_count_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chip_reservations" (
    "id" TEXT NOT NULL,
    "chipSetId" TEXT NOT NULL,
    "containerId" TEXT NOT NULL,
    "status" "ChipReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "referenceType" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumeOperationId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "chip_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chip_reservation_items" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "chipSetId" TEXT NOT NULL,
    "denominationId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "chip_reservation_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chip_containers_code_key" ON "chip_containers"("code");

-- CreateIndex
CREATE INDEX "chip_containers_chipSetId_idx" ON "chip_containers"("chipSetId");

-- CreateIndex
CREATE UNIQUE INDEX "chip_containers_chipSetId_id_key" ON "chip_containers"("chipSetId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "chip_set_inventory_states_initialCountId_key" ON "chip_set_inventory_states"("initialCountId");

-- CreateIndex
CREATE INDEX "chip_inventory_balances_chipSetId_idx" ON "chip_inventory_balances"("chipSetId");

-- CreateIndex
CREATE UNIQUE INDEX "chip_inventory_balances_containerId_denominationId_location_key" ON "chip_inventory_balances"("containerId", "denominationId", "location");

-- CreateIndex
CREATE UNIQUE INDEX "chip_inventory_operations_idempotencyKey_key" ON "chip_inventory_operations"("idempotencyKey");

-- CreateIndex
CREATE INDEX "chip_inventory_operations_chipSetId_createdAt_idx" ON "chip_inventory_operations"("chipSetId", "createdAt");

-- CreateIndex
CREATE INDEX "chip_inventory_operations_referenceType_referenceId_idx" ON "chip_inventory_operations"("referenceType", "referenceId");

-- CreateIndex
CREATE UNIQUE INDEX "chip_inventory_operations_id_chipSetId_key" ON "chip_inventory_operations"("id", "chipSetId");

-- CreateIndex
CREATE INDEX "chip_inventory_movements_chipSetId_createdAt_idx" ON "chip_inventory_movements"("chipSetId", "createdAt");

-- CreateIndex
CREATE INDEX "chip_inventory_movements_denominationId_createdAt_idx" ON "chip_inventory_movements"("denominationId", "createdAt");

-- CreateIndex
CREATE INDEX "chip_inventory_movements_movementType_idx" ON "chip_inventory_movements"("movementType");

-- CreateIndex
CREATE INDEX "chip_inventory_movements_createdById_idx" ON "chip_inventory_movements"("createdById");

-- CreateIndex
CREATE INDEX "chip_inventory_movements_operationId_idx" ON "chip_inventory_movements"("operationId");

-- CreateIndex
CREATE UNIQUE INDEX "chip_stock_counts_reconciliationOperationId_key" ON "chip_stock_counts"("reconciliationOperationId");

-- CreateIndex
CREATE INDEX "chip_stock_counts_chipSetId_createdAt_idx" ON "chip_stock_counts"("chipSetId", "createdAt");

-- CreateIndex
CREATE INDEX "chip_stock_counts_status_idx" ON "chip_stock_counts"("status");

-- CreateIndex
CREATE INDEX "chip_stock_counts_reconciliationStatus_idx" ON "chip_stock_counts"("reconciliationStatus");

-- CreateIndex
CREATE UNIQUE INDEX "chip_stock_counts_id_chipSetId_key" ON "chip_stock_counts"("id", "chipSetId");

-- CreateIndex
CREATE UNIQUE INDEX "chip_stock_count_details_stockCountId_denominationId_key" ON "chip_stock_count_details"("stockCountId", "denominationId");

-- CreateIndex
CREATE UNIQUE INDEX "chip_reservations_idempotencyKey_key" ON "chip_reservations"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "chip_reservations_consumeOperationId_key" ON "chip_reservations"("consumeOperationId");

-- CreateIndex
CREATE INDEX "chip_reservations_chipSetId_status_idx" ON "chip_reservations"("chipSetId", "status");

-- CreateIndex
CREATE INDEX "chip_reservations_status_expiresAt_idx" ON "chip_reservations"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "chip_reservations_id_chipSetId_key" ON "chip_reservations"("id", "chipSetId");

-- CreateIndex
CREATE UNIQUE INDEX "chip_reservation_items_reservationId_denominationId_key" ON "chip_reservation_items"("reservationId", "denominationId");

-- CreateIndex
CREATE UNIQUE INDEX "chip_denominations_chipSetId_id_key" ON "chip_denominations"("chipSetId", "id");

-- AddForeignKey
ALTER TABLE "chip_containers" ADD CONSTRAINT "chip_containers_chipSetId_fkey" FOREIGN KEY ("chipSetId") REFERENCES "chip_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_set_inventory_states" ADD CONSTRAINT "chip_set_inventory_states_chipSetId_fkey" FOREIGN KEY ("chipSetId") REFERENCES "chip_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_set_inventory_states" ADD CONSTRAINT "chip_set_inventory_states_initializedById_fkey" FOREIGN KEY ("initializedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_inventory_balances" ADD CONSTRAINT "chip_inventory_balances_chipSetId_fkey" FOREIGN KEY ("chipSetId") REFERENCES "chip_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_inventory_balances" ADD CONSTRAINT "chip_inventory_balances_chipSetId_denominationId_fkey" FOREIGN KEY ("chipSetId", "denominationId") REFERENCES "chip_denominations"("chipSetId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_inventory_balances" ADD CONSTRAINT "chip_inventory_balances_chipSetId_containerId_fkey" FOREIGN KEY ("chipSetId", "containerId") REFERENCES "chip_containers"("chipSetId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_inventory_operations" ADD CONSTRAINT "chip_inventory_operations_chipSetId_fkey" FOREIGN KEY ("chipSetId") REFERENCES "chip_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_inventory_operations" ADD CONSTRAINT "chip_inventory_operations_chipSetId_containerId_fkey" FOREIGN KEY ("chipSetId", "containerId") REFERENCES "chip_containers"("chipSetId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_inventory_operations" ADD CONSTRAINT "chip_inventory_operations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_inventory_movements" ADD CONSTRAINT "chip_inventory_movements_operationId_chipSetId_fkey" FOREIGN KEY ("operationId", "chipSetId") REFERENCES "chip_inventory_operations"("id", "chipSetId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_inventory_movements" ADD CONSTRAINT "chip_inventory_movements_chipSetId_fkey" FOREIGN KEY ("chipSetId") REFERENCES "chip_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_inventory_movements" ADD CONSTRAINT "chip_inventory_movements_chipSetId_denominationId_fkey" FOREIGN KEY ("chipSetId", "denominationId") REFERENCES "chip_denominations"("chipSetId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_inventory_movements" ADD CONSTRAINT "chip_inventory_movements_chipSetId_containerId_fkey" FOREIGN KEY ("chipSetId", "containerId") REFERENCES "chip_containers"("chipSetId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_inventory_movements" ADD CONSTRAINT "chip_inventory_movements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_stock_counts" ADD CONSTRAINT "chip_stock_counts_chipSetId_fkey" FOREIGN KEY ("chipSetId") REFERENCES "chip_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_stock_counts" ADD CONSTRAINT "chip_stock_counts_chipSetId_containerId_fkey" FOREIGN KEY ("chipSetId", "containerId") REFERENCES "chip_containers"("chipSetId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_stock_counts" ADD CONSTRAINT "chip_stock_counts_countedById_fkey" FOREIGN KEY ("countedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_stock_counts" ADD CONSTRAINT "chip_stock_counts_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_stock_counts" ADD CONSTRAINT "chip_stock_counts_reconciledById_fkey" FOREIGN KEY ("reconciledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_stock_count_details" ADD CONSTRAINT "chip_stock_count_details_stockCountId_chipSetId_fkey" FOREIGN KEY ("stockCountId", "chipSetId") REFERENCES "chip_stock_counts"("id", "chipSetId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_stock_count_details" ADD CONSTRAINT "chip_stock_count_details_chipSetId_denominationId_fkey" FOREIGN KEY ("chipSetId", "denominationId") REFERENCES "chip_denominations"("chipSetId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_reservations" ADD CONSTRAINT "chip_reservations_chipSetId_fkey" FOREIGN KEY ("chipSetId") REFERENCES "chip_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_reservations" ADD CONSTRAINT "chip_reservations_chipSetId_containerId_fkey" FOREIGN KEY ("chipSetId", "containerId") REFERENCES "chip_containers"("chipSetId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_reservations" ADD CONSTRAINT "chip_reservations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_reservation_items" ADD CONSTRAINT "chip_reservation_items_reservationId_chipSetId_fkey" FOREIGN KEY ("reservationId", "chipSetId") REFERENCES "chip_reservations"("id", "chipSetId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_reservation_items" ADD CONSTRAINT "chip_reservation_items_chipSetId_denominationId_fkey" FOREIGN KEY ("chipSetId", "denominationId") REFERENCES "chip_denominations"("chipSetId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Integridad que Prisma no expresa ───────────────────────────────────

-- Existencias: nunca negativas; lo reservado está dentro de la custodia.
ALTER TABLE "chip_inventory_balances" ADD CONSTRAINT "chip_balances_quantity_non_negative" CHECK ("quantity" >= 0);
ALTER TABLE "chip_inventory_balances" ADD CONSTRAINT "chip_balances_reserved_valid"
  CHECK ("reserved" >= 0 AND "reserved" <= "quantity" AND ("location" = 'CUSTODY' OR "reserved" = 0));

-- Movimientos: cantidad positiva, origen ≠ destino, al menos uno definido.
ALTER TABLE "chip_inventory_movements" ADD CONSTRAINT "chip_movements_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "chip_inventory_movements" ADD CONSTRAINT "chip_movements_locations_valid"
  CHECK (("fromLocation" IS NOT NULL OR "toLocation" IS NOT NULL)
         AND ("fromLocation" IS NULL OR "toLocation" IS NULL OR "fromLocation" <> "toLocation"));
ALTER TABLE "chip_inventory_movements" ADD CONSTRAINT "chip_movements_custody_non_negative"
  CHECK ("custodyBefore" >= 0 AND "custodyAfter" >= 0);

-- Arqueos y reservas: cantidades enteras no negativas / positivas.
ALTER TABLE "chip_stock_count_details" ADD CONSTRAINT "chip_count_details_quantities_valid"
  CHECK ("expectedQuantity" >= 0 AND ("countedQuantity" IS NULL OR "countedQuantity" >= 0));
ALTER TABLE "chip_reservation_items" ADD CONSTRAINT "chip_reservation_items_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "chip_set_inventory_states" ADD CONSTRAINT "chip_set_states_version_non_negative" CHECK ("version" >= 0);

-- CON-08: un solo contenedor principal activo por juego.
CREATE UNIQUE INDEX "chip_containers_one_active_primary" ON "chip_containers" ("chipSetId") WHERE "isPrimary" AND "isActive";

-- Un solo arqueo en borrador por juego, y un solo inventario inicial confirmado (INI-07).
CREATE UNIQUE INDEX "chip_counts_one_draft_per_set" ON "chip_stock_counts" ("chipSetId") WHERE "status" = 'DRAFT';
CREATE UNIQUE INDEX "chip_counts_one_initial_per_set" ON "chip_stock_counts" ("chipSetId") WHERE "countType" = 'INITIAL' AND "status" = 'CONFIRMED';

-- RES-03: una sola reserva activa por operación de origen.
CREATE UNIQUE INDEX "chip_reservations_one_active_per_reference" ON "chip_reservations" ("referenceType", "referenceId") WHERE "status" = 'ACTIVE';

-- ── Inmutabilidad (MOV-04/05, ARQ-11/20) ───────────────────────────────

CREATE FUNCTION "chip_ledger_prevent_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% es de solo inserción (%)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "chip_inventory_operations_immutable"
  BEFORE UPDATE OR DELETE ON "chip_inventory_operations"
  FOR EACH ROW EXECUTE FUNCTION "chip_ledger_prevent_mutation"();

CREATE TRIGGER "chip_inventory_movements_immutable"
  BEFORE UPDATE OR DELETE ON "chip_inventory_movements"
  FOR EACH ROW EXECUTE FUNCTION "chip_ledger_prevent_mutation"();

-- Arqueos: nunca se borran; tras salir de DRAFT solo cambia la conciliación.
CREATE FUNCTION "chip_counts_guard"() RETURNS trigger AS $$
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
    OR (OLD."reconciliationStatus" = 'RECONCILED'
        AND NEW."reconciliationStatus" IS DISTINCT FROM OLD."reconciliationStatus")
  ) THEN
    RAISE EXCEPTION 'Un arqueo confirmado o cancelado es inmutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "chip_stock_counts_guard"
  BEFORE UPDATE OR DELETE ON "chip_stock_counts"
  FOR EACH ROW EXECUTE FUNCTION "chip_counts_guard"();

-- Detalle de arqueo: editable solo mientras el arqueo está en DRAFT.
CREATE FUNCTION "chip_count_details_guard"() RETURNS trigger AS $$
DECLARE parent_status "ChipCountStatus";
BEGIN
  SELECT "status" INTO parent_status FROM "chip_stock_counts" WHERE "id" = OLD."stockCountId";
  IF parent_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'El detalle de un arqueo confirmado o cancelado es inmutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "chip_stock_count_details_guard"
  BEFORE UPDATE OR DELETE ON "chip_stock_count_details"
  FOR EACH ROW EXECUTE FUNCTION "chip_count_details_guard"();

-- Reservas: nunca se borran (sus cambios de estado los controla el servicio).
CREATE FUNCTION "chip_reservations_no_delete"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% no admite DELETE', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "chip_reservations_no_delete" BEFORE DELETE ON "chip_reservations"
  FOR EACH ROW EXECUTE FUNCTION "chip_reservations_no_delete"();
CREATE TRIGGER "chip_reservation_items_immutable" BEFORE UPDATE OR DELETE ON "chip_reservation_items"
  FOR EACH ROW EXECUTE FUNCTION "chip_ledger_prevent_mutation"();
