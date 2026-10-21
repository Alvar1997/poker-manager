-- Módulo 07: mesas dentro de la sesión, ciclos, participación y
-- transferencias. Aditiva: no crea mesas, ciclos ni participaciones.

-- CreateEnum
CREATE TYPE "SessionTableStatus" AS ENUM ('PENDING', 'OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "TableCycleStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "ParticipationStatus" AS ENUM ('ACTIVE', 'TRANSFERRED', 'SETTLED');

-- CreateTable
CREATE TABLE "session_tables" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "status" "SessionTableStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_table_cycles" (
    "id" TEXT NOT NULL,
    "sessionTableId" TEXT NOT NULL,
    "cycleNumber" INTEGER NOT NULL,
    "status" "TableCycleStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedById" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closingNotes" TEXT,
    "smallBlindSnapshot" DECIMAL(12,2) NOT NULL,
    "bigBlindSnapshot" DECIMAL(12,2) NOT NULL,
    "openIdempotencyKey" TEXT NOT NULL,
    "closeIdempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_table_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "table_participations" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sessionTableId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "status" "ParticipationStatus" NOT NULL DEFAULT 'ACTIVE',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joinedById" TEXT NOT NULL,
    "leftAt" TIMESTAMP(3),
    "leftById" TEXT,
    "exitReason" TEXT,
    "sourceParticipationId" TEXT,
    "settlementId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "table_participations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "table_transfers" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "sourceParticipationId" TEXT NOT NULL,
    "destinationParticipationId" TEXT NOT NULL,
    "sourceSessionTableId" TEXT NOT NULL,
    "destinationSessionTableId" TEXT NOT NULL,
    "transferredById" TEXT NOT NULL,
    "transferredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "table_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "session_tables_sessionId_status_idx" ON "session_tables"("sessionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "session_tables_sessionId_tableId_key" ON "session_tables"("sessionId", "tableId");

-- CreateIndex
CREATE UNIQUE INDEX "session_tables_id_sessionId_key" ON "session_tables"("id", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "session_table_cycles_openIdempotencyKey_key" ON "session_table_cycles"("openIdempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "session_table_cycles_closeIdempotencyKey_key" ON "session_table_cycles"("closeIdempotencyKey");

-- CreateIndex
CREATE INDEX "session_table_cycles_sessionTableId_status_idx" ON "session_table_cycles"("sessionTableId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "session_table_cycles_sessionTableId_cycleNumber_key" ON "session_table_cycles"("sessionTableId", "cycleNumber");

-- CreateIndex
CREATE UNIQUE INDEX "session_table_cycles_id_sessionTableId_key" ON "session_table_cycles"("id", "sessionTableId");

-- CreateIndex
CREATE UNIQUE INDEX "table_participations_sourceParticipationId_key" ON "table_participations"("sourceParticipationId");

-- CreateIndex
CREATE UNIQUE INDEX "table_participations_settlementId_key" ON "table_participations"("settlementId");

-- CreateIndex
CREATE UNIQUE INDEX "table_participations_idempotencyKey_key" ON "table_participations"("idempotencyKey");

-- CreateIndex
CREATE INDEX "table_participations_sessionId_status_idx" ON "table_participations"("sessionId", "status");

-- CreateIndex
CREATE INDEX "table_participations_sessionTableId_status_idx" ON "table_participations"("sessionTableId", "status");

-- CreateIndex
CREATE INDEX "table_participations_playerId_idx" ON "table_participations"("playerId");

-- CreateIndex
CREATE INDEX "table_participations_joinedAt_idx" ON "table_participations"("joinedAt");

-- CreateIndex
CREATE INDEX "table_participations_cycleId_idx" ON "table_participations"("cycleId");

-- CreateIndex
CREATE UNIQUE INDEX "table_participations_id_sessionId_key" ON "table_participations"("id", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "table_transfers_sourceParticipationId_key" ON "table_transfers"("sourceParticipationId");

-- CreateIndex
CREATE UNIQUE INDEX "table_transfers_destinationParticipationId_key" ON "table_transfers"("destinationParticipationId");

-- CreateIndex
CREATE UNIQUE INDEX "table_transfers_idempotencyKey_key" ON "table_transfers"("idempotencyKey");

-- CreateIndex
CREATE INDEX "table_transfers_sessionId_transferredAt_idx" ON "table_transfers"("sessionId", "transferredAt");

-- CreateIndex
CREATE INDEX "table_transfers_playerId_idx" ON "table_transfers"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "table_transfers_sourceParticipationId_sessionId_key" ON "table_transfers"("sourceParticipationId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "table_transfers_destinationParticipationId_sessionId_key" ON "table_transfers"("destinationParticipationId", "sessionId");

-- AddForeignKey
ALTER TABLE "session_tables" ADD CONSTRAINT "session_tables_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "poker_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_tables" ADD CONSTRAINT "session_tables_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "poker_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_table_cycles" ADD CONSTRAINT "session_table_cycles_sessionTableId_fkey" FOREIGN KEY ("sessionTableId") REFERENCES "session_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_table_cycles" ADD CONSTRAINT "session_table_cycles_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_table_cycles" ADD CONSTRAINT "session_table_cycles_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_participations" ADD CONSTRAINT "table_participations_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "poker_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_participations" ADD CONSTRAINT "table_participations_sessionTableId_sessionId_fkey" FOREIGN KEY ("sessionTableId", "sessionId") REFERENCES "session_tables"("id", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_participations" ADD CONSTRAINT "table_participations_cycleId_sessionTableId_fkey" FOREIGN KEY ("cycleId", "sessionTableId") REFERENCES "session_table_cycles"("id", "sessionTableId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_participations" ADD CONSTRAINT "table_participations_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_participations" ADD CONSTRAINT "table_participations_joinedById_fkey" FOREIGN KEY ("joinedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_participations" ADD CONSTRAINT "table_participations_leftById_fkey" FOREIGN KEY ("leftById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_transfers" ADD CONSTRAINT "table_transfers_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "poker_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_transfers" ADD CONSTRAINT "table_transfers_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_transfers" ADD CONSTRAINT "table_transfers_sourceParticipationId_sessionId_fkey" FOREIGN KEY ("sourceParticipationId", "sessionId") REFERENCES "table_participations"("id", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_transfers" ADD CONSTRAINT "table_transfers_destinationParticipationId_sessionId_fkey" FOREIGN KEY ("destinationParticipationId", "sessionId") REFERENCES "table_participations"("id", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_transfers" ADD CONSTRAINT "table_transfers_sourceSessionTableId_sessionId_fkey" FOREIGN KEY ("sourceSessionTableId", "sessionId") REFERENCES "session_tables"("id", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_transfers" ADD CONSTRAINT "table_transfers_destinationSessionTableId_sessionId_fkey" FOREIGN KEY ("destinationSessionTableId", "sessionId") REFERENCES "session_tables"("id", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_transfers" ADD CONSTRAINT "table_transfers_transferredById_fkey" FOREIGN KEY ("transferredById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Restricciones manuales (Prisma no expresa índices parciales) ───────
-- Un solo ciclo OPEN por mesa de sesión (dos aperturas simultáneas → una).
CREATE UNIQUE INDEX "session_table_cycles_one_open" ON "session_table_cycles" ("sessionTableId")
  WHERE "status" = 'OPEN';
-- Un jugador solo puede estar ACTIVE en UNA mesa por sesión.
CREATE UNIQUE INDEX "table_participations_one_active_per_player" ON "table_participations" ("sessionId", "playerId")
  WHERE "status" = 'ACTIVE';

ALTER TABLE "session_table_cycles" ADD CONSTRAINT "session_table_cycles_valid"
  CHECK ("cycleNumber" >= 1 AND "smallBlindSnapshot" > 0 AND "bigBlindSnapshot" >= "smallBlindSnapshot"
         AND ("status" <> 'CLOSED' OR ("closedAt" IS NOT NULL AND "closedById" IS NOT NULL)));
ALTER TABLE "table_participations" ADD CONSTRAINT "table_participations_valid"
  CHECK (("status" = 'ACTIVE' OR ("leftAt" IS NOT NULL AND "leftById" IS NOT NULL))
         AND ("status" <> 'SETTLED' OR "settlementId" IS NOT NULL));
ALTER TABLE "table_transfers" ADD CONSTRAINT "table_transfers_distinct"
  CHECK ("sourceSessionTableId" <> "destinationSessionTableId"
         AND "sourceParticipationId" <> "destinationParticipationId");

-- ── Historial inmutable ─────────────────────────────────────────────────
CREATE FUNCTION "tables_no_delete"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% no admite DELETE (historial)', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "session_tables_no_delete" BEFORE DELETE ON "session_tables"
  FOR EACH ROW EXECUTE FUNCTION "tables_no_delete"();

-- Ciclos: un ciclo cerrado es inmutable; las fechas reales no se editan.
CREATE FUNCTION "session_table_cycles_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'session_table_cycles no admite DELETE (historial)';
  END IF;
  IF OLD."status" = 'CLOSED' THEN
    RAISE EXCEPTION 'Un ciclo cerrado es inmutable';
  END IF;
  IF NEW."openedAt" IS DISTINCT FROM OLD."openedAt"
     OR NEW."openedById" IS DISTINCT FROM OLD."openedById"
     OR NEW."cycleNumber" IS DISTINCT FROM OLD."cycleNumber"
     OR NEW."sessionTableId" IS DISTINCT FROM OLD."sessionTableId"
     OR NEW."smallBlindSnapshot" IS DISTINCT FROM OLD."smallBlindSnapshot"
     OR NEW."bigBlindSnapshot" IS DISTINCT FROM OLD."bigBlindSnapshot" THEN
    RAISE EXCEPTION 'Los datos de apertura de un ciclo son inmutables';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "session_table_cycles_guard" BEFORE UPDATE OR DELETE ON "session_table_cycles"
  FOR EACH ROW EXECUTE FUNCTION "session_table_cycles_guard"();

-- Participaciones: solo ACTIVE → TRANSFERRED/SETTLED; terminales inmutables.
CREATE FUNCTION "table_participations_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'table_participations no admite DELETE (historial)';
  END IF;
  IF OLD."status" <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Una participación finalizada es inmutable';
  END IF;
  IF NEW."joinedAt" IS DISTINCT FROM OLD."joinedAt"
     OR NEW."joinedById" IS DISTINCT FROM OLD."joinedById"
     OR NEW."playerId" IS DISTINCT FROM OLD."playerId"
     OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId"
     OR NEW."sessionTableId" IS DISTINCT FROM OLD."sessionTableId"
     OR NEW."cycleId" IS DISTINCT FROM OLD."cycleId" THEN
    RAISE EXCEPTION 'Jugador, mesa, ciclo e ingreso de una participación son inmutables';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "table_participations_guard" BEFORE UPDATE OR DELETE ON "table_participations"
  FOR EACH ROW EXECUTE FUNCTION "table_participations_guard"();

CREATE TRIGGER "table_transfers_immutable" BEFORE UPDATE OR DELETE ON "table_transfers"
  FOR EACH ROW EXECUTE FUNCTION "session_append_only"();
