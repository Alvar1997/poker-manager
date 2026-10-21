-- Módulo 08 (2/2): compras y recompras por IMPORTE NOMINAL.
-- Aditiva: solo crea tablas nuevas; no toca datos existentes, no crea
-- compras, pagos, deudas ni movimientos. Ver docs/MODULE_08_PURCHASES.md.

-- CreateEnum
CREATE TYPE "ChipPurchaseStatus" AS ENUM ('DRAFT', 'READY_FOR_DELIVERY', 'CONFIRMED', 'CANCELLED', 'REVERSED');

-- CreateEnum
CREATE TYPE "ChipPurchaseType" AS ENUM ('INITIAL_PURCHASE', 'REBUY');

-- CreateEnum
CREATE TYPE "PurchasePaymentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'APPROVED', 'DECLINED', 'VOIDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CreditAuthorizationChannel" AS ENUM ('VERBAL', 'MESSAGE');

-- CreateEnum
CREATE TYPE "CreditAuthorizationStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'USED');

-- CreateEnum
CREATE TYPE "PurchaseReversalStatus" AS ENUM ('REQUESTED');

-- CreateEnum
CREATE TYPE "NotificationEventType" AS ENUM ('PURCHASE_CREDIT_CONFIRMED');

-- CreateEnum
CREATE TYPE "NotificationOutboxStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "CardSettlementStatus" AS ENUM ('RECONCILED', 'DIFFERENCE_PENDING');

