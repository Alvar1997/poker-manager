-- Folios de sesión S-0001-YYYYMMDD, fecha operativa y captura histórica.
--
-- Migración de datos SEGURA e IDEMPOTENTE:
-- - Conserva ids, relaciones, estados, fechas reales y todo lo financiero.
-- - El consecutivo se toma del folio anterior (SES-000001 → 1) cuando es
--   inequívoco; si no, se asigna después del mayor, por orden de creación.
-- - La fecha operativa de las sesiones existentes es el día local
--   (America/Monterrey) en que se crearon.
-- - El folio anterior queda en "previousFolio" y la equivalencia se audita
--   (SESSION_FOLIO_MIGRATED). Solo toca filas sin migrar: re-ejecutarla no
--   renumera nada. Los comprobantes y reportes de cierre guardados conservan
--   su texto original (inmutables).

-- 1) Columnas (nullable mientras se completan).
ALTER TABLE "poker_sessions"
  ADD COLUMN IF NOT EXISTS "sequenceNumber" INTEGER,
  ADD COLUMN IF NOT EXISTS "businessDate" DATE,
  ADD COLUMN IF NOT EXISTS "previousFolio" TEXT,
  ADD COLUMN IF NOT EXISTS "isHistorical" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "historicalRecordedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "historicalRecordedById" TEXT;

-- 2) Datos existentes (el guard impide cambiar el folio: se desactiva solo
--    dentro de esta migración y se vuelve a activar al final).
ALTER TABLE "poker_sessions" DISABLE TRIGGER "poker_sessions_guard";

WITH parsed AS (
  SELECT "id", "createdAt",
         ((regexp_match("folio", '^[A-Za-z]+-0*([0-9]{1,9})$'))[1])::int AS n
  FROM "poker_sessions"
  WHERE "sequenceNumber" IS NULL
), unique_n AS (
  SELECT p."id", p.n FROM parsed p
  WHERE p.n IS NOT NULL AND p.n > 0
    AND (SELECT count(*) FROM parsed q WHERE q.n = p.n) = 1
    AND NOT EXISTS (SELECT 1 FROM "poker_sessions" s WHERE s."sequenceNumber" = p.n)
), base AS (
  SELECT GREATEST(
    COALESCE((SELECT max(n) FROM unique_n), 0),
    COALESCE((SELECT max("sequenceNumber") FROM "poker_sessions"), 0)
  ) AS m
), rest AS (
  SELECT p."id", (SELECT m FROM base) + row_number() OVER (ORDER BY p."createdAt", p."id") AS n
  FROM parsed p WHERE p."id" NOT IN (SELECT "id" FROM unique_n)
), assigned AS (
  SELECT "id", n FROM unique_n UNION ALL SELECT "id", n FROM rest
)
UPDATE "poker_sessions" s SET "sequenceNumber" = a.n
FROM assigned a WHERE s."id" = a."id";

