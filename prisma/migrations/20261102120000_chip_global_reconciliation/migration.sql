-- Corrección transversal: conciliación GLOBAL de fichas de la sesión.
-- Ver docs/CHIP_GLOBAL_RECONCILIATION.md. Solo agrega una tabla de hechos
-- autorizados; NO modifica datos existentes ni sesiones cerradas.

-- CreateEnum
CREATE TYPE "SessionChipReconciliationKind" AS ENUM ('RETURN_IDENTIFIED_IN_COUNT', 'UNRECOVERED_AUTHORIZED');

-- CreateTable
CREATE TABLE "session_chip_reconciliations" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "closureId" TEXT NOT NULL,
    "kind" "SessionChipReconciliationKind" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "chipStockCountId" TEXT,
    "chipOperationId" TEXT,
    "authorizedById" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_chip_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "session_chip_reconciliations_chipOperationId_key" ON "session_chip_reconciliations"("chipOperationId");

-- CreateIndex
CREATE UNIQUE INDEX "session_chip_reconciliations_idempotencyKey_key" ON "session_chip_reconciliations"("idempotencyKey");

-- CreateIndex
CREATE INDEX "session_chip_reconciliations_sessionId_idx" ON "session_chip_reconciliations"("sessionId");

-- AddForeignKey
ALTER TABLE "session_chip_reconciliations" ADD CONSTRAINT "session_chip_reconciliations_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "poker_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_chip_reconciliations" ADD CONSTRAINT "session_chip_reconciliations_closureId_fkey" FOREIGN KEY ("closureId") REFERENCES "session_closures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_chip_reconciliations" ADD CONSTRAINT "session_chip_reconciliations_authorizedById_fkey" FOREIGN KEY ("authorizedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Guardas: importe positivo, retorno identificado ⇔ entrada nominal y arqueo.
ALTER TABLE "session_chip_reconciliations" ADD CONSTRAINT "session_chip_reconciliations_valid"
  CHECK ("amount" > 0 AND length(trim("reason")) >= 10
    AND (("kind" = 'RETURN_IDENTIFIED_IN_COUNT') = ("chipOperationId" IS NOT NULL))
    AND ("kind" <> 'RETURN_IDENTIFIED_IN_COUNT' OR "chipStockCountId" IS NOT NULL));
ALTER TABLE "session_chip_reconciliations" ADD CONSTRAINT "session_chip_reconciliations_chipOperationId_fkey"
  FOREIGN KEY ("chipOperationId") REFERENCES "chip_inventory_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Hechos: SOLO INSERCIÓN.
CREATE TRIGGER "session_chip_reconciliations_append_only" BEFORE UPDATE OR DELETE ON "session_chip_reconciliations"
  FOR EACH ROW EXECUTE FUNCTION "m15_append_only"();
