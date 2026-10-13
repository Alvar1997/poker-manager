-- Módulo 01: usuarios, roles, permisos y seguridad.
-- Migración aditiva: no modifica ni elimina datos existentes.
-- CreateEnum
CREATE TYPE "AuditResult" AS ENUM ('SUCCESS', 'FAILURE', 'DENIED');

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "requestId" TEXT,
ADD COLUMN     "result" "AuditResult" NOT NULL DEFAULT 'SUCCESS';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "passwordChangedAt" TIMESTAMP(3),
ADD COLUMN     "sessionVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "updatedById" TEXT;

-- CreateTable
CREATE TABLE "login_throttles" (
    "key" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,
    "lockedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "login_throttles_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "audit_logs_requestId_idx" ON "audit_logs"("requestId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Auditoría inmutable: ningún rol de la aplicación puede alterar ni borrar
-- registros de audit_logs, ni siquiera por un bug en el código. Las
-- correcciones se registran como eventos nuevos, nunca mutando los previos.
-- (TRUNCATE no dispara triggers de fila: solo lo usan las bases de prueba.)
CREATE FUNCTION "audit_logs_prevent_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs es de solo inserción (%)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_logs_immutable"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "audit_logs_prevent_mutation"();
