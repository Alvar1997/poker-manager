-- Asistente de cierre en 6 pasos: progreso por sesión (paso actual, borradores de motivos y
-- revisión del conteo del staff) y motivo de la diferencia física. Solo agrega; no cambia datos.

-- AlterTable
ALTER TABLE "session_chip_differences" ADD COLUMN     "physicalReason" TEXT;

-- CreateTable
CREATE TABLE "session_closure_progress" (
    "sessionId" TEXT NOT NULL,
    "currentStep" INTEGER NOT NULL DEFAULT 1,
    "nominalReasonDraft" TEXT,
    "physicalReasonDraft" TEXT,
    "tipsReviewedAt" TIMESTAMP(3),
    "tipsReviewedById" TEXT,
    "tipsReviewFingerprint" TEXT,
    "updatedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_closure_progress_pkey" PRIMARY KEY ("sessionId")
);

-- AddForeignKey
ALTER TABLE "session_closure_progress" ADD CONSTRAINT "session_closure_progress_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "poker_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_closure_progress" ADD CONSTRAINT "session_closure_progress_tipsReviewedById_fkey" FOREIGN KEY ("tipsReviewedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_closure_progress" ADD CONSTRAINT "session_closure_progress_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "session_closure_progress" ADD CONSTRAINT "session_closure_progress_step_valid"
  CHECK ("currentStep" BETWEEN 1 AND 6);
ALTER TABLE "session_closure_progress" ADD CONSTRAINT "session_closure_progress_review_valid"
  CHECK (("tipsReviewedAt" IS NULL) = ("tipsReviewedById" IS NULL)
     AND ("tipsReviewedAt" IS NULL) = ("tipsReviewFingerprint" IS NULL));

-- Una sesión CERRADA no admite cambios en su progreso de cierre.
CREATE FUNCTION "session_closure_progress_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'El progreso del cierre no se borra' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT "status" FROM "poker_sessions" WHERE "id" = NEW."sessionId") NOT IN ('OPEN', 'CLOSING') THEN
    RAISE EXCEPTION 'La sesión no está abierta ni en cierre: su progreso de cierre es inmutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "session_closure_progress_guard" BEFORE INSERT OR UPDATE OR DELETE ON "session_closure_progress"
  FOR EACH ROW EXECUTE FUNCTION "session_closure_progress_guard"();
