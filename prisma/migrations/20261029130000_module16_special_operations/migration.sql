-- Módulo 16 — operaciones financieras especiales (canje posterior, reverso de
-- compras, corrección de liquidaciones, devolución de fondos no aplicados).
-- Aditiva: tablas nuevas, garantías y siembra idempotente de folios. No
-- modifica saldos, movimientos, firmas, comprobantes ni sesiones cerradas.

-- CreateEnum
CREATE TYPE "LateRedemptionStatus" AS ENUM ('REQUESTED', 'VALIDATING', 'REJECTED', 'PAYMENT_PENDING', 'PARTIALLY_PAID', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SpecialPayableKind" AS ENUM ('REDEMPTION', 'PURCHASE_REFUND', 'SETTLEMENT_ADJUSTMENT', 'UNAPPLIED_REFUND');

-- CreateEnum
CREATE TYPE "SpecialPayableStatus" AS ENUM ('OPEN', 'PARTIALLY_PAID', 'PAID');

-- CreateEnum
CREATE TYPE "SpecialPayoutStatus" AS ENUM ('PENDING', 'EXECUTED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SettlementCorrectionKind" AS ENUM ('ADDITIONAL_PAYOUT', 'OFFSET_REVERSAL');




-- CreateTable
CREATE TABLE "late_chip_redemptions" (
    "id" TEXT NOT NULL,
    "folio" TEXT NOT NULL,
    "status" "LateRedemptionStatus" NOT NULL DEFAULT 'REQUESTED',
    "presenterName" TEXT NOT NULL,
    "playerId" TEXT,
    "originSessionId" TEXT,
    "originEvidence" TEXT,
    "presentedNominal" DECIMAL(14,2) NOT NULL,
    "acceptedNominal" DECIMAL(14,2),
    "rejectedNominal" DECIMAL(14,2),
    "denominations" JSONB,
    "validationNotes" TEXT,
    "validatedAt" TIMESTAMP(3),
    "chipOperationId" TEXT,
    "receivedById" TEXT,
    "receivedAt" TIMESTAMP(3),
    "notes" TEXT,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "late_chip_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "special_payables" (
    "id" TEXT NOT NULL,
    "kind" "SpecialPayableKind" NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "playerId" TEXT,
    "beneficiaryName" TEXT NOT NULL,
    "sessionId" TEXT,
    "originalAmount" DECIMAL(14,2) NOT NULL,
    "status" "SpecialPayableStatus" NOT NULL DEFAULT 'OPEN',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "special_payables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "special_payouts" (
    "id" TEXT NOT NULL,
    "folio" TEXT NOT NULL,
    "payableId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "method" "SettlementPayoutMethod" NOT NULL,
    "funding" "SettlementPayoutFunding" NOT NULL,
    "status" "SpecialPayoutStatus" NOT NULL,
    "sessionId" TEXT,
    "custodianUserId" TEXT,
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

    CONSTRAINT "special_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_reversals" (
    "id" TEXT NOT NULL,
    "folio" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "correctionId" TEXT NOT NULL,
    "chipOperationId" TEXT NOT NULL,
    "returnedNominal" DECIMAL(14,2) NOT NULL,
    "extinguishedAmount" DECIMAL(14,2) NOT NULL,
    "refundAmount" DECIMAL(14,2) NOT NULL,
    "plan" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "executedById" TEXT NOT NULL,
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "purchase_reversals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_corrections" (
    "id" TEXT NOT NULL,
    "folio" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "kind" "SettlementCorrectionKind" NOT NULL,
    "correctionId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "executedById" TEXT NOT NULL,
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "settlement_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "special_operation_evidence" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "declarationText" TEXT NOT NULL,
    "signerName" TEXT NOT NULL,
    "playerId" TEXT,
    "fileId" TEXT NOT NULL,
    "capturedById" TEXT NOT NULL,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "special_operation_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "special_operation_receipts" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "special_operation_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "late_chip_redemptions_folio_key" ON "late_chip_redemptions"("folio");

-- CreateIndex
CREATE UNIQUE INDEX "late_chip_redemptions_chipOperationId_key" ON "late_chip_redemptions"("chipOperationId");

-- CreateIndex
CREATE UNIQUE INDEX "late_chip_redemptions_idempotencyKey_key" ON "late_chip_redemptions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "late_chip_redemptions_status_requestedAt_idx" ON "late_chip_redemptions"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "late_chip_redemptions_playerId_idx" ON "late_chip_redemptions"("playerId");

-- CreateIndex
CREATE INDEX "special_payables_status_createdAt_idx" ON "special_payables"("status", "createdAt");

-- CreateIndex
CREATE INDEX "special_payables_playerId_idx" ON "special_payables"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "special_payables_kind_sourceId_key" ON "special_payables"("kind", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "special_payouts_folio_key" ON "special_payouts"("folio");

-- CreateIndex
CREATE UNIQUE INDEX "special_payouts_financialTransactionId_key" ON "special_payouts"("financialTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "special_payouts_idempotencyKey_key" ON "special_payouts"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "special_payouts_resolveIdempotencyKey_key" ON "special_payouts"("resolveIdempotencyKey");

-- CreateIndex
CREATE INDEX "special_payouts_payableId_status_idx" ON "special_payouts"("payableId", "status");

-- CreateIndex
CREATE INDEX "special_payouts_status_createdAt_idx" ON "special_payouts"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "special_payouts_payableId_sequence_key" ON "special_payouts"("payableId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_reversals_folio_key" ON "purchase_reversals"("folio");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_reversals_purchaseId_key" ON "purchase_reversals"("purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_reversals_correctionId_key" ON "purchase_reversals"("correctionId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_reversals_chipOperationId_key" ON "purchase_reversals"("chipOperationId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_reversals_idempotencyKey_key" ON "purchase_reversals"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_corrections_folio_key" ON "settlement_corrections"("folio");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_corrections_correctionId_key" ON "settlement_corrections"("correctionId");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_corrections_evidenceId_key" ON "settlement_corrections"("evidenceId");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_corrections_idempotencyKey_key" ON "settlement_corrections"("idempotencyKey");

-- CreateIndex
CREATE INDEX "settlement_corrections_settlementId_idx" ON "settlement_corrections"("settlementId");

-- CreateIndex
CREATE UNIQUE INDEX "special_operation_evidence_fileId_key" ON "special_operation_evidence"("fileId");

-- CreateIndex
CREATE UNIQUE INDEX "special_operation_evidence_sourceType_sourceId_key" ON "special_operation_evidence"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "special_operation_receipts_sourceKey_key" ON "special_operation_receipts"("sourceKey");

-- CreateIndex
CREATE INDEX "special_operation_receipts_kind_createdAt_idx" ON "special_operation_receipts"("kind", "createdAt");

-- AddForeignKey
ALTER TABLE "late_chip_redemptions" ADD CONSTRAINT "late_chip_redemptions_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "late_chip_redemptions" ADD CONSTRAINT "late_chip_redemptions_originSessionId_fkey" FOREIGN KEY ("originSessionId") REFERENCES "poker_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "late_chip_redemptions" ADD CONSTRAINT "late_chip_redemptions_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "late_chip_redemptions" ADD CONSTRAINT "late_chip_redemptions_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_payables" ADD CONSTRAINT "special_payables_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_payables" ADD CONSTRAINT "special_payables_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_payouts" ADD CONSTRAINT "special_payouts_payableId_fkey" FOREIGN KEY ("payableId") REFERENCES "special_payables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_payouts" ADD CONSTRAINT "special_payouts_custodianUserId_fkey" FOREIGN KEY ("custodianUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_payouts" ADD CONSTRAINT "special_payouts_financialTransactionId_fkey" FOREIGN KEY ("financialTransactionId") REFERENCES "cash_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_payouts" ADD CONSTRAINT "special_payouts_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_payouts" ADD CONSTRAINT "special_payouts_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_reversals" ADD CONSTRAINT "purchase_reversals_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "chip_purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_reversals" ADD CONSTRAINT "purchase_reversals_correctionId_fkey" FOREIGN KEY ("correctionId") REFERENCES "correction_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_reversals" ADD CONSTRAINT "purchase_reversals_executedById_fkey" FOREIGN KEY ("executedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_corrections" ADD CONSTRAINT "settlement_corrections_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "player_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_corrections" ADD CONSTRAINT "settlement_corrections_correctionId_fkey" FOREIGN KEY ("correctionId") REFERENCES "correction_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_corrections" ADD CONSTRAINT "settlement_corrections_executedById_fkey" FOREIGN KEY ("executedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_operation_evidence" ADD CONSTRAINT "special_operation_evidence_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_operation_evidence" ADD CONSTRAINT "special_operation_evidence_capturedById_fkey" FOREIGN KEY ("capturedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_operation_receipts" ADD CONSTRAINT "special_operation_receipts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Garantías del Módulo 16 ─────────────────────────────────────────────

-- Extinción por reverso de compra: enlazada a su reverso (trazabilidad).
ALTER TABLE "payment_allocations" ADD COLUMN "purchaseReversalId" TEXT;
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_purchaseReversalId_fkey" FOREIGN KEY ("purchaseReversalId") REFERENCES "purchase_reversals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_allocations" DROP CONSTRAINT "payment_allocations_valid";
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_valid"
  CHECK ("amount" > 0 AND "allocationOrder" >= 1
    AND (("kind" = 'REVERSAL') = ("reversesAllocationId" IS NOT NULL))
    AND (("source" = 'RECEIVABLE_PAYMENT') = ("receivablePaymentId" IS NOT NULL))
    AND (("source" = 'PURCHASE_PAYMENT') = ("purchasePaymentId" IS NOT NULL))
    AND (("source" = 'CHIP_SETTLEMENT_OFFSET') = ("settlementId" IS NOT NULL))
    AND (("source" = 'PURCHASE_REVERSAL') = ("purchaseReversalId" IS NOT NULL))
    -- La extinción por reverso nunca se revierte (la compra ya no existe).
    AND NOT ("source" = 'PURCHASE_REVERSAL' AND "kind" = 'REVERSAL'));

-- Aplicaciones: además de lo del Módulo 10, la deuda de una compra REVERTIDA
-- queda cerrada: no admite reversos de aplicaciones (reabrirían una deuda
-- cuya compra ya no existe) ni aplicaciones nuevas fuera de la extinción.
CREATE OR REPLACE FUNCTION "payment_allocations_guard"() RETURNS trigger AS $$
DECLARE
  debt RECORD;
  net NUMERIC;
  pay RECORD;
  pay_net NUMERIC;
  orig RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'payment_allocations es de solo inserción (%): las correcciones son reversos', TG_OP;
  END IF;
  SELECT "playerId", "originalAmount", "purchaseId" INTO debt FROM "player_debts" WHERE "id" = NEW."receivableId";
  IF debt."playerId" IS DISTINCT FROM NEW."playerId" THEN
    RAISE EXCEPTION 'La aplicación y la deuda deben ser del mismo jugador';
  END IF;
  IF NEW."source" <> 'PURCHASE_REVERSAL'
     AND EXISTS (SELECT 1 FROM "purchase_reversals" r WHERE r."purchaseId" = debt."purchaseId") THEN
    RAISE EXCEPTION 'La deuda pertenece a una compra revertida: no admite más aplicaciones ni reversos'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'REVERSAL' THEN
    SELECT * INTO orig FROM "payment_allocations" WHERE "id" = NEW."reversesAllocationId";
    IF orig."kind" <> 'APPLICATION' OR orig."receivableId" <> NEW."receivableId"
       OR orig."amount" <> NEW."amount" OR orig."source" <> NEW."source" THEN
      RAISE EXCEPTION 'Un reverso debe espejar exactamente su aplicación original';
    END IF;
  END IF;
  SELECT COALESCE(SUM(CASE WHEN "kind" = 'APPLICATION' THEN "amount" ELSE -"amount" END), 0)
    INTO net FROM "payment_allocations" WHERE "receivableId" = NEW."receivableId";
  net := net + CASE WHEN NEW."kind" = 'APPLICATION' THEN NEW."amount" ELSE -NEW."amount" END;
  IF net > debt."originalAmount" OR net < 0 THEN
    RAISE EXCEPTION 'La aplicación excede la deuda (aplicado %, original %)', net, debt."originalAmount";
  END IF;
  IF NEW."receivablePaymentId" IS NOT NULL THEN
    SELECT "playerId", "amount" INTO pay FROM "receivable_payments" WHERE "id" = NEW."receivablePaymentId";
    IF pay."playerId" <> NEW."playerId" THEN
      RAISE EXCEPTION 'El abono y la deuda deben ser del mismo jugador';
    END IF;
    SELECT COALESCE(SUM(CASE WHEN "kind" = 'APPLICATION' THEN "amount" ELSE -"amount" END), 0)
      INTO pay_net FROM "payment_allocations" WHERE "receivablePaymentId" = NEW."receivablePaymentId";
    pay_net := pay_net + CASE WHEN NEW."kind" = 'APPLICATION' THEN NEW."amount" ELSE -NEW."amount" END;
    IF pay_net > pay."amount" THEN
      RAISE EXCEPTION 'Las aplicaciones superan el importe del abono';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Compras: CONFIRMED → REVERSED SOLO con un reverso ejecutado registrado
-- (purchase_reversals) y sin tocar ningún otro dato de la compra.
CREATE OR REPLACE FUNCTION "chip_purchases_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."sequenceNumber" IS NOT NULL THEN
      RAISE EXCEPTION 'Una compra nace como borrador sin numeración';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'chip_purchases no admite DELETE (historial)';
  END IF;
  IF OLD."status" IN ('CANCELLED', 'REVERSED') THEN
    RAISE EXCEPTION 'Una compra cancelada o revertida es inmutable';
  END IF;
  IF OLD."status" = 'CONFIRMED' THEN
    IF NEW."status" = 'REVERSED'
       AND EXISTS (SELECT 1 FROM "purchase_reversals" r WHERE r."purchaseId" = OLD."id")
       AND NEW."nominalAmount" = OLD."nominalAmount"
       AND NEW."folio" = OLD."folio"
       AND NEW."sessionId" = OLD."sessionId"
       AND NEW."sessionTableId" = OLD."sessionTableId"
       AND NEW."idempotencyKey" = OLD."idempotencyKey"
       AND NEW."createdById" = OLD."createdById"
       AND NEW."playerId" = OLD."playerId"
       AND NEW."tableId" = OLD."tableId"
       AND NEW."cycleId" = OLD."cycleId"
       AND NEW."participationId" = OLD."participationId"
       AND NEW."confirmedAt" IS NOT DISTINCT FROM OLD."confirmedAt"
       AND NEW."confirmedById" IS NOT DISTINCT FROM OLD."confirmedById"
       AND NEW."sequenceNumber" IS NOT DISTINCT FROM OLD."sequenceNumber"
       AND NEW."purchaseType" IS NOT DISTINCT FROM OLD."purchaseType"
       AND NEW."rebuyNumber" IS NOT DISTINCT FROM OLD."rebuyNumber" THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Una compra confirmada es inmutable (solo un reverso ejecutado la marca REVERSED)';
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
    RAISE EXCEPTION 'Jugador, mesa, participación, folio y creador de una compra son inmutables';
  END IF;
  IF NEW."version" < OLD."version" THEN
    RAISE EXCEPTION 'La versión de una compra no retrocede';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Hechos ejecutados, evidencias y comprobantes: SOLO INSERCIÓN.
CREATE TRIGGER "purchase_reversals_append_only" BEFORE UPDATE OR DELETE ON "purchase_reversals"
  FOR EACH ROW EXECUTE FUNCTION "m15_append_only"();
CREATE TRIGGER "settlement_corrections_append_only" BEFORE UPDATE OR DELETE ON "settlement_corrections"
  FOR EACH ROW EXECUTE FUNCTION "m15_append_only"();
CREATE TRIGGER "special_operation_evidence_append_only" BEFORE UPDATE OR DELETE ON "special_operation_evidence"
  FOR EACH ROW EXECUTE FUNCTION "m15_append_only"();
CREATE TRIGGER "special_operation_receipts_append_only" BEFORE UPDATE OR DELETE ON "special_operation_receipts"
  FOR EACH ROW EXECUTE FUNCTION "m15_append_only"();
CREATE TRIGGER "late_chip_redemptions_no_delete" BEFORE DELETE ON "late_chip_redemptions"
  FOR EACH ROW EXECUTE FUNCTION "m15_no_delete"();

ALTER TABLE "purchase_reversals" ADD CONSTRAINT "purchase_reversals_amounts"
  CHECK ("returnedNominal" > 0 AND "extinguishedAmount" >= 0 AND "refundAmount" >= 0);
ALTER TABLE "settlement_corrections" ADD CONSTRAINT "settlement_corrections_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "late_chip_redemptions" ADD CONSTRAINT "late_chip_redemptions_amounts"
  CHECK ("presentedNominal" > 0
    AND ("acceptedNominal" IS NULL OR ("acceptedNominal" >= 0 AND "acceptedNominal" <= "presentedNominal"))
    AND ("rejectedNominal" IS NULL OR "rejectedNominal" >= 0));
-- Recibido ⇒ entrada nominal y fecha real de recepción.
ALTER TABLE "late_chip_redemptions" ADD CONSTRAINT "late_chip_redemptions_received_has_entry"
  CHECK ("status" NOT IN ('PAYMENT_PENDING', 'PARTIALLY_PAID', 'PAID')
    OR ("chipOperationId" IS NOT NULL AND "receivedAt" IS NOT NULL AND "receivedById" IS NOT NULL AND "acceptedNominal" > 0));

-- Un canje con fichas recibidas no se cancela ni retrocede (requiere compensación legítima).
CREATE FUNCTION "late_chip_redemptions_guard"() RETURNS trigger AS $$
BEGIN
  IF OLD."chipOperationId" IS NOT NULL THEN
    IF NEW."status" NOT IN ('PAYMENT_PENDING', 'PARTIALLY_PAID', 'PAID')
       OR NEW."chipOperationId" IS DISTINCT FROM OLD."chipOperationId"
       OR NEW."acceptedNominal" IS DISTINCT FROM OLD."acceptedNominal"
       OR NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt" THEN
      RAISE EXCEPTION 'El canje % ya recibió fichas: no se cancela ni se modifica lo recibido', OLD."folio"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF OLD."status" IN ('REJECTED', 'CANCELLED') AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'El canje % está en estado terminal', OLD."folio" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."presentedNominal" <> OLD."presentedNominal" OR NEW."folio" <> OLD."folio" THEN
    RAISE EXCEPTION 'Los datos originales del canje son inmutables' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "late_chip_redemptions_guard" BEFORE UPDATE ON "late_chip_redemptions"
  FOR EACH ROW EXECUTE FUNCTION "late_chip_redemptions_guard"();

-- Obligaciones especiales: importe inmutable y positivo; sin borrado.
ALTER TABLE "special_payables" ADD CONSTRAINT "special_payables_amount_positive" CHECK ("originalAmount" > 0);
CREATE FUNCTION "special_payables_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'special_payables no admite DELETE' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."originalAmount" <> OLD."originalAmount" OR NEW."kind" <> OLD."kind" OR NEW."sourceId" <> OLD."sourceId" THEN
    RAISE EXCEPTION 'El importe y el origen de una obligación son inmutables' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "special_payables_guard" BEFORE UPDATE OR DELETE ON "special_payables"
  FOR EACH ROW EXECUTE FUNCTION "special_payables_guard"();

-- Pagos especiales: nunca más que la obligación (ejecutado + en curso),
-- datos inmutables, EXECUTED con asiento, transiciones válidas.
ALTER TABLE "special_payouts" ADD CONSTRAINT "special_payouts_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "special_payouts" ADD CONSTRAINT "special_payouts_executed_has_tx"
  CHECK ("status" <> 'EXECUTED' OR ("financialTransactionId" IS NOT NULL AND "executedAt" IS NOT NULL));
CREATE FUNCTION "special_payouts_guard"() RETURNS trigger AS $$
DECLARE
  committed DECIMAL(14, 2);
  original DECIMAL(14, 2);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'special_payouts no admite DELETE' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."amount" <> OLD."amount" OR NEW."payableId" <> OLD."payableId" OR NEW."method" <> OLD."method"
       OR NEW."funding" <> OLD."funding" THEN
      RAISE EXCEPTION 'Importe, método y obligación de un pago son inmutables' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'PENDING' AND NEW."status" <> OLD."status" THEN
      RAISE EXCEPTION 'Un pago % ya resuelto no cambia de estado', OLD."folio" USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT p."originalAmount" INTO original FROM "special_payables" p WHERE p."id" = NEW."payableId";
  SELECT COALESCE(SUM(x."amount"), 0) INTO committed FROM "special_payouts" x
    WHERE x."payableId" = NEW."payableId" AND x."status" IN ('PENDING', 'EXECUTED') AND x."id" <> NEW."id";
  IF NEW."status" IN ('PENDING', 'EXECUTED') AND committed + NEW."amount" > original THEN
    RAISE EXCEPTION 'El pago excede la obligación pendiente (sin doble desembolso)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "special_payouts_guard" BEFORE INSERT OR UPDATE OR DELETE ON "special_payouts"
  FOR EACH ROW EXECUTE FUNCTION "special_payouts_guard"();

-- Una sola corrección por compensación revertida en cada liquidación.
CREATE UNIQUE INDEX "settlement_corrections_one_offset_reversal" ON "settlement_corrections" ("settlementId")
  WHERE "kind" = 'OFFSET_REVERSAL';

-- Siembra idempotente de folios.
INSERT INTO "folio_sequences" ("id", "documentType", "prefix", "nextNumber", "padding", "isActive", "createdAt", "updatedAt")
VALUES ('m16-folio-redemption', 'REDEMPTION', 'CAN', 1, 6, true, NOW(), NOW()),
       ('m16-folio-purchase-reversal', 'PURCHASE_REVERSAL', 'REV', 1, 6, true, NOW(), NOW()),
       ('m16-folio-settlement-correction', 'SETTLEMENT_CORRECTION', 'AJL', 1, 6, true, NOW(), NOW()),
       ('m16-folio-special-payout', 'SPECIAL_PAYOUT', 'PES', 1, 6, true, NOW(), NOW())
ON CONFLICT ("documentType") DO NOTHING;
