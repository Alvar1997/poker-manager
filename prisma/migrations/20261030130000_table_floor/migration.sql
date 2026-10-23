-- Mesa interactiva (rediseño operativo): asientos 1..9 por ciclo de mesa,
-- dealers como personas (sin cuenta de acceso) con asignación por ciclo y
-- color de paño por mesa. Aditiva: no modifica saldos, movimientos,
-- compras, liquidaciones, firmas, comprobantes ni sesiones cerradas.
-- CreateEnum
CREATE TYPE "TableFeltColor" AS ENUM ('CASINO_GREEN', 'NAVY', 'WINE', 'BLACK', 'GRAPHITE', 'PURPLE');

-- CreateEnum
CREATE TYPE "SeatReleaseReason" AS ENUM ('SEAT_CHANGE', 'TRANSFER', 'SETTLEMENT', 'WITHDRAWAL');

-- CreateEnum
CREATE TYPE "DealerReleaseReason" AS ENUM ('CHANGED', 'RELEASED', 'CYCLE_CLOSED');

-- AlterTable
ALTER TABLE "poker_tables" ADD COLUMN     "feltColor" "TableFeltColor" NOT NULL DEFAULT 'CASINO_GREEN';

-- CreateTable
CREATE TABLE "table_seat_assignments" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sessionTableId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "participationId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "seatNumber" INTEGER NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedById" TEXT NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "releasedById" TEXT,
    "releaseReason" "SeatReleaseReason",
    "previousAssignmentId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "table_seat_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dealers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nickname" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dealers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dealer_assignments" (
    "id" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sessionTableId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedById" TEXT NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "releasedById" TEXT,
    "releaseReason" "DealerReleaseReason",
    "idempotencyKey" TEXT NOT NULL,
    "releaseIdempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dealer_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "table_seat_assignments_previousAssignmentId_key" ON "table_seat_assignments"("previousAssignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "table_seat_assignments_idempotencyKey_key" ON "table_seat_assignments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "table_seat_assignments_cycleId_releasedAt_idx" ON "table_seat_assignments"("cycleId", "releasedAt");

-- CreateIndex
CREATE INDEX "table_seat_assignments_participationId_idx" ON "table_seat_assignments"("participationId");

-- CreateIndex
CREATE INDEX "table_seat_assignments_sessionId_assignedAt_idx" ON "table_seat_assignments"("sessionId", "assignedAt");

-- CreateIndex
CREATE INDEX "dealers_isActive_name_idx" ON "dealers"("isActive", "name");

-- CreateIndex
CREATE UNIQUE INDEX "dealer_assignments_idempotencyKey_key" ON "dealer_assignments"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "dealer_assignments_releaseIdempotencyKey_key" ON "dealer_assignments"("releaseIdempotencyKey");

-- CreateIndex
CREATE INDEX "dealer_assignments_cycleId_releasedAt_idx" ON "dealer_assignments"("cycleId", "releasedAt");

-- CreateIndex
CREATE INDEX "dealer_assignments_dealerId_assignedAt_idx" ON "dealer_assignments"("dealerId", "assignedAt");

-- CreateIndex
CREATE INDEX "dealer_assignments_sessionId_idx" ON "dealer_assignments"("sessionId");

-- AddForeignKey
ALTER TABLE "table_seat_assignments" ADD CONSTRAINT "table_seat_assignments_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "poker_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_seat_assignments" ADD CONSTRAINT "table_seat_assignments_sessionTableId_fkey" FOREIGN KEY ("sessionTableId") REFERENCES "session_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_seat_assignments" ADD CONSTRAINT "table_seat_assignments_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "session_table_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_seat_assignments" ADD CONSTRAINT "table_seat_assignments_participationId_fkey" FOREIGN KEY ("participationId") REFERENCES "table_participations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_seat_assignments" ADD CONSTRAINT "table_seat_assignments_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_seat_assignments" ADD CONSTRAINT "table_seat_assignments_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_seat_assignments" ADD CONSTRAINT "table_seat_assignments_releasedById_fkey" FOREIGN KEY ("releasedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_seat_assignments" ADD CONSTRAINT "table_seat_assignments_previousAssignmentId_fkey" FOREIGN KEY ("previousAssignmentId") REFERENCES "table_seat_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dealers" ADD CONSTRAINT "dealers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dealers" ADD CONSTRAINT "dealers_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dealer_assignments" ADD CONSTRAINT "dealer_assignments_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "dealers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dealer_assignments" ADD CONSTRAINT "dealer_assignments_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "poker_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dealer_assignments" ADD CONSTRAINT "dealer_assignments_sessionTableId_fkey" FOREIGN KEY ("sessionTableId") REFERENCES "session_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dealer_assignments" ADD CONSTRAINT "dealer_assignments_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "session_table_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dealer_assignments" ADD CONSTRAINT "dealer_assignments_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dealer_assignments" ADD CONSTRAINT "dealer_assignments_releasedById_fkey" FOREIGN KEY ("releasedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Garantías de asientos ────────────────────────────────────────────────
ALTER TABLE "table_seat_assignments" ADD CONSTRAINT "table_seat_assignments_seat_range"
  CHECK ("seatNumber" BETWEEN 1 AND 9);
ALTER TABLE "table_seat_assignments" ADD CONSTRAINT "table_seat_assignments_release_valid"
  CHECK (("releasedAt" IS NULL AND "releasedById" IS NULL AND "releaseReason" IS NULL)
      OR ("releasedAt" IS NOT NULL AND "releasedById" IS NOT NULL AND "releaseReason" IS NOT NULL));

-- Un ocupante vigente por asiento del ciclo y un asiento vigente por participación.
CREATE UNIQUE INDEX "table_seat_assignments_one_open_per_seat"
  ON "table_seat_assignments" ("cycleId", "seatNumber") WHERE "releasedAt" IS NULL;
CREATE UNIQUE INDEX "table_seat_assignments_one_open_per_participation"
  ON "table_seat_assignments" ("participationId") WHERE "releasedAt" IS NULL;

-- Solo una participación ACTIVE del mismo ciclo, mesa, sesión y jugador, en
-- un ciclo OPEN, puede ocupar un asiento.
CREATE FUNCTION "table_seat_assignments_insert_guard"() RETURNS trigger AS $$
DECLARE p RECORD;
BEGIN
  SELECT tp."status", tp."sessionId", tp."sessionTableId", tp."cycleId", tp."playerId", c."status" AS "cycleStatus"
    INTO p
    FROM "table_participations" tp JOIN "session_table_cycles" c ON c."id" = tp."cycleId"
   WHERE tp."id" = NEW."participationId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Participación inexistente';
  END IF;
  IF p."status" <> 'ACTIVE' OR p."cycleStatus" <> 'OPEN' THEN
    RAISE EXCEPTION 'Solo un jugador activo en un ciclo abierto ocupa un asiento';
  END IF;
  IF p."sessionId" <> NEW."sessionId" OR p."sessionTableId" <> NEW."sessionTableId"
     OR p."cycleId" <> NEW."cycleId" OR p."playerId" <> NEW."playerId" THEN
    RAISE EXCEPTION 'El asiento no corresponde a la participación';
  END IF;
  IF NEW."releasedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Un asiento nace ocupado';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "table_seat_assignments_insert_guard" BEFORE INSERT ON "table_seat_assignments"
  FOR EACH ROW EXECUTE FUNCTION "table_seat_assignments_insert_guard"();

-- Historial inmutable: solo se registra la liberación (una vez).
CREATE FUNCTION "table_seat_assignments_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'table_seat_assignments no admite DELETE (historial)';
  END IF;
  IF OLD."releasedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Un asiento liberado es inmutable';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['releasedAt', 'releasedById', 'releaseReason'])
     <> (to_jsonb(OLD) - ARRAY['releasedAt', 'releasedById', 'releaseReason']) THEN
    RAISE EXCEPTION 'Solo se registra la liberación del asiento';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "table_seat_assignments_guard" BEFORE UPDATE OR DELETE ON "table_seat_assignments"
  FOR EACH ROW EXECUTE FUNCTION "table_seat_assignments_guard"();

-- Una participación no deja de estar ACTIVE con un asiento ocupado: el
-- servicio libera el asiento (con su motivo) en la misma transacción.
CREATE FUNCTION "table_participations_seat_released"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'ACTIVE' AND NEW."status" <> 'ACTIVE' AND EXISTS (
    SELECT 1 FROM "table_seat_assignments" s
     WHERE s."participationId" = NEW."id" AND s."releasedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'La participación sale de la mesa con su asiento ocupado: libéralo primero';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "table_participations_seat_released" AFTER UPDATE ON "table_participations"
  FOR EACH ROW EXECUTE FUNCTION "table_participations_seat_released"();

-- Retiro sin compra: solo si el jugador NUNCA recibió fichas en su cadena de
-- participaciones (origen por transferencia incluido), sin compras en
-- preparación y sin liquidación en curso.
CREATE FUNCTION "table_participations_withdrawal_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'WITHDRAWN' AND OLD."status" IS DISTINCT FROM 'WITHDRAWN' THEN
    IF OLD."status" <> 'ACTIVE' OR NEW."exitReason" IS DISTINCT FROM 'WITHDRAWAL' OR NEW."settlementId" IS NOT NULL THEN
      RAISE EXCEPTION 'Solo una participación activa se retira sin compra';
    END IF;
    IF EXISTS (
      WITH RECURSIVE chain("id", "src") AS (
        SELECT tp."id", tp."sourceParticipationId" FROM "table_participations" tp WHERE tp."id" = NEW."id"
        UNION ALL
        SELECT tp."id", tp."sourceParticipationId" FROM "table_participations" tp JOIN chain ON tp."id" = chain."src"
      )
      SELECT 1 FROM "chip_purchases" cp
       WHERE cp."participationId" IN (SELECT "id" FROM chain)
         AND (cp."status" = 'CONFIRMED'
              OR (cp."participationId" = NEW."id" AND cp."status" IN ('DRAFT', 'READY_FOR_DELIVERY')))
    ) THEN
      RAISE EXCEPTION 'El jugador recibió fichas o tiene una compra en preparación: debe liquidarse';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "player_settlements" s
       WHERE s."participationId" = NEW."id" AND s."status" IN ('DRAFT', 'READY_FOR_CONFIRMATION')
    ) THEN
      RAISE EXCEPTION 'El jugador tiene una liquidación en curso';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "table_participations_withdrawal_guard" BEFORE UPDATE ON "table_participations"
  FOR EACH ROW EXECUTE FUNCTION "table_participations_withdrawal_guard"();

-- ── Garantías de dealers ─────────────────────────────────────────────────
ALTER TABLE "dealers" ADD CONSTRAINT "dealers_name_valid" CHECK (length(btrim("name")) >= 2);

CREATE FUNCTION "dealers_no_delete"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'dealers no admite DELETE (se desactiva)';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "dealers_no_delete" BEFORE DELETE ON "dealers"
  FOR EACH ROW EXECUTE FUNCTION "dealers_no_delete"();

ALTER TABLE "dealer_assignments" ADD CONSTRAINT "dealer_assignments_release_valid"
  CHECK (("releasedAt" IS NULL AND "releasedById" IS NULL AND "releaseReason" IS NULL)
      OR ("releasedAt" IS NOT NULL AND "releasedById" IS NOT NULL AND "releaseReason" IS NOT NULL));

-- Un dealer vigente por ciclo de mesa y una mesa vigente por dealer.
CREATE UNIQUE INDEX "dealer_assignments_one_open_per_cycle"
  ON "dealer_assignments" ("cycleId") WHERE "releasedAt" IS NULL;
CREATE UNIQUE INDEX "dealer_assignments_one_open_per_dealer"
  ON "dealer_assignments" ("dealerId") WHERE "releasedAt" IS NULL;

CREATE FUNCTION "dealer_assignments_insert_guard"() RETURNS trigger AS $$
DECLARE c RECORD;
BEGIN
  SELECT cy."status", st."sessionId", cy."sessionTableId" INTO c
    FROM "session_table_cycles" cy JOIN "session_tables" st ON st."id" = cy."sessionTableId"
   WHERE cy."id" = NEW."cycleId";
  IF NOT FOUND OR c."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'Solo se asigna dealer a un ciclo de mesa abierto';
  END IF;
  IF c."sessionId" <> NEW."sessionId" OR c."sessionTableId" <> NEW."sessionTableId" THEN
    RAISE EXCEPTION 'La asignación no corresponde al ciclo';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "dealers" d WHERE d."id" = NEW."dealerId" AND d."isActive") THEN
    RAISE EXCEPTION 'El dealer no está activo';
  END IF;
  IF NEW."releasedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Una asignación nace vigente';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "dealer_assignments_insert_guard" BEFORE INSERT ON "dealer_assignments"
  FOR EACH ROW EXECUTE FUNCTION "dealer_assignments_insert_guard"();

CREATE FUNCTION "dealer_assignments_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'dealer_assignments no admite DELETE (historial)';
  END IF;
  IF OLD."releasedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Una asignación liberada es inmutable';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['releasedAt', 'releasedById', 'releaseReason', 'releaseIdempotencyKey'])
     <> (to_jsonb(OLD) - ARRAY['releasedAt', 'releasedById', 'releaseReason', 'releaseIdempotencyKey']) THEN
    RAISE EXCEPTION 'Solo se registra la liberación de la asignación';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "dealer_assignments_guard" BEFORE UPDATE OR DELETE ON "dealer_assignments"
  FOR EACH ROW EXECUTE FUNCTION "dealer_assignments_guard"();

-- Un dealer asignado no se desactiva (primero se libera).
CREATE FUNCTION "dealers_deactivation_guard"() RETURNS trigger AS $$
BEGIN
  IF OLD."isActive" AND NOT NEW."isActive" AND EXISTS (
    SELECT 1 FROM "dealer_assignments" a WHERE a."dealerId" = NEW."id" AND a."releasedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'El dealer está asignado a una mesa: libéralo antes de desactivarlo';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "dealers_deactivation_guard" BEFORE UPDATE ON "dealers"
  FOR EACH ROW EXECUTE FUNCTION "dealers_deactivation_guard"();

-- ── Ciclo de mesa ────────────────────────────────────────────────────────
-- Un ciclo no se cierra con asientos ocupados ni con dealer vigente: el
-- servicio de cierre de mesa libera al dealer en la misma transacción.
CREATE FUNCTION "session_table_cycles_floor_released"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'OPEN' AND NEW."status" = 'CLOSED' THEN
    IF EXISTS (SELECT 1 FROM "table_seat_assignments" s WHERE s."cycleId" = NEW."id" AND s."releasedAt" IS NULL) THEN
      RAISE EXCEPTION 'El ciclo tiene asientos ocupados';
    END IF;
    IF EXISTS (SELECT 1 FROM "dealer_assignments" a WHERE a."cycleId" = NEW."id" AND a."releasedAt" IS NULL) THEN
      RAISE EXCEPTION 'El ciclo tiene un dealer asignado';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "session_table_cycles_floor_released" AFTER UPDATE ON "session_table_cycles"
  FOR EACH ROW EXECUTE FUNCTION "session_table_cycles_floor_released"();
