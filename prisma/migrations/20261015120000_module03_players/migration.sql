-- Módulo 03: jugadores, historial de teléfonos y consentimiento de notificaciones.
-- Migración aditiva: no modifica ni elimina datos existentes.
-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('WHATSAPP');

-- CreateEnum
CREATE TYPE "NotificationConsentType" AS ENUM ('TRANSACTIONAL');

-- CreateEnum
CREATE TYPE "ConsentAction" AS ENUM ('GRANTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ConsentSource" AS ENUM ('IN_PERSON', 'ADMIN_ENTRY');

-- CreateTable
CREATE TABLE "players" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nickname" TEXT,
    "phone" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_phone_history" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "previousPhone" TEXT NOT NULL,
    "newPhone" TEXT NOT NULL,
    "reason" TEXT,
    "changedById" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_phone_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_notification_consents" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'WHATSAPP',
    "consentType" "NotificationConsentType" NOT NULL DEFAULT 'TRANSACTIONAL',
    "action" "ConsentAction" NOT NULL,
    "phone" TEXT NOT NULL,
    "noticeVersion" TEXT NOT NULL,
    "source" "ConsentSource" NOT NULL,
    "evidenceReference" TEXT,
    "notes" TEXT,
    "recordedById" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_notification_consents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "players_phone_key" ON "players"("phone");

-- CreateIndex
CREATE INDEX "players_isActive_name_idx" ON "players"("isActive", "name");

-- CreateIndex
CREATE INDEX "players_name_idx" ON "players"("name");

-- CreateIndex
CREATE INDEX "players_nickname_idx" ON "players"("nickname");

-- CreateIndex
CREATE INDEX "players_createdAt_idx" ON "players"("createdAt");

-- CreateIndex
CREATE INDEX "player_phone_history_playerId_changedAt_idx" ON "player_phone_history"("playerId", "changedAt");

-- CreateIndex
CREATE INDEX "player_notification_consents_playerId_channel_recordedAt_idx" ON "player_notification_consents"("playerId", "channel", "recordedAt");

-- AddForeignKey
ALTER TABLE "players" ADD CONSTRAINT "players_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "players" ADD CONSTRAINT "players_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_phone_history" ADD CONSTRAINT "player_phone_history_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_phone_history" ADD CONSTRAINT "player_phone_history_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_notification_consents" ADD CONSTRAINT "player_notification_consents_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_notification_consents" ADD CONSTRAINT "player_notification_consents_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Restricciones de integridad que Prisma no expresa ──────────────────

-- Teléfono en formato E.164 (+ y 8 a 15 dígitos, sin 0 inicial).
ALTER TABLE "players" ADD CONSTRAINT "players_phone_e164" CHECK ("phone" ~ '^\+[1-9][0-9]{7,14}$');
ALTER TABLE "players" ADD CONSTRAINT "players_name_not_blank" CHECK (length(btrim("name")) > 0);
ALTER TABLE "player_notification_consents" ADD CONSTRAINT "player_consents_phone_e164" CHECK ("phone" ~ '^\+[1-9][0-9]{7,14}$');

-- Historial de teléfonos y de consentimiento: solo inserción (evidencia).
CREATE FUNCTION "player_history_prevent_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% es de solo inserción (%)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "player_phone_history_immutable"
  BEFORE UPDATE OR DELETE ON "player_phone_history"
  FOR EACH ROW EXECUTE FUNCTION "player_history_prevent_mutation"();

CREATE TRIGGER "player_notification_consents_immutable"
  BEFORE UPDATE OR DELETE ON "player_notification_consents"
  FOR EACH ROW EXECUTE FUNCTION "player_history_prevent_mutation"();
