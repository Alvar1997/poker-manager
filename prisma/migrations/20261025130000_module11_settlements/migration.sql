-- Módulo 11 (2/2): liquidaciones de jugadores. Ver docs/MODULE_11_SETTLEMENTS.md.
-- ADITIVA: crea tablas nuevas, agrega FKs a columnas que hasta hoy estaban
-- vacías (`table_participations.settlementId`, `payment_allocations.settlementId`
-- y `stored_files.settlementId`, nueva) y amplía triggers. No transforma datos:
-- no crea liquidaciones, cuentas por pagar ni desembolsos históricos, no
-- mueve compras, no toca deudas ni firmas existentes.

-- CreateEnum
CREATE TYPE "PlayerSettlementStatus" AS ENUM ('DRAFT', 'READY_FOR_CONFIRMATION', 'PENDING_PAYOUT', 'COMPLETED', 'CANCELLED', 'REVERSED');

-- CreateEnum
CREATE TYPE "SettlementOffsetDecision" AS ENUM ('NO_COMPENSATE', 'PARTIAL', 'MAXIMUM');

-- CreateEnum
CREATE TYPE "SettlementSignatureStatus" AS ENUM ('VALID', 'INVALIDATED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SettlementPayableStatus" AS ENUM ('OPEN', 'PARTIALLY_PAID', 'PAID', 'VOIDED');

-- CreateEnum
CREATE TYPE "SettlementPayoutMethod" AS ENUM ('CASH', 'BANK_TRANSFER');

-- CreateEnum
CREATE TYPE "SettlementPayoutStatus" AS ENUM ('PENDING', 'EXECUTED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SettlementPayoutFunding" AS ENUM ('SESSION_CASH', 'ADMIN_CUSTODY', 'BANK');

-- CreateEnum
CREATE TYPE "SettlementReceiptKind" AS ENUM ('RECEPTION', 'PAYOUT');

-- AlterTable
ALTER TABLE "stored_files" ADD COLUMN     "settlementId" TEXT;

-- CreateTable
CREATE TABLE "administrative_cash_contributions" (
    "id" TEXT NOT NULL,
    "custodianUserId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "counterpartyName" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "administrative_cash_contributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_settlements" (
    "id" TEXT NOT NULL,
    "folio" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sessionTableId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "participationId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "returnedNominalAmount" DECIMAL(14,2) NOT NULL,
    "offsetDecision" "SettlementOffsetDecision" NOT NULL,
    "requestedOffsetAmount" DECIMAL(14,2),
    "debtBalanceSnapshot" DECIMAL(14,2),
    "offsetAmount" DECIMAL(14,2),
    "netPayoutAmount" DECIMAL(14,2),
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "PlayerSettlementStatus" NOT NULL DEFAULT 'DRAFT',
    "chipReturnOperationId" TEXT,
    "signatureId" TEXT,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "receivedById" TEXT,
    "receivedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "reversedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL,
    "confirmIdempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "player_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_status_history" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "fromStatus" "PlayerSettlementStatus",
    "toStatus" "PlayerSettlementStatus" NOT NULL,
    "changedById" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,

    CONSTRAINT "settlement_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_signature_snapshots" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "settlementVersion" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "declarationText" TEXT NOT NULL,
    "declarationVersion" TEXT NOT NULL,
    "preparedAt" TIMESTAMP(3) NOT NULL,
    "preparedById" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "materialHash" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,

    CONSTRAINT "settlement_signature_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_signatures" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "imageHash" TEXT NOT NULL,
    "status" "SettlementSignatureStatus" NOT NULL DEFAULT 'VALID',
    "signedAt" TIMESTAMP(3) NOT NULL,
    "capturedById" TEXT NOT NULL,
    "invalidatedAt" TIMESTAMP(3),
    "invalidatedById" TEXT,
    "invalidationReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_signatures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_payables" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "sourceSessionId" TEXT NOT NULL,
    "originalAmount" DECIMAL(14,2) NOT NULL,
    "status" "SettlementPayableStatus" NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),

    CONSTRAINT "settlement_payables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_payouts" (
    "id" TEXT NOT NULL,
    "payableId" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "method" "SettlementPayoutMethod" NOT NULL,
    "funding" "SettlementPayoutFunding" NOT NULL,
    "status" "SettlementPayoutStatus" NOT NULL,
    "sessionId" TEXT,
    "custodianUserId" TEXT,
    "paymentAccountId" TEXT,
    "bankReference" TEXT,
    "financialTransactionId" TEXT,
    "notes" TEXT,
    "failureReason" TEXT,
    "requestedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL,
    "resolveIdempotencyKey" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlement_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_receipts" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "kind" "SettlementReceiptKind" NOT NULL,
    "payoutId" TEXT,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'AVAILABLE',
    "content" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,

    CONSTRAINT "settlement_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_reversals" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "chipOperationId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "settlement_reversals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "administrative_cash_contributions_transactionId_key" ON "administrative_cash_contributions"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "administrative_cash_contributions_idempotencyKey_key" ON "administrative_cash_contributions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "administrative_cash_contributions_custodianUserId_createdAt_idx" ON "administrative_cash_contributions"("custodianUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "player_settlements_folio_key" ON "player_settlements"("folio");

-- CreateIndex
CREATE UNIQUE INDEX "player_settlements_chipReturnOperationId_key" ON "player_settlements"("chipReturnOperationId");

-- CreateIndex
CREATE UNIQUE INDEX "player_settlements_signatureId_key" ON "player_settlements"("signatureId");

-- CreateIndex
CREATE UNIQUE INDEX "player_settlements_idempotencyKey_key" ON "player_settlements"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "player_settlements_confirmIdempotencyKey_key" ON "player_settlements"("confirmIdempotencyKey");

-- CreateIndex
CREATE INDEX "player_settlements_sessionId_createdAt_idx" ON "player_settlements"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "player_settlements_playerId_createdAt_idx" ON "player_settlements"("playerId", "createdAt");

-- CreateIndex
CREATE INDEX "player_settlements_participationId_idx" ON "player_settlements"("participationId");

-- CreateIndex
CREATE INDEX "player_settlements_status_idx" ON "player_settlements"("status");

-- CreateIndex
CREATE INDEX "settlement_status_history_settlementId_changedAt_idx" ON "settlement_status_history"("settlementId", "changedAt");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_signature_snapshots_payloadHash_key" ON "settlement_signature_snapshots"("payloadHash");

-- CreateIndex
CREATE INDEX "settlement_signature_snapshots_settlementId_preparedAt_idx" ON "settlement_signature_snapshots"("settlementId", "preparedAt");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_signature_snapshots_settlementId_contentHash_key" ON "settlement_signature_snapshots"("settlementId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_signatures_snapshotId_key" ON "settlement_signatures"("snapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_signatures_fileId_key" ON "settlement_signatures"("fileId");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_signatures_idempotencyKey_key" ON "settlement_signatures"("idempotencyKey");

-- CreateIndex
CREATE INDEX "settlement_signatures_settlementId_status_idx" ON "settlement_signatures"("settlementId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_payables_settlementId_key" ON "settlement_payables"("settlementId");

-- CreateIndex
CREATE INDEX "settlement_payables_status_createdAt_idx" ON "settlement_payables"("status", "createdAt");

-- CreateIndex
CREATE INDEX "settlement_payables_playerId_idx" ON "settlement_payables"("playerId");

-- CreateIndex
CREATE INDEX "settlement_payables_sourceSessionId_idx" ON "settlement_payables"("sourceSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_payouts_financialTransactionId_key" ON "settlement_payouts"("financialTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_payouts_idempotencyKey_key" ON "settlement_payouts"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_payouts_resolveIdempotencyKey_key" ON "settlement_payouts"("resolveIdempotencyKey");

-- CreateIndex
CREATE INDEX "settlement_payouts_payableId_status_idx" ON "settlement_payouts"("payableId", "status");

-- CreateIndex
CREATE INDEX "settlement_payouts_status_createdAt_idx" ON "settlement_payouts"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_payouts_settlementId_sequence_key" ON "settlement_payouts"("settlementId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_receipts_payoutId_key" ON "settlement_receipts"("payoutId");

-- CreateIndex
CREATE INDEX "settlement_receipts_settlementId_kind_idx" ON "settlement_receipts"("settlementId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_reversals_settlementId_key" ON "settlement_reversals"("settlementId");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_reversals_chipOperationId_key" ON "settlement_reversals"("chipOperationId");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_reversals_idempotencyKey_key" ON "settlement_reversals"("idempotencyKey");

-- CreateIndex
CREATE INDEX "payment_allocations_settlementId_idx" ON "payment_allocations"("settlementId");

-- AddForeignKey
ALTER TABLE "table_participations" ADD CONSTRAINT "table_participations_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "player_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "player_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "player_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "administrative_cash_contributions" ADD CONSTRAINT "administrative_cash_contributions_custodianUserId_fkey" FOREIGN KEY ("custodianUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "administrative_cash_contributions" ADD CONSTRAINT "administrative_cash_contributions_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "cash_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "administrative_cash_contributions" ADD CONSTRAINT "administrative_cash_contributions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_settlements" ADD CONSTRAINT "player_settlements_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "poker_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_settlements" ADD CONSTRAINT "player_settlements_sessionTableId_fkey" FOREIGN KEY ("sessionTableId") REFERENCES "session_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_settlements" ADD CONSTRAINT "player_settlements_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "session_table_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_settlements" ADD CONSTRAINT "player_settlements_participationId_fkey" FOREIGN KEY ("participationId") REFERENCES "table_participations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_settlements" ADD CONSTRAINT "player_settlements_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_settlements" ADD CONSTRAINT "player_settlements_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "poker_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_settlements" ADD CONSTRAINT "player_settlements_signatureId_fkey" FOREIGN KEY ("signatureId") REFERENCES "settlement_signatures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_settlements" ADD CONSTRAINT "player_settlements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_settlements" ADD CONSTRAINT "player_settlements_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_settlements" ADD CONSTRAINT "player_settlements_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_status_history" ADD CONSTRAINT "settlement_status_history_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "player_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_status_history" ADD CONSTRAINT "settlement_status_history_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_signature_snapshots" ADD CONSTRAINT "settlement_signature_snapshots_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "player_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_signature_snapshots" ADD CONSTRAINT "settlement_signature_snapshots_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_signature_snapshots" ADD CONSTRAINT "settlement_signature_snapshots_preparedById_fkey" FOREIGN KEY ("preparedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_signatures" ADD CONSTRAINT "settlement_signatures_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "player_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_signatures" ADD CONSTRAINT "settlement_signatures_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_signatures" ADD CONSTRAINT "settlement_signatures_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "settlement_signature_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_signatures" ADD CONSTRAINT "settlement_signatures_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_signatures" ADD CONSTRAINT "settlement_signatures_capturedById_fkey" FOREIGN KEY ("capturedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_signatures" ADD CONSTRAINT "settlement_signatures_invalidatedById_fkey" FOREIGN KEY ("invalidatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_payables" ADD CONSTRAINT "settlement_payables_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "player_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_payables" ADD CONSTRAINT "settlement_payables_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_payables" ADD CONSTRAINT "settlement_payables_sourceSessionId_fkey" FOREIGN KEY ("sourceSessionId") REFERENCES "poker_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_payables" ADD CONSTRAINT "settlement_payables_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_payouts" ADD CONSTRAINT "settlement_payouts_payableId_fkey" FOREIGN KEY ("payableId") REFERENCES "settlement_payables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_payouts" ADD CONSTRAINT "settlement_payouts_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "player_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_payouts" ADD CONSTRAINT "settlement_payouts_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_payouts" ADD CONSTRAINT "settlement_payouts_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "poker_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_payouts" ADD CONSTRAINT "settlement_payouts_custodianUserId_fkey" FOREIGN KEY ("custodianUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_payouts" ADD CONSTRAINT "settlement_payouts_paymentAccountId_fkey" FOREIGN KEY ("paymentAccountId") REFERENCES "payment_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_payouts" ADD CONSTRAINT "settlement_payouts_financialTransactionId_fkey" FOREIGN KEY ("financialTransactionId") REFERENCES "cash_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_payouts" ADD CONSTRAINT "settlement_payouts_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_payouts" ADD CONSTRAINT "settlement_payouts_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_receipts" ADD CONSTRAINT "settlement_receipts_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "player_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_receipts" ADD CONSTRAINT "settlement_receipts_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "settlement_payouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_receipts" ADD CONSTRAINT "settlement_receipts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_reversals" ADD CONSTRAINT "settlement_reversals_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "player_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_reversals" ADD CONSTRAINT "settlement_reversals_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════════
-- Integridad (última defensa; los servicios validan primero)
-- ═══════════════════════════════════════════════════════════════════════

-- ── Participaciones: SETTLING (fichas recibidas, falta pagar) ───────────
-- No ocupa silla (tiene salida registrada) y siempre apunta a su liquidación.
ALTER TABLE "table_participations" DROP CONSTRAINT "table_participations_valid";
ALTER TABLE "table_participations" ADD CONSTRAINT "table_participations_valid"
  CHECK (("status" = 'ACTIVE' OR ("leftAt" IS NOT NULL AND "leftById" IS NOT NULL))
         AND ("status" NOT IN ('SETTLING', 'SETTLED') OR "settlementId" IS NOT NULL));

-- ACTIVE → TRANSFERRED/SETTLING/SETTLED; SETTLING → SETTLED (solo el estado);
-- TRANSFERRED y SETTLED inmutables.
CREATE OR REPLACE FUNCTION "table_participations_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'table_participations no admite DELETE (historial)';
  END IF;
  IF OLD."status" = 'SETTLING' THEN
    IF NEW."status" <> 'SETTLED'
       OR (to_jsonb(NEW) - ARRAY['status', 'updatedAt']) <> (to_jsonb(OLD) - ARRAY['status', 'updatedAt']) THEN
      RAISE EXCEPTION 'Una participación SETTLING solo pasa a SETTLED (sin cambiar otros datos)';
    END IF;
    RETURN NEW;
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

-- Política de reingreso: un jugador con liquidación pendiente de pago en la
-- sesión no vuelve a quedar ACTIVE hasta terminarla (el servicio además
-- bloquea al jugador para serializar con la confirmación).
CREATE FUNCTION "table_participations_no_reentry_while_settling"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'ACTIVE' AND EXISTS (
    SELECT 1 FROM "table_participations" p
    WHERE p."sessionId" = NEW."sessionId" AND p."playerId" = NEW."playerId" AND p."status" = 'SETTLING'
  ) THEN
    RAISE EXCEPTION 'El jugador tiene una liquidación pendiente de pago en esta sesión';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "table_participations_no_reentry_while_settling" BEFORE INSERT ON "table_participations"
  FOR EACH ROW EXECUTE FUNCTION "table_participations_no_reentry_while_settling"();

-- ── Liquidaciones ────────────────────────────────────────────────────────
-- Una liquidación viva por participación (las canceladas se conservan).
CREATE UNIQUE INDEX "player_settlements_one_live_per_participation"
  ON "player_settlements" ("participationId") WHERE "status" <> 'CANCELLED';

ALTER TABLE "player_settlements" ADD CONSTRAINT "player_settlements_amounts_valid"
  CHECK ("returnedNominalAmount" >= 0 AND "version" >= 1
    AND (("offsetDecision" = 'PARTIAL') = ("requestedOffsetAmount" IS NOT NULL))
    AND ("requestedOffsetAmount" IS NULL OR ("requestedOffsetAmount" > 0 AND "requestedOffsetAmount" <= "returnedNominalAmount"))
    -- Con $0 devueltos no hay nada que compensar.
    AND ("returnedNominalAmount" > 0 OR "offsetDecision" = 'NO_COMPENSATE'));

ALTER TABLE "player_settlements" ADD CONSTRAINT "player_settlements_reception_valid"
  CHECK ((
    ("status" IN ('DRAFT', 'READY_FOR_CONFIRMATION', 'CANCELLED')
      AND "receivedAt" IS NULL AND "offsetAmount" IS NULL AND "netPayoutAmount" IS NULL
      AND "debtBalanceSnapshot" IS NULL AND "chipReturnOperationId" IS NULL AND "signatureId" IS NULL)
    OR
    ("status" IN ('PENDING_PAYOUT', 'COMPLETED', 'REVERSED')
      AND "receivedAt" IS NOT NULL AND "receivedById" IS NOT NULL AND "signatureId" IS NOT NULL
      AND "offsetAmount" IS NOT NULL AND "netPayoutAmount" IS NOT NULL AND "debtBalanceSnapshot" IS NOT NULL
      AND "offsetAmount" >= 0 AND "offsetAmount" <= "returnedNominalAmount"
      AND "offsetAmount" <= "debtBalanceSnapshot"
      AND "netPayoutAmount" = "returnedNominalAmount" - "offsetAmount"
      AND ("offsetDecision" <> 'NO_COMPENSATE' OR "offsetAmount" = 0)
      AND ("offsetDecision" <> 'PARTIAL' OR "offsetAmount" = "requestedOffsetAmount")
      -- Una entrada nominal solo si se devolvió > 0 (nunca un movimiento de $0).
      AND (("returnedNominalAmount" > 0) = ("chipReturnOperationId" IS NOT NULL)))
  AND ("status" <> 'COMPLETED' OR "completedAt" IS NOT NULL)
  AND ("status" <> 'REVERSED' OR "reversedAt" IS NOT NULL)
  AND (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL))
  AND ("status" <> 'CANCELLED' OR ("cancelledById" IS NOT NULL AND "cancellationReason" IS NOT NULL))));

CREATE FUNCTION "player_settlements_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'Una liquidación nace en DRAFT';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'player_settlements no admite DELETE (historial)';
  END IF;
  IF NEW."folio" IS DISTINCT FROM OLD."folio"
     OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId"
     OR NEW."sessionTableId" IS DISTINCT FROM OLD."sessionTableId"
     OR NEW."cycleId" IS DISTINCT FROM OLD."cycleId"
     OR NEW."participationId" IS DISTINCT FROM OLD."participationId"
     OR NEW."playerId" IS DISTINCT FROM OLD."playerId"
     OR NEW."tableId" IS DISTINCT FROM OLD."tableId"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" THEN
    RAISE EXCEPTION 'Folio, jugador, sesión, mesa y participación de una liquidación son inmutables';
  END IF;
  IF OLD."status" IN ('CANCELLED', 'REVERSED') THEN
    RAISE EXCEPTION 'Una liquidación cancelada o revertida es inmutable';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'DRAFT' AND NEW."status" IN ('READY_FOR_CONFIRMATION', 'CANCELLED'))
    OR (OLD."status" = 'READY_FOR_CONFIRMATION' AND NEW."status" IN ('DRAFT', 'PENDING_PAYOUT', 'COMPLETED', 'CANCELLED'))
    OR (OLD."status" = 'PENDING_PAYOUT' AND NEW."status" IN ('COMPLETED', 'REVERSED'))
    OR (OLD."status" = 'COMPLETED' AND NEW."status" = 'REVERSED')
  ) THEN
    RAISE EXCEPTION 'Transición de liquidación no permitida: % → %', OLD."status", NEW."status";
  END IF;
  -- Recepción confirmada: lo acordado y firmado ya no se edita.
  IF OLD."status" IN ('PENDING_PAYOUT', 'COMPLETED') AND (
       NEW."returnedNominalAmount" IS DISTINCT FROM OLD."returnedNominalAmount"
    OR NEW."offsetDecision" IS DISTINCT FROM OLD."offsetDecision"
    OR NEW."requestedOffsetAmount" IS DISTINCT FROM OLD."requestedOffsetAmount"
    OR NEW."offsetAmount" IS DISTINCT FROM OLD."offsetAmount"
    OR NEW."netPayoutAmount" IS DISTINCT FROM OLD."netPayoutAmount"
    OR NEW."debtBalanceSnapshot" IS DISTINCT FROM OLD."debtBalanceSnapshot"
    OR NEW."chipReturnOperationId" IS DISTINCT FROM OLD."chipReturnOperationId"
    OR NEW."signatureId" IS DISTINCT FROM OLD."signatureId"
    OR NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt"
    OR NEW."receivedById" IS DISTINCT FROM OLD."receivedById"
    OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."confirmIdempotencyKey" IS DISTINCT FROM OLD."confirmIdempotencyKey") THEN
    RAISE EXCEPTION 'Una liquidación con recepción confirmada no se edita: se corrige con un reverso';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "player_settlements_guard" BEFORE INSERT OR UPDATE OR DELETE ON "player_settlements"
  FOR EACH ROW EXECUTE FUNCTION "player_settlements_guard"();

CREATE TRIGGER "settlement_status_history_immutable" BEFORE UPDATE OR DELETE ON "settlement_status_history"
  FOR EACH ROW EXECUTE FUNCTION "session_append_only"();

-- ── Firmas de liquidación (mismas reglas que las de compras) ────────────
ALTER TABLE "settlement_signature_snapshots" ADD CONSTRAINT "settlement_signature_snapshots_valid"
  CHECK ("settlementVersion" >= 1 AND length("contentHash") = 64
         AND length("materialHash") = 64 AND length("payloadHash") = 64);
CREATE TRIGGER "settlement_signature_snapshots_immutable" BEFORE UPDATE OR DELETE ON "settlement_signature_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "evidence_append_only"();

CREATE UNIQUE INDEX "settlement_signatures_one_valid"
  ON "settlement_signatures" ("settlementId") WHERE "status" = 'VALID';
ALTER TABLE "settlement_signatures" ADD CONSTRAINT "settlement_signatures_invalidation_complete"
  CHECK (("status" = 'VALID') = ("invalidatedAt" IS NULL)
         AND ("status" = 'VALID' OR ("invalidatedById" IS NOT NULL AND "invalidationReason" IS NOT NULL)));

CREATE FUNCTION "settlement_signatures_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'VALID' THEN
      RAISE EXCEPTION 'Una firma nace VALID';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "settlement_signature_snapshots" s
                   WHERE s."id" = NEW."snapshotId" AND s."settlementId" = NEW."settlementId"
                     AND s."playerId" = NEW."playerId") THEN
      RAISE EXCEPTION 'La firma no corresponde a la liquidación o al jugador del resumen';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'settlement_signatures no admite DELETE (evidencia)';
  END IF;
  IF OLD."status" <> 'VALID' OR NEW."status" NOT IN ('INVALIDATED', 'CANCELLED') THEN
    RAISE EXCEPTION 'Una firma solo pasa de VALID a INVALIDATED o CANCELLED';
  END IF;
  IF EXISTS (SELECT 1 FROM "player_settlements" p WHERE p."signatureId" = OLD."id") THEN
    RAISE EXCEPTION 'La firma de una recepción confirmada no se invalida';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'invalidatedAt', 'invalidatedById', 'invalidationReason'])
     <> (to_jsonb(OLD) - ARRAY['status', 'invalidatedAt', 'invalidatedById', 'invalidationReason']) THEN
    RAISE EXCEPTION 'La imagen, el resumen y los datos de una firma son inmutables';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "settlement_signatures_guard" BEFORE INSERT OR UPDATE OR DELETE ON "settlement_signatures"
  FOR EACH ROW EXECUTE FUNCTION "settlement_signatures_guard"();

-- La recepción solo usa una firma VALID de la MISMA liquidación.
CREATE FUNCTION "player_settlements_signature_check"() RETURNS trigger AS $$
BEGIN
  IF NEW."signatureId" IS NOT NULL AND NEW."signatureId" IS DISTINCT FROM OLD."signatureId" AND NOT EXISTS (
    SELECT 1 FROM "settlement_signatures" s
    WHERE s."id" = NEW."signatureId" AND s."settlementId" = NEW."id" AND s."status" = 'VALID'
  ) THEN
    RAISE EXCEPTION 'La recepción solo puede usar una firma VALID de la misma liquidación';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "player_settlements_signature_check" BEFORE UPDATE ON "player_settlements"
  FOR EACH ROW EXECUTE FUNCTION "player_settlements_signature_check"();

-- Archivos privados: el vínculo con la liquidación se fija al promover.
CREATE OR REPLACE FUNCTION "stored_files_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stored_files no admite DELETE (trazabilidad)';
  END IF;
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'Un archivo ACTIVE u ORPHANED no cambia';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'purchaseId', 'settlementId', 'promotedAt', 'orphanedAt'])
     <> (to_jsonb(OLD) - ARRAY['status', 'purchaseId', 'settlementId', 'promotedAt', 'orphanedAt']) THEN
    RAISE EXCEPTION 'El contenido de un archivo privado es inmutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Compensaciones con fichas (libro de aplicaciones del Módulo 10) ─────
-- Mismo jugador y nunca más que el valor nominal devuelto en la liquidación.
CREATE FUNCTION "payment_allocations_settlement_check"() RETURNS trigger AS $$
DECLARE
  st RECORD;
  net NUMERIC;
BEGIN
  IF NEW."settlementId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "playerId", "returnedNominalAmount" INTO st FROM "player_settlements" WHERE "id" = NEW."settlementId";
  IF st."playerId" IS DISTINCT FROM NEW."playerId" THEN
    RAISE EXCEPTION 'La compensación y la liquidación deben ser del mismo jugador';
  END IF;
  SELECT COALESCE(SUM(CASE WHEN "kind" = 'APPLICATION' THEN "amount" ELSE -"amount" END), 0)
    INTO net FROM "payment_allocations" WHERE "settlementId" = NEW."settlementId";
  net := net + CASE WHEN NEW."kind" = 'APPLICATION' THEN NEW."amount" ELSE -NEW."amount" END;
  IF net > st."returnedNominalAmount" OR net < 0 THEN
    RAISE EXCEPTION 'La compensación excede el valor de las fichas devueltas';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "payment_allocations_settlement_check" BEFORE INSERT ON "payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION "payment_allocations_settlement_check"();

-- ── Cuentas por pagar al jugador ────────────────────────────────────────
ALTER TABLE "settlement_payables" ADD CONSTRAINT "settlement_payables_valid"
  CHECK ("originalAmount" >= 0
         AND ("status" <> 'PAID' OR "paidAt" IS NOT NULL)
         AND (("status" = 'VOIDED') = ("voidedAt" IS NOT NULL)));

CREATE FUNCTION "settlement_payables_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'settlement_payables no admite DELETE (historial)';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'paidAt', 'voidedAt'])
     <> (to_jsonb(OLD) - ARRAY['status', 'paidAt', 'voidedAt']) THEN
    RAISE EXCEPTION 'El importe y el origen de una cuenta por pagar son inmutables';
  END IF;
  IF OLD."status" IN ('PAID', 'VOIDED') AND NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (OLD."status" = 'PAID' AND NEW."status" = 'VOIDED') THEN
    RAISE EXCEPTION 'Transición de cuenta por pagar no permitida: % → %', OLD."status", NEW."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "settlement_payables_guard" BEFORE UPDATE OR DELETE ON "settlement_payables"
  FOR EACH ROW EXECUTE FUNCTION "settlement_payables_guard"();

-- ── Desembolsos ─────────────────────────────────────────────────────────
ALTER TABLE "settlement_payouts" ADD CONSTRAINT "settlement_payouts_valid"
  CHECK ("amount" > 0 AND "sequence" >= 1
    AND (("method" = 'CASH') = ("funding" IN ('SESSION_CASH', 'ADMIN_CUSTODY')))
    AND (("funding" = 'BANK') = ("paymentAccountId" IS NOT NULL))
    AND (("funding" = 'SESSION_CASH') = ("sessionId" IS NOT NULL))
    AND (("funding" = 'ADMIN_CUSTODY') = ("custodianUserId" IS NOT NULL))
    -- Solo una transferencia queda pendiente; el efectivo se entrega al registrarlo.
    AND ("status" <> 'PENDING' OR "method" = 'BANK_TRANSFER')
    AND (("status" = 'EXECUTED') = ("financialTransactionId" IS NOT NULL))
    AND ("status" <> 'EXECUTED' OR "executedAt" IS NOT NULL)
    AND ("status" NOT IN ('FAILED', 'CANCELLED') OR ("failureReason" IS NOT NULL AND "resolvedAt" IS NOT NULL)));

CREATE FUNCTION "settlement_payouts_guard"() RETURNS trigger AS $$
DECLARE
  pay RECORD;
  committed NUMERIC;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'settlement_payouts no admite DELETE (historial)';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('PENDING', 'EXECUTED') THEN
      RAISE EXCEPTION 'Un desembolso nace PENDING (transferencia) o EXECUTED (efectivo)';
    END IF;
  ELSE
    IF OLD."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'Un desembolso ejecutado, fallido o cancelado es inmutable';
    END IF;
    IF NEW."status" NOT IN ('PENDING', 'EXECUTED', 'FAILED', 'CANCELLED') THEN
      RAISE EXCEPTION 'Transición de desembolso no permitida';
    END IF;
    IF (to_jsonb(NEW) - ARRAY['status', 'financialTransactionId', 'bankReference', 'failureReason',
                              'resolvedById', 'resolvedAt', 'executedAt', 'resolveIdempotencyKey', 'updatedAt'])
       <> (to_jsonb(OLD) - ARRAY['status', 'financialTransactionId', 'bankReference', 'failureReason',
                              'resolvedById', 'resolvedAt', 'executedAt', 'resolveIdempotencyKey', 'updatedAt']) THEN
      RAISE EXCEPTION 'Importe, método y origen de un desembolso son inmutables';
    END IF;
  END IF;
  SELECT "settlementId", "playerId", "originalAmount", "status" INTO pay
    FROM "settlement_payables" WHERE "id" = NEW."payableId";
  IF pay."settlementId" IS DISTINCT FROM NEW."settlementId" OR pay."playerId" IS DISTINCT FROM NEW."playerId" THEN
    RAISE EXCEPTION 'El desembolso no corresponde a la cuenta por pagar';
  END IF;
  IF NEW."status" IN ('PENDING', 'EXECUTED') THEN
    IF pay."status" = 'VOIDED' THEN
      RAISE EXCEPTION 'La cuenta por pagar está anulada';
    END IF;
    -- Pagado + reservado (transferencias en trámite) nunca excede lo que se debe.
    SELECT COALESCE(SUM("amount"), 0) INTO committed FROM "settlement_payouts"
      WHERE "payableId" = NEW."payableId" AND "status" IN ('PENDING', 'EXECUTED') AND "id" <> NEW."id";
    IF committed + NEW."amount" > pay."originalAmount" THEN
      RAISE EXCEPTION 'Los desembolsos exceden la cuenta por pagar (comprometido %, original %)',
        committed + NEW."amount", pay."originalAmount";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "settlement_payouts_guard" BEFORE INSERT OR UPDATE OR DELETE ON "settlement_payouts"
  FOR EACH ROW EXECUTE FUNCTION "settlement_payouts_guard"();

-- ── Comprobantes ────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "settlement_receipts_one_reception"
  ON "settlement_receipts" ("settlementId") WHERE "kind" = 'RECEPTION';
ALTER TABLE "settlement_receipts" ADD CONSTRAINT "settlement_receipts_valid"
  CHECK ((("kind" = 'PAYOUT') = ("payoutId" IS NOT NULL))
         AND (("status" = 'AVAILABLE') = ("voidedAt" IS NULL))
         AND ("status" = 'AVAILABLE' OR "voidReason" IS NOT NULL));
CREATE FUNCTION "settlement_receipts_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'AVAILABLE' OR NOT EXISTS (
      SELECT 1 FROM "player_settlements" p
      WHERE p."id" = NEW."settlementId" AND p."status" IN ('PENDING_PAYOUT', 'COMPLETED')
    ) THEN
      RAISE EXCEPTION 'Solo una liquidación con recepción confirmada tiene comprobante';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'settlement_receipts no admite DELETE (historial)';
  END IF;
  IF OLD."status" <> 'AVAILABLE' OR NEW."status" <> 'VOIDED' THEN
    RAISE EXCEPTION 'Un comprobante solo pasa de AVAILABLE a VOIDED';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'voidedAt', 'voidReason'])
     <> (to_jsonb(OLD) - ARRAY['status', 'voidedAt', 'voidReason']) THEN
    RAISE EXCEPTION 'El contenido de un comprobante es inmutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "settlement_receipts_guard" BEFORE INSERT OR UPDATE OR DELETE ON "settlement_receipts"
  FOR EACH ROW EXECUTE FUNCTION "settlement_receipts_guard"();

-- ── Reversos y aportaciones a custodia: solo inserción ──────────────────
CREATE TRIGGER "settlement_reversals_immutable" BEFORE UPDATE OR DELETE ON "settlement_reversals"
  FOR EACH ROW EXECUTE FUNCTION "credits_append_only"();
ALTER TABLE "administrative_cash_contributions" ADD CONSTRAINT "administrative_cash_contributions_valid"
  CHECK ("amount" > 0);
CREATE TRIGGER "administrative_cash_contributions_immutable" BEFORE UPDATE OR DELETE ON "administrative_cash_contributions"
  FOR EACH ROW EXECUTE FUNCTION "credits_append_only"();
