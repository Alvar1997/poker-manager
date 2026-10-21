-- Módulo 10 (2/2): abonos, aplicaciones FIFO, reversos, fondos no aplicados,
-- depósitos de custodia y comprobantes de abono. Aditiva: no crea abonos,
-- aplicaciones ni depósitos; no modifica deudas. Ver docs/MODULE_10_CREDITS.md.

-- CreateEnum
CREATE TYPE "ReceivablePaymentOrigin" AS ENUM ('SESSION', 'ADMINISTRATIVE');

-- CreateEnum
CREATE TYPE "ReceivablePaymentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "AllocationSource" AS ENUM ('RECEIVABLE_PAYMENT', 'PURCHASE_PAYMENT', 'CHIP_SETTLEMENT_OFFSET');

-- CreateEnum
CREATE TYPE "AllocationKind" AS ENUM ('APPLICATION', 'REVERSAL');

-- CreateEnum
CREATE TYPE "UnappliedFundsStatus" AS ENUM ('PENDING_RESOLUTION');

-- CreateTable
CREATE TABLE "receivable_payments" (
    "id" TEXT NOT NULL,
    "folio" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "method" "PaymentMethodCode" NOT NULL,
    "origin" "ReceivablePaymentOrigin" NOT NULL,
    "sessionId" TEXT,
    "status" "ReceivablePaymentStatus" NOT NULL,
    "financialTransactionId" TEXT,
    "bankTransferId" TEXT,
    "custodianUserId" TEXT,
    "terminalReference" TEXT,
    "terminalIdentifier" TEXT,
    "externalReference" TEXT,
    "cardSettlementId" TEXT,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "confirmedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receivable_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" TEXT NOT NULL,
    "receivableId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "kind" "AllocationKind" NOT NULL DEFAULT 'APPLICATION',
    "source" "AllocationSource" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "allocationOrder" INTEGER NOT NULL,
    "receivablePaymentId" TEXT,
    "purchasePaymentId" TEXT,
    "settlementId" TEXT,
    "reversesAllocationId" TEXT,
    "createdById" TEXT NOT NULL,
    "allocatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receivable_payment_reversals" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "transactionId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "receivable_payment_reversals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unapplied_player_funds" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" "UnappliedFundsStatus" NOT NULL DEFAULT 'PENDING_RESOLUTION',
    "reason" TEXT NOT NULL,
    "bankTransferId" TEXT NOT NULL,
    "receivablePaymentId" TEXT,
    "purchasePaymentId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unapplied_player_funds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "administrative_cash_deposits" (
    "id" TEXT NOT NULL,
    "custodianUserId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "bankReference" TEXT,
    "notes" TEXT,
    "transactionId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "administrative_cash_deposits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receivable_payment_receipts" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'AVAILABLE',
    "content" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,

    CONSTRAINT "receivable_payment_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "receivable_payments_folio_key" ON "receivable_payments"("folio");

-- CreateIndex
CREATE UNIQUE INDEX "receivable_payments_financialTransactionId_key" ON "receivable_payments"("financialTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "receivable_payments_bankTransferId_key" ON "receivable_payments"("bankTransferId");

-- CreateIndex
CREATE UNIQUE INDEX "receivable_payments_idempotencyKey_key" ON "receivable_payments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "receivable_payments_playerId_createdAt_idx" ON "receivable_payments"("playerId", "createdAt");

-- CreateIndex
CREATE INDEX "receivable_payments_status_createdAt_idx" ON "receivable_payments"("status", "createdAt");

-- CreateIndex
CREATE INDEX "receivable_payments_origin_createdAt_idx" ON "receivable_payments"("origin", "createdAt");

-- CreateIndex
CREATE INDEX "receivable_payments_cardSettlementId_idx" ON "receivable_payments"("cardSettlementId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_allocations_reversesAllocationId_key" ON "payment_allocations"("reversesAllocationId");

-- CreateIndex
CREATE INDEX "payment_allocations_receivableId_idx" ON "payment_allocations"("receivableId");

-- CreateIndex
CREATE INDEX "payment_allocations_playerId_allocatedAt_idx" ON "payment_allocations"("playerId", "allocatedAt");

-- CreateIndex
CREATE INDEX "payment_allocations_receivablePaymentId_idx" ON "payment_allocations"("receivablePaymentId");

-- CreateIndex
CREATE INDEX "payment_allocations_purchasePaymentId_idx" ON "payment_allocations"("purchasePaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "receivable_payment_reversals_paymentId_key" ON "receivable_payment_reversals"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "receivable_payment_reversals_transactionId_key" ON "receivable_payment_reversals"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "receivable_payment_reversals_idempotencyKey_key" ON "receivable_payment_reversals"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "unapplied_player_funds_bankTransferId_key" ON "unapplied_player_funds"("bankTransferId");

-- CreateIndex
CREATE INDEX "unapplied_player_funds_playerId_idx" ON "unapplied_player_funds"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "administrative_cash_deposits_transactionId_key" ON "administrative_cash_deposits"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "administrative_cash_deposits_idempotencyKey_key" ON "administrative_cash_deposits"("idempotencyKey");

-- CreateIndex
CREATE INDEX "administrative_cash_deposits_custodianUserId_createdAt_idx" ON "administrative_cash_deposits"("custodianUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "receivable_payment_receipts_paymentId_key" ON "receivable_payment_receipts"("paymentId");

-- AddForeignKey
ALTER TABLE "receivable_payments" ADD CONSTRAINT "receivable_payments_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_payments" ADD CONSTRAINT "receivable_payments_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "poker_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_payments" ADD CONSTRAINT "receivable_payments_financialTransactionId_fkey" FOREIGN KEY ("financialTransactionId") REFERENCES "cash_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_payments" ADD CONSTRAINT "receivable_payments_bankTransferId_fkey" FOREIGN KEY ("bankTransferId") REFERENCES "bank_transfer_verifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_payments" ADD CONSTRAINT "receivable_payments_custodianUserId_fkey" FOREIGN KEY ("custodianUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_payments" ADD CONSTRAINT "receivable_payments_cardSettlementId_fkey" FOREIGN KEY ("cardSettlementId") REFERENCES "card_terminal_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_payments" ADD CONSTRAINT "receivable_payments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_payments" ADD CONSTRAINT "receivable_payments_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_receivableId_fkey" FOREIGN KEY ("receivableId") REFERENCES "player_debts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_receivablePaymentId_fkey" FOREIGN KEY ("receivablePaymentId") REFERENCES "receivable_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_purchasePaymentId_fkey" FOREIGN KEY ("purchasePaymentId") REFERENCES "purchase_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_reversesAllocationId_fkey" FOREIGN KEY ("reversesAllocationId") REFERENCES "payment_allocations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_payment_reversals" ADD CONSTRAINT "receivable_payment_reversals_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "receivable_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_payment_reversals" ADD CONSTRAINT "receivable_payment_reversals_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "cash_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_payment_reversals" ADD CONSTRAINT "receivable_payment_reversals_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unapplied_player_funds" ADD CONSTRAINT "unapplied_player_funds_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unapplied_player_funds" ADD CONSTRAINT "unapplied_player_funds_bankTransferId_fkey" FOREIGN KEY ("bankTransferId") REFERENCES "bank_transfer_verifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unapplied_player_funds" ADD CONSTRAINT "unapplied_player_funds_receivablePaymentId_fkey" FOREIGN KEY ("receivablePaymentId") REFERENCES "receivable_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unapplied_player_funds" ADD CONSTRAINT "unapplied_player_funds_purchasePaymentId_fkey" FOREIGN KEY ("purchasePaymentId") REFERENCES "purchase_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unapplied_player_funds" ADD CONSTRAINT "unapplied_player_funds_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "administrative_cash_deposits" ADD CONSTRAINT "administrative_cash_deposits_custodianUserId_fkey" FOREIGN KEY ("custodianUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "administrative_cash_deposits" ADD CONSTRAINT "administrative_cash_deposits_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "cash_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "administrative_cash_deposits" ADD CONSTRAINT "administrative_cash_deposits_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_payment_receipts" ADD CONSTRAINT "receivable_payment_receipts_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "receivable_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_payment_receipts" ADD CONSTRAINT "receivable_payment_receipts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════════
-- Integridad de cuentas por cobrar (última defensa; los servicios validan)
-- ═══════════════════════════════════════════════════════════════════════

-- ── Abonos ──────────────────────────────────────────────────────────────
ALTER TABLE "receivable_payments" ADD CONSTRAINT "receivable_payments_valid"
  CHECK ("amount" > 0
    AND (("origin" = 'SESSION') = ("sessionId" IS NOT NULL))
    AND ("method" <> 'BANK_TRANSFER' OR "bankTransferId" IS NOT NULL)
    AND ("method" = 'BANK_TRANSFER' OR "bankTransferId" IS NULL)
    AND (("method" = 'CASH' AND "origin" = 'ADMINISTRATIVE') = ("custodianUserId" IS NOT NULL))
    AND ("method" NOT IN ('CARD_DEBIT', 'CARD_CREDIT') OR "status" = 'REJECTED' OR "terminalReference" IS NOT NULL)
    AND ("status" NOT IN ('CONFIRMED', 'REVERSED') OR ("confirmedAt" IS NOT NULL AND "financialTransactionId" IS NOT NULL))
    AND ("cardSettlementId" IS NULL OR "method" IN ('CARD_DEBIT', 'CARD_CREDIT')));

CREATE FUNCTION "receivable_payments_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'receivable_payments no admite DELETE (historial)';
  END IF;
  IF NEW."folio" IS DISTINCT FROM OLD."folio"
     OR NEW."playerId" IS DISTINCT FROM OLD."playerId"
     OR NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."method" IS DISTINCT FROM OLD."method"
     OR NEW."origin" IS DISTINCT FROM OLD."origin"
     OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId"
     OR NEW."bankTransferId" IS DISTINCT FROM OLD."bankTransferId"
     OR NEW."custodianUserId" IS DISTINCT FROM OLD."custodianUserId"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" THEN
    RAISE EXCEPTION 'Jugador, importe, método, origen y folio de un abono son inmutables';
  END IF;
  IF OLD."financialTransactionId" IS NOT NULL
     AND NEW."financialTransactionId" IS DISTINCT FROM OLD."financialTransactionId" THEN
    RAISE EXCEPTION 'El asiento de un abono no cambia';
  END IF;
  IF OLD."cardSettlementId" IS NOT NULL AND NEW."cardSettlementId" IS DISTINCT FROM OLD."cardSettlementId" THEN
    RAISE EXCEPTION 'Un cobro de terminal se liquida una sola vez';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'PENDING' AND NEW."status" IN ('CONFIRMED', 'REJECTED'))
    OR (OLD."status" = 'CONFIRMED' AND NEW."status" = 'REVERSED')
  ) THEN
    RAISE EXCEPTION 'Transición de abono no permitida: % → %', OLD."status", NEW."status";
  END IF;
  IF OLD."status" IN ('REJECTED', 'REVERSED') THEN
    RAISE EXCEPTION 'Un abono rechazado o revertido es inmutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "receivable_payments_guard" BEFORE UPDATE OR DELETE ON "receivable_payments"
  FOR EACH ROW EXECUTE FUNCTION "receivable_payments_guard"();

-- ── Aplicaciones (libro inmutable) ──────────────────────────────────────
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_valid"
  CHECK ("amount" > 0 AND "allocationOrder" >= 1
    AND (("kind" = 'REVERSAL') = ("reversesAllocationId" IS NOT NULL))
    AND (("source" = 'RECEIVABLE_PAYMENT') = ("receivablePaymentId" IS NOT NULL))
    AND (("source" = 'PURCHASE_PAYMENT') = ("purchasePaymentId" IS NOT NULL))
    AND (("source" = 'CHIP_SETTLEMENT_OFFSET') = ("settlementId" IS NOT NULL)));

CREATE FUNCTION "payment_allocations_guard"() RETURNS trigger AS $$
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
  SELECT "playerId", "originalAmount" INTO debt FROM "player_debts" WHERE "id" = NEW."receivableId";
  IF debt."playerId" IS DISTINCT FROM NEW."playerId" THEN
    RAISE EXCEPTION 'La aplicación y la deuda deben ser del mismo jugador';
  END IF;
  IF NEW."kind" = 'REVERSAL' THEN
    SELECT * INTO orig FROM "payment_allocations" WHERE "id" = NEW."reversesAllocationId";
    IF orig."kind" <> 'APPLICATION' OR orig."receivableId" <> NEW."receivableId"
       OR orig."amount" <> NEW."amount" OR orig."source" <> NEW."source" THEN
      RAISE EXCEPTION 'Un reverso debe espejar exactamente su aplicación original';
    END IF;
  END IF;
  -- Saldo aplicado neto de la deuda: nunca mayor que el original ni negativo.
  SELECT COALESCE(SUM(CASE WHEN "kind" = 'APPLICATION' THEN "amount" ELSE -"amount" END), 0)
    INTO net FROM "payment_allocations" WHERE "receivableId" = NEW."receivableId";
  net := net + CASE WHEN NEW."kind" = 'APPLICATION' THEN NEW."amount" ELSE -NEW."amount" END;
  IF net > debt."originalAmount" OR net < 0 THEN
    RAISE EXCEPTION 'La aplicación excede la deuda (aplicado %, original %)', net, debt."originalAmount";
  END IF;
  -- Un abono nunca se aplica por más de su importe.
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
CREATE TRIGGER "payment_allocations_guard" BEFORE INSERT OR UPDATE OR DELETE ON "payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION "payment_allocations_guard"();

-- ── Reversos, fondos no aplicados y depósitos de custodia: solo inserción ──
ALTER TABLE "unapplied_player_funds" ADD CONSTRAINT "unapplied_player_funds_amount_positive"
  CHECK ("amount" > 0 AND ("receivablePaymentId" IS NOT NULL OR "purchasePaymentId" IS NOT NULL));
ALTER TABLE "administrative_cash_deposits" ADD CONSTRAINT "administrative_cash_deposits_amount_positive"
  CHECK ("amount" > 0);

CREATE FUNCTION "credits_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% es de solo inserción (%)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "receivable_payment_reversals_immutable" BEFORE UPDATE OR DELETE ON "receivable_payment_reversals"
  FOR EACH ROW EXECUTE FUNCTION "credits_append_only"();
CREATE TRIGGER "unapplied_player_funds_immutable" BEFORE UPDATE OR DELETE ON "unapplied_player_funds"
  FOR EACH ROW EXECUTE FUNCTION "credits_append_only"();
CREATE TRIGGER "administrative_cash_deposits_immutable" BEFORE UPDATE OR DELETE ON "administrative_cash_deposits"
  FOR EACH ROW EXECUTE FUNCTION "credits_append_only"();

-- ── Comprobantes de abono: solo de abonos CONFIRMED; contenido inmutable ──
ALTER TABLE "receivable_payment_receipts" ADD CONSTRAINT "receivable_payment_receipts_void_complete"
  CHECK (("status" = 'AVAILABLE') = ("voidedAt" IS NULL)
         AND ("status" = 'AVAILABLE' OR "voidReason" IS NOT NULL));
CREATE FUNCTION "receivable_payment_receipts_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'AVAILABLE' OR NOT EXISTS (
      SELECT 1 FROM "receivable_payments" p WHERE p."id" = NEW."paymentId" AND p."status" = 'CONFIRMED'
    ) THEN
      RAISE EXCEPTION 'Solo un abono CONFIRMED tiene comprobante disponible';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'receivable_payment_receipts no admite DELETE (historial)';
  END IF;
  IF OLD."status" <> 'AVAILABLE' OR NEW."status" <> 'VOIDED'
     OR (to_jsonb(NEW) - ARRAY['status', 'voidedAt', 'voidReason'])
        <> (to_jsonb(OLD) - ARRAY['status', 'voidedAt', 'voidReason']) THEN
    RAISE EXCEPTION 'Un comprobante de abono solo pasa de AVAILABLE a VOIDED; su contenido es inmutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "receivable_payment_receipts_guard" BEFORE INSERT OR UPDATE OR DELETE ON "receivable_payment_receipts"
  FOR EACH ROW EXECUTE FUNCTION "receivable_payment_receipts_guard"();
