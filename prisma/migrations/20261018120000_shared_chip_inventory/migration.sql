-- Corrección arquitectónica: UN inventario físico de fichas compartido por
-- ambas mesas (antes: un juego físico por mesa). Migración NO destructiva:
--  * no borra filas (los juegos y maletines anteriores se DESACTIVAN y sus
--    denominaciones se conservan como historial);
--  * no suma ni fusiona existencias: si los juegos anteriores tuvieran
--    inventario real, la migración se DETIENE para conciliarlo físicamente;
--  * agrega trazabilidad de mesa/sesión/jugador a operaciones, movimientos
--    y reservas de fichas (columnas opcionales).

-- ── 1. Guarda: nada de existencias reales ambiguas ─────────────────────
DO $$
DECLARE activity INT;
BEGIN
  SELECT
    (SELECT COUNT(*) FROM "chip_inventory_operations" o JOIN "chip_sets" s ON s."id" = o."chipSetId" WHERE s."code" <> 'CHIPSET_MAIN')
  + (SELECT COUNT(*) FROM "chip_stock_counts" c JOIN "chip_sets" s ON s."id" = c."chipSetId" WHERE s."code" <> 'CHIPSET_MAIN')
  + (SELECT COUNT(*) FROM "chip_reservations" r JOIN "chip_sets" s ON s."id" = r."chipSetId" WHERE s."code" <> 'CHIPSET_MAIN')
  + (SELECT COUNT(*) FROM "chip_inventory_balances" b JOIN "chip_sets" s ON s."id" = b."chipSetId"
       WHERE s."code" <> 'CHIPSET_MAIN' AND (b."quantity" <> 0 OR b."reserved" <> 0))
  INTO activity;
  IF activity > 0 THEN
    RAISE EXCEPTION 'Los juegos de fichas por mesa tienen inventario registrado (% registros). No se fusionan automáticamente: concilia físicamente el inventario antes de consolidarlo (ver docs/MODULE_04_CHIP_INVENTORY.md).', activity;
  END IF;
END $$;

-- ── 2. Trazabilidad de mesa, sesión y jugador ──────────────────────────
-- AlterTable
ALTER TABLE "chip_inventory_movements" ADD COLUMN     "playerId" TEXT,
ADD COLUMN     "sessionId" TEXT,
ADD COLUMN     "tableId" TEXT;

-- AlterTable
ALTER TABLE "chip_inventory_operations" ADD COLUMN     "playerId" TEXT,
ADD COLUMN     "sessionId" TEXT,
ADD COLUMN     "tableId" TEXT;

-- AlterTable
ALTER TABLE "chip_reservations" ADD COLUMN     "playerId" TEXT,
ADD COLUMN     "sessionId" TEXT,
ADD COLUMN     "tableId" TEXT;

-- CreateIndex
CREATE INDEX "chip_inventory_movements_tableId_createdAt_idx" ON "chip_inventory_movements"("tableId", "createdAt");

-- CreateIndex
CREATE INDEX "chip_inventory_operations_tableId_createdAt_idx" ON "chip_inventory_operations"("tableId", "createdAt");

-- CreateIndex
CREATE INDEX "chip_inventory_operations_sessionId_idx" ON "chip_inventory_operations"("sessionId");

-- AddForeignKey
ALTER TABLE "chip_inventory_operations" ADD CONSTRAINT "chip_inventory_operations_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "poker_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_inventory_operations" ADD CONSTRAINT "chip_inventory_operations_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_inventory_movements" ADD CONSTRAINT "chip_inventory_movements_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "poker_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_inventory_movements" ADD CONSTRAINT "chip_inventory_movements_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_reservations" ADD CONSTRAINT "chip_reservations_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "poker_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_reservations" ADD CONSTRAINT "chip_reservations_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── 3. Historial de la consolidación (antes de cambiar nada) ────────────
INSERT INTO "audit_logs" ("id", "actorUserId", "action", "entityType", "entityId", "result", "metadata", "createdAt")
SELECT 'mig_shared_chip_inventory', NULL, 'CHIP_INVENTORY_CONSOLIDATED', 'ChipSet', NULL, 'SUCCESS',
  jsonb_build_object(
    'migration', '20261018120000_shared_chip_inventory',
    'reason', 'Un inventario físico compartido por ambas mesas',
    'deactivatedChipSets', (SELECT COALESCE(jsonb_agg(jsonb_build_object('code', s."code", 'name', s."name") ORDER BY s."code"), '[]'::jsonb)
                            FROM "chip_sets" s WHERE s."code" <> 'CHIPSET_MAIN' AND s."isActive"),
    'previousDenominations', (SELECT COALESCE(jsonb_agg(jsonb_build_object('chipSet', s."code", 'value', d."value", 'color', d."color", 'name', d."name") ORDER BY s."code", d."value"), '[]'::jsonb)
                              FROM "chip_denominations" d JOIN "chip_sets" s ON s."id" = d."chipSetId" WHERE s."code" <> 'CHIPSET_MAIN'),
    'note', 'Las denominaciones anteriores NO se copiaron al inventario común: deben capturarse a partir del conteo físico real.'
  ),
  NOW()
WHERE EXISTS (SELECT 1 FROM "chip_sets" WHERE "code" <> 'CHIPSET_MAIN');

-- ── 4. Desactivar (no borrar) los juegos y maletines por mesa ──────────
UPDATE "chip_denominations" d SET "isActive" = false, "updatedAt" = NOW()
FROM "chip_sets" s WHERE s."id" = d."chipSetId" AND s."code" <> 'CHIPSET_MAIN' AND d."isActive";
UPDATE "chip_containers" c SET "isActive" = false, "updatedAt" = NOW()
FROM "chip_sets" s WHERE s."id" = c."chipSetId" AND s."code" <> 'CHIPSET_MAIN' AND c."isActive";
UPDATE "chip_sets" SET "isActive" = false, "updatedAt" = NOW()
WHERE "code" <> 'CHIPSET_MAIN' AND "isActive";

-- ── 5. Inventario general único y su ubicación física ──────────────────
INSERT INTO "chip_sets" ("id", "code", "name", "description", "isActive", "createdAt", "updatedAt")
VALUES ('chipset_main', 'CHIPSET_MAIN', 'Inventario General de Fichas',
        'Inventario físico único compartido por todas las mesas.', true, NOW(), NOW())
ON CONFLICT ("code") DO UPDATE SET "isActive" = true, "updatedAt" = NOW();

INSERT INTO "chip_containers" ("id", "code", "name", "chipSetId", "description", "isPrimary", "isActive", "createdAt", "updatedAt")
SELECT 'container_main', 'INVENTARIO-GENERAL', 'Inventario general', s."id",
       'Ubicación física única del inventario compartido (no hay maletines por mesa).', true, true, NOW(), NOW()
FROM "chip_sets" s WHERE s."code" = 'CHIPSET_MAIN'
ON CONFLICT ("code") DO NOTHING;

-- ── 6. Ambas mesas usan el mismo inventario ────────────────────────────
UPDATE "poker_tables" t SET "defaultChipSetId" = s."id", "updatedAt" = NOW()
FROM "chip_sets" s WHERE s."code" = 'CHIPSET_MAIN' AND t."defaultChipSetId" <> s."id";

-- ── 7. Nunca dos inventarios activos de operación ──────────────────────
CREATE UNIQUE INDEX "chip_sets_single_active" ON "chip_sets" ((true)) WHERE "isActive";