UPDATE "poker_sessions"
SET "businessDate" = (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Monterrey')::date
WHERE "businessDate" IS NULL;

-- Equivalencias antiguo → nuevo, auditadas antes de reescribir el folio.
INSERT INTO "audit_logs" ("id", "action", "entityType", "entityId", "metadata", "module", "sessionId", "result")
SELECT 'mig_' || md5(s."id" || ':session-folio'),
       'SESSION_FOLIO_MIGRATED', 'PokerSession', s."id",
       jsonb_build_object(
         'previousFolio', s."folio",
         'folio', 'S-' || CASE WHEN length(s."sequenceNumber"::text) >= 4 THEN s."sequenceNumber"::text
                               ELSE lpad(s."sequenceNumber"::text, 4, '0') END
                 || '-' || to_char(s."businessDate", 'YYYYMMDD'),
         'sequenceNumber', s."sequenceNumber",
         'businessDate', to_char(s."businessDate", 'YYYY-MM-DD'),
         'sessionId', s."id",
         'migration', '20261031130000_session_folio_historical'),
       'SESSIONS', s."id", 'SUCCESS'
FROM "poker_sessions" s
WHERE s."previousFolio" IS NULL AND s."folio" !~ '^S-[0-9]{4,}-[0-9]{8}$'
ON CONFLICT ("id") DO NOTHING;

UPDATE "poker_sessions"
SET "previousFolio" = "folio",
    "folio" = 'S-' || CASE WHEN length("sequenceNumber"::text) >= 4 THEN "sequenceNumber"::text
                           ELSE lpad("sequenceNumber"::text, 4, '0') END
              || '-' || to_char("businessDate", 'YYYYMMDD')
WHERE "previousFolio" IS NULL AND "folio" !~ '^S-[0-9]{4,}-[0-9]{8}$';

-- 3) Restricciones definitivas.
ALTER TABLE "poker_sessions" ALTER COLUMN "sequenceNumber" SET NOT NULL;
ALTER TABLE "poker_sessions" ALTER COLUMN "businessDate" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "poker_sessions_sequenceNumber_key" ON "poker_sessions"("sequenceNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "poker_sessions_previousFolio_key" ON "poker_sessions"("previousFolio");
CREATE INDEX IF NOT EXISTS "poker_sessions_businessDate_idx" ON "poker_sessions"("businessDate");

ALTER TABLE "poker_sessions" DROP CONSTRAINT IF EXISTS "poker_sessions_historicalRecordedById_fkey";
ALTER TABLE "poker_sessions" ADD CONSTRAINT "poker_sessions_historicalRecordedById_fkey"
  FOREIGN KEY ("historicalRecordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- El folio es EXACTAMENTE S-<consecutivo ≥ 4 dígitos>-<fecha operativa>.
ALTER TABLE "poker_sessions" DROP CONSTRAINT IF EXISTS "poker_sessions_folio_format";
ALTER TABLE "poker_sessions" ADD CONSTRAINT "poker_sessions_folio_format"
  CHECK ("sequenceNumber" > 0 AND "folio" = 'S-' ||
    CASE WHEN length("sequenceNumber"::text) >= 4 THEN "sequenceNumber"::text
         ELSE lpad("sequenceNumber"::text, 4, '0') END
    || '-' || to_char("businessDate", 'YYYYMMDD'));

-- Captura histórica coherente: datos de captura completos, y una sesión
-- HISTORICAL siempre es histórica (y una histórica solo es HISTORICAL o se
-- cancela).
ALTER TABLE "poker_sessions" DROP CONSTRAINT IF EXISTS "poker_sessions_historical_valid";
ALTER TABLE "poker_sessions" ADD CONSTRAINT "poker_sessions_historical_valid"
  CHECK (
    ("isHistorical" = ("historicalRecordedAt" IS NOT NULL))
    AND ("isHistorical" = ("historicalRecordedById" IS NOT NULL))
    AND ("status" <> 'HISTORICAL' OR "isHistorical")
    AND (NOT "isHistorical" OR "status" IN ('HISTORICAL', 'CANCELLED'))
  );

-- 4) Guardias: consecutivo, fecha operativa, folio anterior y datos de
--    captura inmutables; HISTORICAL solo pasa a CANCELLED.
CREATE OR REPLACE FUNCTION "poker_sessions_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'poker_sessions no admite DELETE (se cancela, no se borra)';
  END IF;
  IF NEW."folio" IS DISTINCT FROM OLD."folio"
     OR NEW."sequenceNumber" IS DISTINCT FROM OLD."sequenceNumber"
     OR NEW."businessDate" IS DISTINCT FROM OLD."businessDate"
     OR NEW."previousFolio" IS DISTINCT FROM OLD."previousFolio"
     OR NEW."isHistorical" IS DISTINCT FROM OLD."isHistorical"
     OR NEW."historicalRecordedAt" IS DISTINCT FROM OLD."historicalRecordedAt"
     OR NEW."historicalRecordedById" IS DISTINCT FROM OLD."historicalRecordedById"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."cashBoxId" IS DISTINCT FROM OLD."cashBoxId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
     OR (OLD."openedAt" IS NOT NULL AND NEW."openedAt" IS DISTINCT FROM OLD."openedAt")
     OR (OLD."openedById" IS NOT NULL AND NEW."openedById" IS DISTINCT FROM OLD."openedById")
     OR (OLD."closedAt" IS NOT NULL AND NEW."closedAt" IS DISTINCT FROM OLD."closedAt")
     OR (OLD."cancelledAt" IS NOT NULL AND NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt")
  THEN
    RAISE EXCEPTION 'Folio, consecutivo, fecha operativa, creador, caja y fechas reales de una sesión son inmutables';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'DRAFT' AND NEW."status" IN ('PREPARATION', 'CANCELLED'))
    OR (OLD."status" = 'PREPARATION' AND NEW."status" IN ('OPEN', 'CANCELLED'))
    OR (OLD."status" = 'OPEN' AND NEW."status" = 'CLOSING')
    OR (OLD."status" = 'CLOSING' AND NEW."status" IN ('OPEN', 'CLOSED'))
    OR (OLD."status" = 'HISTORICAL' AND NEW."status" = 'CANCELLED')
  ) THEN
    RAISE EXCEPTION 'Transición de sesión no permitida: % → %', OLD."status", NEW."status";
  END IF;
  IF OLD."status" IN ('CLOSED', 'CANCELLED') THEN
    RAISE EXCEPTION 'Una sesión % no se modifica', OLD."status";
  END IF;
  IF NEW."closedAt" IS NOT NULL AND NEW."status" <> 'CLOSED' THEN
    RAISE EXCEPTION 'Solo una sesión CLOSED tiene hora de cierre';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE "poker_sessions" ENABLE TRIGGER "poker_sessions_guard";

-- Una sesión nace en DRAFT (operación normal) o HISTORICAL (captura histórica).
CREATE OR REPLACE FUNCTION "poker_sessions_insert_guard"() RETURNS trigger AS $$
BEGIN
  IF NOT ((NEW."status" = 'DRAFT' AND NOT NEW."isHistorical")
          OR (NEW."status" = 'HISTORICAL' AND NEW."isHistorical")) THEN
    RAISE EXCEPTION 'Una sesión se crea en DRAFT (o HISTORICAL si es captura histórica)';
  END IF;
  IF NEW."isHistorical" AND (NEW."openedAt" IS NOT NULL OR NEW."closedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'Una sesión histórica no lleva horas de apertura o cierre inventadas';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 5) Consecutivo de sesiones: formato S, relleno 4, y nunca por debajo del
--    mayor consecutivo asignado (no se reutilizan números).
UPDATE "folio_sequences"
SET "prefix" = 'S',
    "padding" = 4,
    "nextNumber" = GREATEST("nextNumber", COALESCE((SELECT max("sequenceNumber") FROM "poker_sessions"), 0) + 1),
    "updatedAt" = NOW()
WHERE "documentType" = 'SESSION';
