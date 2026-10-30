-- Asistente de apertura en 4 pasos: progreso de la preparación (paso actual, decisión
-- «continuar sin mesas») y plan de mesas a abrir al confirmar. Solo agrega; no cambia datos.
-- CreateTable
CREATE TABLE "session_opening_progress" (
    "sessionId" TEXT NOT NULL,
    "currentStep" INTEGER NOT NULL DEFAULT 1,
    "noTablesConfirmedAt" TIMESTAMP(3),
    "noTablesConfirmedById" TEXT,
    "updatedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_opening_progress_pkey" PRIMARY KEY ("sessionId")
);

-- CreateTable
CREATE TABLE "session_opening_tables" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "addedById" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "removedById" TEXT,

    CONSTRAINT "session_opening_tables_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "session_opening_tables_sessionId_idx" ON "session_opening_tables"("sessionId");

-- AddForeignKey
ALTER TABLE "session_opening_progress" ADD CONSTRAINT "session_opening_progress_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "poker_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_opening_progress" ADD CONSTRAINT "session_opening_progress_noTablesConfirmedById_fkey" FOREIGN KEY ("noTablesConfirmedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_opening_progress" ADD CONSTRAINT "session_opening_progress_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_opening_tables" ADD CONSTRAINT "session_opening_tables_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "poker_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_opening_tables" ADD CONSTRAINT "session_opening_tables_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "poker_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_opening_tables" ADD CONSTRAINT "session_opening_tables_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_opening_tables" ADD CONSTRAINT "session_opening_tables_removedById_fkey" FOREIGN KEY ("removedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "session_opening_progress" ADD CONSTRAINT "session_opening_progress_step_valid"
  CHECK ("currentStep" BETWEEN 1 AND 4);
ALTER TABLE "session_opening_progress" ADD CONSTRAINT "session_opening_progress_no_tables_valid"
  CHECK (("noTablesConfirmedAt" IS NULL) = ("noTablesConfirmedById" IS NULL));
ALTER TABLE "session_opening_tables" ADD CONSTRAINT "session_opening_tables_removal_valid"
  CHECK (("removedAt" IS NULL) = ("removedById" IS NULL));

-- Una mesa del catálogo como máximo una vez (vigente) en el plan de la sesión.
CREATE UNIQUE INDEX "session_opening_tables_one_planned"
  ON "session_opening_tables"("sessionId", "tableId") WHERE "removedAt" IS NULL;

-- El progreso y el plan solo cambian mientras la sesión se prepara; nada se borra.
CREATE FUNCTION "session_opening_progress_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'El progreso de la apertura no se borra' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT "status" FROM "poker_sessions" WHERE "id" = NEW."sessionId") NOT IN ('DRAFT', 'PREPARATION') THEN
    RAISE EXCEPTION 'La sesión ya no está en preparación: su progreso de apertura es inmutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "session_opening_progress_guard" BEFORE INSERT OR UPDATE OR DELETE ON "session_opening_progress"
  FOR EACH ROW EXECUTE FUNCTION "session_opening_progress_guard"();

CREATE FUNCTION "session_opening_tables_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'El plan de mesas no se borra (se quita de la preparación)' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT "status" FROM "poker_sessions" WHERE "id" = NEW."sessionId") <> 'PREPARATION' THEN
    RAISE EXCEPTION 'Las mesas solo se preparan con la sesión en preparación'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."removedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Una mesa se agrega al plan sin retiro' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (
       OLD."removedAt" IS NOT NULL
    OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId"
    OR NEW."tableId" IS DISTINCT FROM OLD."tableId"
    OR NEW."addedById" IS DISTINCT FROM OLD."addedById"
    OR NEW."addedAt" IS DISTINCT FROM OLD."addedAt"
  ) THEN
    RAISE EXCEPTION 'Una mesa del plan solo admite quitarse una vez' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "session_opening_tables_guard" BEFORE INSERT OR UPDATE OR DELETE ON "session_opening_tables"
  FOR EACH ROW EXECUTE FUNCTION "session_opening_tables_guard"();
