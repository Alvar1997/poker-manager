-- Sesiones de fecha anterior con operación completa (decisión del propietario,
-- 2026-10-29). La casilla «Registrar sesión de fecha anterior» crea una
-- sesión con la fecha operativa pasada que sigue el ciclo NORMAL
-- (DRAFT → PREPARATION → OPEN → CLOSING → CLOSED): ocupa la sesión vigente,
-- tiene caja $0, arqueos, mesas, compras, firmas y cierre como cualquier
-- otra. `isHistorical` + datos de captura siguen marcando que se capturó
-- después. Las sesiones ya registradas en estado HISTORICAL (solo folio y
-- fecha) no cambian: solo admiten CANCELLED.
-- No modifica datos existentes.

ALTER TABLE "poker_sessions" DROP CONSTRAINT IF EXISTS "poker_sessions_historical_valid";
ALTER TABLE "poker_sessions" ADD CONSTRAINT "poker_sessions_historical_valid"
  CHECK (
    ("isHistorical" = ("historicalRecordedAt" IS NOT NULL))
    AND ("isHistorical" = ("historicalRecordedById" IS NOT NULL))
    AND ("status" <> 'HISTORICAL' OR "isHistorical")
  );

-- Una sesión nace en DRAFT (normal o de fecha anterior). HISTORICAL queda
-- solo para los registros anteriores a este cambio.
CREATE OR REPLACE FUNCTION "poker_sessions_insert_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'Una sesión se crea en DRAFT';
  END IF;
  IF NEW."openedAt" IS NOT NULL OR NEW."closedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Una sesión nueva no lleva horas de apertura o cierre';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Jornada histórica: horas OPERATIVAS de apertura y cierre (las elige
-- SUPERADMIN). Las fechas reales (`createdAt`, `openedAt`, `closedAt`) no
-- cambian de significado ni se falsifican.
ALTER TABLE "poker_sessions"
  ADD COLUMN IF NOT EXISTS "operatedOpenedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "operatedClosedAt" TIMESTAMP(3);

ALTER TABLE "poker_sessions" DROP CONSTRAINT IF EXISTS "poker_sessions_operated_times_valid";
ALTER TABLE "poker_sessions" ADD CONSTRAINT "poker_sessions_operated_times_valid"
  CHECK (
    ("operatedOpenedAt" IS NULL OR "isHistorical")
    AND ("operatedClosedAt" IS NULL OR ("isHistorical" AND "status" = 'CLOSED'))
    AND ("operatedClosedAt" IS NULL OR "operatedOpenedAt" IS NULL
         OR "operatedClosedAt" > "operatedOpenedAt")
    -- Una jornada histórica viva (no un registro HISTORICAL anterior ni
    -- cancelada) siempre tiene hora operativa de apertura.
    AND (NOT "isHistorical" OR "status" IN ('HISTORICAL', 'CANCELLED')
         OR "operatedOpenedAt" IS NOT NULL)
    -- Una jornada histórica cerrada siempre tiene hora operativa de cierre.
    AND (NOT "isHistorical" OR "status" <> 'CLOSED' OR "operatedClosedAt" IS NOT NULL)
  );

-- La hora operativa de apertura solo cambia mientras la jornada se prepara;
-- la de cierre se fija una vez.
CREATE OR REPLACE FUNCTION "poker_sessions_operated_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW."operatedOpenedAt" IS DISTINCT FROM OLD."operatedOpenedAt"
     AND OLD."status" NOT IN ('DRAFT', 'PREPARATION') THEN
    RAISE EXCEPTION 'La hora operativa de apertura solo cambia mientras la jornada se prepara';
  END IF;
  IF OLD."operatedClosedAt" IS NOT NULL
     AND NEW."operatedClosedAt" IS DISTINCT FROM OLD."operatedClosedAt" THEN
    RAISE EXCEPTION 'La hora operativa de cierre es inmutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "poker_sessions_operated_guard" ON "poker_sessions";
CREATE TRIGGER "poker_sessions_operated_guard" BEFORE UPDATE ON "poker_sessions"
  FOR EACH ROW EXECUTE FUNCTION "poker_sessions_operated_guard"();
