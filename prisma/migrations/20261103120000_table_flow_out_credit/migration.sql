-- Flujo de mesa: OUT, modalidad de pago y compra inicial/recompra POR MESA.
-- No modifica datos existentes ni sesiones cerradas.

-- CreateEnum
CREATE TYPE "PurchasePaymentMode" AS ENUM ('CASH', 'BANK_TRANSFER', 'CARD', 'CREDIT', 'MIXED');

-- CreateEnum
CREATE TYPE "SettlementExitKind" AS ENUM ('CASHOUT', 'OUT');

-- AlterTable
ALTER TABLE "chip_purchases" ADD COLUMN     "paymentMode" "PurchasePaymentMode";

-- AlterTable
ALTER TABLE "player_settlements" ADD COLUMN     "exitKind" "SettlementExitKind" NOT NULL DEFAULT 'CASHOUT',
ADD COLUMN     "zeroReturnConfirmed" BOOLEAN NOT NULL DEFAULT false;

-- Compra inicial / recompra se decide por MESA (jugador + sesión + mesa) y por
-- la cadena de transferencias; el consecutivo por (sesión, jugador) sigue
-- siendo único y en orden real. Las filas existentes cumplen la regla nueva.
ALTER TABLE "chip_purchases" DROP CONSTRAINT IF EXISTS "chip_purchases_numbering_valid";
ALTER TABLE "chip_purchases" ADD CONSTRAINT "chip_purchases_numbering_valid"
  CHECK (
    ("sequenceNumber" IS NULL AND "purchaseType" IS NULL AND "rebuyNumber" IS NULL)
    OR ("sequenceNumber" >= 1 AND "purchaseType" = 'INITIAL_PURCHASE' AND "rebuyNumber" IS NULL)
    OR ("sequenceNumber" > 1 AND "purchaseType" = 'REBUY' AND "rebuyNumber" >= 1 AND "rebuyNumber" < "sequenceNumber")
  );

-- OUT: siempre retorno $0 sin compensación.
ALTER TABLE "player_settlements" ADD CONSTRAINT "player_settlements_out_valid"
  CHECK ("exitKind" <> 'OUT' OR ("returnedNominalAmount" = 0 AND "offsetDecision" = 'NO_COMPENSATE'));

-- Al RECIBIR (receivedAt pasa a tener valor) un retorno de $0 exige la
-- confirmación EXPLÍCITA guardada; nunca se asume por falta de registro.
-- Solo se evalúa en esa transición: las liquidaciones anteriores no cambian.
CREATE FUNCTION "player_settlements_zero_return_explicit"() RETURNS trigger AS $$
BEGIN
  IF OLD."receivedAt" IS NULL AND NEW."receivedAt" IS NOT NULL
     AND NEW."returnedNominalAmount" = 0 AND NEW."zeroReturnConfirmed" IS NOT TRUE THEN
    RAISE EXCEPTION 'Un retorno de $0 requiere la confirmación explícita de que el jugador terminó sin fichas'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."receivedAt" IS NOT NULL AND (NEW."zeroReturnConfirmed" IS DISTINCT FROM OLD."zeroReturnConfirmed"
     OR NEW."exitKind" IS DISTINCT FROM OLD."exitKind") THEN
    RAISE EXCEPTION 'La confirmación de retorno y el tipo de salida son inmutables tras la recepción'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "player_settlements_zero_return_explicit" BEFORE UPDATE ON "player_settlements"
  FOR EACH ROW EXECUTE FUNCTION "player_settlements_zero_return_explicit"();