-- CreateTable
CREATE TABLE "chip_purchases" (
    "id" TEXT NOT NULL,
    "folio" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sessionTableId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "participationId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "nominalAmount" DECIMAL(14,2) NOT NULL,
    "status" "ChipPurchaseStatus" NOT NULL DEFAULT 'DRAFT',
    "purchaseType" "ChipPurchaseType",
    "sequenceNumber" INTEGER,
    "rebuyNumber" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "reservationId" TEXT,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chip_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_payments" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "method" "PaymentMethodCode" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" "PurchasePaymentStatus" NOT NULL,
    "terminalReference" TEXT,
    "terminalIdentifier" TEXT,
    "externalReference" TEXT,
    "bankTransferId" TEXT,
    "financialTransactionId" TEXT,
    "cardSettlementId" TEXT,
    "resolutionNotes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_credit_authorizations" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "authorizedByPartnerId" TEXT NOT NULL,
    "partnerNameSnapshot" TEXT NOT NULL,
    "authorizationChannel" "CreditAuthorizationChannel" NOT NULL,
    "authorizedCreditAmount" DECIMAL(14,2) NOT NULL,
    "purchaseVersion" INTEGER NOT NULL,
    "notes" TEXT,
    "status" "CreditAuthorizationStatus" NOT NULL DEFAULT 'ACTIVE',
    "recordedById" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "purchase_credit_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_deliveries" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "nominalAmount" DECIMAL(14,2) NOT NULL,
    "inventoryOperationId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "confirmedPayments" DECIMAL(14,2) NOT NULL,
    "pendingTransfers" DECIMAL(14,2) NOT NULL,
    "outstandingAmount" DECIMAL(14,2) NOT NULL,
    "summaryVersion" INTEGER NOT NULL,
    "summaryHash" TEXT NOT NULL,
    "signatureId" TEXT,
    "deliveredById" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "purchase_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_status_history" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "fromStatus" "ChipPurchaseStatus",
    "toStatus" "ChipPurchaseStatus" NOT NULL,
    "changedById" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,

    CONSTRAINT "purchase_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_reversal_requests" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "PurchaseReversalStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "purchase_reversal_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_debts" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "authorizationId" TEXT NOT NULL,
    "originalAmount" DECIMAL(14,2) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_debts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_outbox" (
    "id" TEXT NOT NULL,
    "eventType" "NotificationEventType" NOT NULL,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'WHATSAPP',
    "playerId" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "NotificationOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "dedupeKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_terminal_settlements" (
    "id" TEXT NOT NULL,
    "grossAmount" DECIMAL(14,2) NOT NULL,
    "depositedAmount" DECIMAL(14,2) NOT NULL,
    "pendingDifference" DECIMAL(14,2) NOT NULL,
    "status" "CardSettlementStatus" NOT NULL,
    "bankReference" TEXT,
    "notes" TEXT,
    "transactionId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "card_terminal_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chip_purchases_folio_key" ON "chip_purchases"("folio");

-- CreateIndex
CREATE UNIQUE INDEX "chip_purchases_reservationId_key" ON "chip_purchases"("reservationId");

-- CreateIndex
CREATE UNIQUE INDEX "chip_purchases_idempotencyKey_key" ON "chip_purchases"("idempotencyKey");

-- CreateIndex
CREATE INDEX "chip_purchases_sessionId_createdAt_idx" ON "chip_purchases"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "chip_purchases_sessionTableId_createdAt_idx" ON "chip_purchases"("sessionTableId", "createdAt");

-- CreateIndex
CREATE INDEX "chip_purchases_playerId_createdAt_idx" ON "chip_purchases"("playerId", "createdAt");

-- CreateIndex
CREATE INDEX "chip_purchases_status_idx" ON "chip_purchases"("status");

-- CreateIndex
CREATE INDEX "chip_purchases_createdById_idx" ON "chip_purchases"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_payments_bankTransferId_key" ON "purchase_payments"("bankTransferId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_payments_financialTransactionId_key" ON "purchase_payments"("financialTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_payments_idempotencyKey_key" ON "purchase_payments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "purchase_payments_purchaseId_idx" ON "purchase_payments"("purchaseId");

-- CreateIndex
CREATE INDEX "purchase_payments_method_status_idx" ON "purchase_payments"("method", "status");

-- CreateIndex
CREATE INDEX "purchase_payments_cardSettlementId_idx" ON "purchase_payments"("cardSettlementId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_credit_authorizations_idempotencyKey_key" ON "purchase_credit_authorizations"("idempotencyKey");

-- CreateIndex
CREATE INDEX "purchase_credit_authorizations_purchaseId_status_idx" ON "purchase_credit_authorizations"("purchaseId", "status");

-- CreateIndex
CREATE INDEX "purchase_credit_authorizations_authorizedByPartnerId_idx" ON "purchase_credit_authorizations"("authorizedByPartnerId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_deliveries_purchaseId_key" ON "purchase_deliveries"("purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_deliveries_inventoryOperationId_key" ON "purchase_deliveries"("inventoryOperationId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_deliveries_reservationId_key" ON "purchase_deliveries"("reservationId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_deliveries_signatureId_key" ON "purchase_deliveries"("signatureId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_deliveries_idempotencyKey_key" ON "purchase_deliveries"("idempotencyKey");

-- CreateIndex
CREATE INDEX "purchase_status_history_purchaseId_changedAt_idx" ON "purchase_status_history"("purchaseId", "changedAt");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_reversal_requests_idempotencyKey_key" ON "purchase_reversal_requests"("idempotencyKey");

-- CreateIndex
CREATE INDEX "purchase_reversal_requests_purchaseId_idx" ON "purchase_reversal_requests"("purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "player_debts_purchaseId_key" ON "player_debts"("purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "player_debts_authorizationId_key" ON "player_debts"("authorizationId");

-- CreateIndex
CREATE INDEX "player_debts_playerId_createdAt_idx" ON "player_debts"("playerId", "createdAt");

-- CreateIndex
CREATE INDEX "player_debts_sessionId_idx" ON "player_debts"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_outbox_dedupeKey_key" ON "notification_outbox"("dedupeKey");

-- CreateIndex
CREATE INDEX "notification_outbox_status_createdAt_idx" ON "notification_outbox"("status", "createdAt");

-- CreateIndex
CREATE INDEX "notification_outbox_aggregateType_aggregateId_idx" ON "notification_outbox"("aggregateType", "aggregateId");

-- CreateIndex
CREATE UNIQUE INDEX "card_terminal_settlements_transactionId_key" ON "card_terminal_settlements"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "card_terminal_settlements_idempotencyKey_key" ON "card_terminal_settlements"("idempotencyKey");

-- CreateIndex
CREATE INDEX "card_terminal_settlements_createdAt_idx" ON "card_terminal_settlements"("createdAt");

-- AddForeignKey
ALTER TABLE "chip_purchases" ADD CONSTRAINT "chip_purchases_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "poker_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_purchases" ADD CONSTRAINT "chip_purchases_sessionTableId_fkey" FOREIGN KEY ("sessionTableId") REFERENCES "session_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_purchases" ADD CONSTRAINT "chip_purchases_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "session_table_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_purchases" ADD CONSTRAINT "chip_purchases_participationId_fkey" FOREIGN KEY ("participationId") REFERENCES "table_participations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_purchases" ADD CONSTRAINT "chip_purchases_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_purchases" ADD CONSTRAINT "chip_purchases_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "poker_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_purchases" ADD CONSTRAINT "chip_purchases_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_purchases" ADD CONSTRAINT "chip_purchases_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chip_purchases" ADD CONSTRAINT "chip_purchases_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_payments" ADD CONSTRAINT "purchase_payments_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "chip_purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_payments" ADD CONSTRAINT "purchase_payments_bankTransferId_fkey" FOREIGN KEY ("bankTransferId") REFERENCES "bank_transfer_verifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_payments" ADD CONSTRAINT "purchase_payments_financialTransactionId_fkey" FOREIGN KEY ("financialTransactionId") REFERENCES "cash_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_payments" ADD CONSTRAINT "purchase_payments_cardSettlementId_fkey" FOREIGN KEY ("cardSettlementId") REFERENCES "card_terminal_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_payments" ADD CONSTRAINT "purchase_payments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_payments" ADD CONSTRAINT "purchase_payments_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_credit_authorizations" ADD CONSTRAINT "purchase_credit_authorizations_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "chip_purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_credit_authorizations" ADD CONSTRAINT "purchase_credit_authorizations_authorizedByPartnerId_fkey" FOREIGN KEY ("authorizedByPartnerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_credit_authorizations" ADD CONSTRAINT "purchase_credit_authorizations_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_deliveries" ADD CONSTRAINT "purchase_deliveries_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "chip_purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_deliveries" ADD CONSTRAINT "purchase_deliveries_deliveredById_fkey" FOREIGN KEY ("deliveredById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_status_history" ADD CONSTRAINT "purchase_status_history_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "chip_purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_status_history" ADD CONSTRAINT "purchase_status_history_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_reversal_requests" ADD CONSTRAINT "purchase_reversal_requests_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "chip_purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_reversal_requests" ADD CONSTRAINT "purchase_reversal_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_debts" ADD CONSTRAINT "player_debts_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_debts" ADD CONSTRAINT "player_debts_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "poker_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_debts" ADD CONSTRAINT "player_debts_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "chip_purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_debts" ADD CONSTRAINT "player_debts_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "purchase_credit_authorizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_debts" ADD CONSTRAINT "player_debts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_terminal_settlements" ADD CONSTRAINT "card_terminal_settlements_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "cash_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_terminal_settlements" ADD CONSTRAINT "card_terminal_settlements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════════
-- Integridad de negocio (última defensa; los servicios validan primero)
-- ═══════════════════════════════════════════════════════════════════════

-- ── Compras ─────────────────────────────────────────────────────────────
ALTER TABLE "chip_purchases" ADD CONSTRAINT "chip_purchases_amount_positive"
  CHECK ("nominalAmount" > 0 AND "version" >= 1);
-- Numeración: solo al confirmar; 1 = compra inicial; recompra n = secuencia − 1.
ALTER TABLE "chip_purchases" ADD CONSTRAINT "chip_purchases_numbering_valid"
  CHECK (
    ("sequenceNumber" IS NULL AND "purchaseType" IS NULL AND "rebuyNumber" IS NULL)
    OR ("sequenceNumber" = 1 AND "purchaseType" = 'INITIAL_PURCHASE' AND "rebuyNumber" IS NULL)
    OR ("sequenceNumber" > 1 AND "purchaseType" = 'REBUY' AND "rebuyNumber" = "sequenceNumber" - 1)
  );
ALTER TABLE "chip_purchases" ADD CONSTRAINT "chip_purchases_confirmed_complete"
  CHECK ("status" NOT IN ('CONFIRMED', 'REVERSED')
         OR ("sequenceNumber" IS NOT NULL AND "confirmedAt" IS NOT NULL AND "confirmedById" IS NOT NULL));
ALTER TABLE "chip_purchases" ADD CONSTRAINT "chip_purchases_cancelled_complete"
  CHECK ("status" <> 'CANCELLED'
         OR ("cancelledAt" IS NOT NULL AND "cancelledById" IS NOT NULL AND "cancellationReason" IS NOT NULL));
-- Recompras sin duplicados por (sesión, jugador), aunque cambie de mesa.
CREATE UNIQUE INDEX "chip_purchases_sequence_per_player"
  ON "chip_purchases" ("sessionId", "playerId", "sequenceNumber")
  WHERE "sequenceNumber" IS NOT NULL;

-- ── Pagos ───────────────────────────────────────────────────────────────
ALTER TABLE "purchase_payments" ADD CONSTRAINT "purchase_payments_amount_positive"
  CHECK ("amount" > 0);
ALTER TABLE "purchase_payments" ADD CONSTRAINT "purchase_payments_status_by_method"
  CHECK (
    ("method" = 'CASH' AND "status" IN ('CONFIRMED', 'CANCELLED'))
    OR ("method" IN ('CARD_DEBIT', 'CARD_CREDIT') AND "status" IN ('PENDING', 'APPROVED', 'DECLINED', 'VOIDED'))
    OR ("method" = 'BANK_TRANSFER' AND "status" IN ('PENDING', 'CANCELLED') AND "bankTransferId" IS NOT NULL)
  );
-- Una tarjeta aprobada exige la referencia de la terminal.
ALTER TABLE "purchase_payments" ADD CONSTRAINT "purchase_payments_card_reference"
  CHECK ("status" <> 'APPROVED' OR "terminalReference" IS NOT NULL);
-- Solo efectivo confirmado o tarjeta aprobada tienen asiento; solo tarjeta se liquida.
ALTER TABLE "purchase_payments" ADD CONSTRAINT "purchase_payments_posting_valid"
  CHECK (("financialTransactionId" IS NULL OR "status" IN ('CONFIRMED', 'APPROVED'))
         AND ("cardSettlementId" IS NULL OR ("method" IN ('CARD_DEBIT', 'CARD_CREDIT') AND "financialTransactionId" IS NOT NULL)));

-- ── Autorizaciones de crédito ───────────────────────────────────────────
ALTER TABLE "purchase_credit_authorizations" ADD CONSTRAINT "purchase_credit_auth_amount_positive"
  CHECK ("authorizedCreditAmount" > 0 AND "purchaseVersion" >= 1);
CREATE UNIQUE INDEX "purchase_credit_auth_one_active"
  ON "purchase_credit_authorizations" ("purchaseId") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "purchase_credit_auth_one_used"
  ON "purchase_credit_authorizations" ("purchaseId") WHERE "status" = 'USED';

-- ── Entregas: pagos + saldo = importe; con saldo por cobrar, firma obligatoria ──
ALTER TABLE "purchase_deliveries" ADD CONSTRAINT "purchase_deliveries_amounts_valid"
  CHECK ("nominalAmount" > 0 AND "confirmedPayments" >= 0 AND "pendingTransfers" >= 0
         AND "outstandingAmount" >= 0 AND "pendingTransfers" <= "outstandingAmount"
         AND "confirmedPayments" + "outstandingAmount" = "nominalAmount");
ALTER TABLE "purchase_deliveries" ADD CONSTRAINT "purchase_deliveries_credit_requires_signature"
  CHECK ("outstandingAmount" = 0 OR "signatureId" IS NOT NULL);

-- ── Deudas, reversos, depósitos de terminal ─────────────────────────────
ALTER TABLE "player_debts" ADD CONSTRAINT "player_debts_amount_positive"
  CHECK ("originalAmount" > 0);
CREATE UNIQUE INDEX "purchase_reversal_one_open"
  ON "purchase_reversal_requests" ("purchaseId") WHERE "status" = 'REQUESTED';
ALTER TABLE "card_terminal_settlements" ADD CONSTRAINT "card_settlements_amounts_valid"
  CHECK ("depositedAmount" > 0 AND "grossAmount" >= "depositedAmount"
         AND "pendingDifference" = "grossAmount" - "depositedAmount"
         AND (("status" = 'RECONCILED') = ("pendingDifference" = 0)));
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_attempts_valid"
  CHECK ("attempts" >= 0);

-- ── Inmutabilidad ───────────────────────────────────────────────────────
CREATE FUNCTION "purchases_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% es de solo inserción (%)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "purchase_deliveries_immutable" BEFORE UPDATE OR DELETE ON "purchase_deliveries"
  FOR EACH ROW EXECUTE FUNCTION "purchases_append_only"();
CREATE TRIGGER "purchase_status_history_immutable" BEFORE UPDATE OR DELETE ON "purchase_status_history"
  FOR EACH ROW EXECUTE FUNCTION "purchases_append_only"();
CREATE TRIGGER "purchase_reversal_requests_immutable" BEFORE UPDATE OR DELETE ON "purchase_reversal_requests"
  FOR EACH ROW EXECUTE FUNCTION "purchases_append_only"();
CREATE TRIGGER "player_debts_immutable" BEFORE UPDATE OR DELETE ON "player_debts"
  FOR EACH ROW EXECUTE FUNCTION "purchases_append_only"();
CREATE TRIGGER "card_terminal_settlements_immutable" BEFORE UPDATE OR DELETE ON "card_terminal_settlements"
  FOR EACH ROW EXECUTE FUNCTION "purchases_append_only"();

-- Compras: nacen en DRAFT; contexto inmutable; confirmadas/canceladas no cambian.
CREATE FUNCTION "chip_purchases_guard"() RETURNS trigger AS $$
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
    RAISE EXCEPTION 'Una compra confirmada es inmutable (el reverso es un procedimiento aparte)';
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
CREATE TRIGGER "chip_purchases_guard" BEFORE INSERT OR UPDATE OR DELETE ON "chip_purchases"
  FOR EACH ROW EXECUTE FUNCTION "chip_purchases_guard"();

-- Pagos: importe y método inmutables; solo transiciones válidas; un asiento
-- y una liquidación de terminal se fijan una sola vez.
CREATE FUNCTION "purchase_payments_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'purchase_payments no admite DELETE (historial)';
  END IF;
  IF NEW."purchaseId" IS DISTINCT FROM OLD."purchaseId"
     OR NEW."method" IS DISTINCT FROM OLD."method"
     OR NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
     OR NEW."bankTransferId" IS DISTINCT FROM OLD."bankTransferId" THEN
    RAISE EXCEPTION 'Método, importe y origen de un pago son inmutables';
  END IF;
  IF OLD."financialTransactionId" IS NOT NULL AND
     (NEW."financialTransactionId" IS DISTINCT FROM OLD."financialTransactionId"
      OR NEW."status" IS DISTINCT FROM OLD."status"
      OR NEW."terminalReference" IS DISTINCT FROM OLD."terminalReference") THEN
    RAISE EXCEPTION 'Un pago contabilizado es inmutable';
  END IF;
  IF OLD."cardSettlementId" IS NOT NULL AND NEW."cardSettlementId" IS DISTINCT FROM OLD."cardSettlementId" THEN
    RAISE EXCEPTION 'Un cobro de terminal se liquida una sola vez';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'CONFIRMED' AND NEW."status" = 'CANCELLED' AND OLD."method" = 'CASH')
    OR (OLD."status" = 'PENDING' AND NEW."status" IN ('APPROVED', 'DECLINED') AND OLD."method" IN ('CARD_DEBIT', 'CARD_CREDIT'))
    OR (OLD."status" = 'APPROVED' AND NEW."status" = 'VOIDED')
    OR (OLD."status" = 'PENDING' AND NEW."status" = 'CANCELLED' AND OLD."method" = 'BANK_TRANSFER')
  ) THEN
    RAISE EXCEPTION 'Transición de pago no permitida: % → %', OLD."status", NEW."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "purchase_payments_guard" BEFORE UPDATE OR DELETE ON "purchase_payments"
  FOR EACH ROW EXECUTE FUNCTION "purchase_payments_guard"();

-- Autorizaciones: solo cambia el estado (ACTIVE → SUPERSEDED / USED).
CREATE FUNCTION "purchase_credit_auth_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'purchase_credit_authorizations no admite DELETE (historial)';
  END IF;
  IF OLD."status" <> 'ACTIVE' OR NEW."status" NOT IN ('SUPERSEDED', 'USED') THEN
    RAISE EXCEPTION 'Una autorización de crédito solo pasa de vigente a reemplazada o usada';
  END IF;
  IF (to_jsonb(NEW) - 'status') <> (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'Los datos de una autorización de crédito son inmutables';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "purchase_credit_auth_guard" BEFORE UPDATE OR DELETE ON "purchase_credit_authorizations"
  FOR EACH ROW EXECUTE FUNCTION "purchase_credit_auth_guard"();

-- Outbox: el evento no cambia; solo su estado de procesamiento (Módulo 13).
CREATE FUNCTION "notification_outbox_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'notification_outbox no admite DELETE';
  END IF;
  IF NEW."eventType" IS DISTINCT FROM OLD."eventType"
     OR NEW."playerId" IS DISTINCT FROM OLD."playerId"
     OR NEW."aggregateType" IS DISTINCT FROM OLD."aggregateType"
     OR NEW."aggregateId" IS DISTINCT FROM OLD."aggregateId"
     OR NEW."payload" IS DISTINCT FROM OLD."payload"
     OR NEW."dedupeKey" IS DISTINCT FROM OLD."dedupeKey"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'El contenido de un evento de notificación es inmutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "notification_outbox_guard" BEFORE UPDATE OR DELETE ON "notification_outbox"
  FOR EACH ROW EXECUTE FUNCTION "notification_outbox_guard"();
