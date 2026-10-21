-- Módulo 15 — auditoría transversal, correcciones excepcionales, integridad,
-- incidencias, respaldos, validaciones de restauración y recuperación.
-- Aditiva: agrega columnas NULLABLE a audit_logs (sin tocar filas: el
-- trigger de inmutabilidad sigue vigente) y tablas nuevas. No modifica
-- saldos, movimientos ni snapshots.

-- CreateEnum
CREATE TYPE "CorrectionType" AS ENUM ('RECEIVABLE_PAYMENT_REVERSAL', 'CASH_MOVEMENT_REVERSAL', 'SETTLEMENT_REVERSAL', 'PURCHASE_REVERSAL', 'SETTLEMENT_REVERSAL_WITH_PAYOUTS', 'UNAPPLIED_FUNDS_RETURN', 'LATE_CHIP_REDEMPTION', 'OTHER');

-- CreateEnum
CREATE TYPE "CorrectionStatus" AS ENUM ('REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'EXECUTED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CorrectionDecision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CorrectionEventKind" AS ENUM ('CREATED', 'COMMENT', 'STATUS_CHANGED', 'EXECUTION_LINKED');

-- CreateEnum
CREATE TYPE "IntegrityRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "IntegrityStatus" AS ENUM ('OK', 'WARNING', 'ERROR', 'NOT_EVALUATED');

-- CreateEnum
CREATE TYPE "FindingSeverity" AS ENUM ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "IncidentSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "IncidentSource" AS ENUM ('MANUAL', 'INTEGRITY', 'BACKUP', 'RESTORE', 'SECURITY');

-- CreateEnum
CREATE TYPE "IncidentEventKind" AS ENUM ('CREATED', 'REOCCURRED', 'STATUS_CHANGED', 'ASSIGNED', 'COMMENT', 'EVIDENCE');

-- CreateEnum
CREATE TYPE "BackupStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'PARTIAL', 'VERIFICATION_FAILED');

-- CreateEnum
CREATE TYPE "BackupTrigger" AS ENUM ('SCHEDULED', 'MANUAL');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('NOT_VERIFIED', 'PASSED', 'FAILED');

-- CreateEnum
CREATE TYPE "BackupArtifactKind" AS ENUM ('DATABASE_SNAPSHOT', 'MANIFEST');

-- CreateEnum
CREATE TYPE "RestoreValidationStatus" AS ENUM ('RUNNING', 'PASSED', 'FAILED');

-- CreateEnum
CREATE TYPE "RestoreRequestStatus" AS ENUM ('REQUESTED', 'VALIDATING', 'VALIDATED', 'APPROVED', 'EXECUTING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "actorRole" "Role",
ADD COLUMN     "amount" DECIMAL(14,2),
ADD COLUMN     "evidenceRef" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "module" TEXT,
ADD COLUMN     "playerId" TEXT,
ADD COLUMN     "reason" TEXT,
ADD COLUMN     "relatedEventId" TEXT,
ADD COLUMN     "sessionId" TEXT,
ADD COLUMN     "tableCycleId" TEXT;

-- CreateTable
CREATE TABLE "correction_requests" (
    "id" TEXT NOT NULL,
    "folio" TEXT NOT NULL,
    "type" "CorrectionType" NOT NULL,
    "module" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "sessionId" TEXT,
    "playerId" TEXT,
    "amount" DECIMAL(14,2),
    "reason" TEXT NOT NULL,
    "evidenceNote" TEXT,
    "status" "CorrectionStatus" NOT NULL DEFAULT 'REQUESTED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,
    "executionReferenceType" TEXT,
    "executionReferenceId" TEXT,
    "executedById" TEXT,
    "executedAt" TIMESTAMP(3),
    "executionNotes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "correction_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "correction_approvals" (
    "id" TEXT NOT NULL,
    "correctionId" TEXT NOT NULL,
    "decision" "CorrectionDecision" NOT NULL,
    "decidedById" TEXT NOT NULL,
    "decidedRole" "Role" NOT NULL,
    "notes" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "correction_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "correction_events" (
    "id" TEXT NOT NULL,
    "correctionId" TEXT NOT NULL,
    "kind" "CorrectionEventKind" NOT NULL,
    "fromStatus" "CorrectionStatus",
    "toStatus" "CorrectionStatus",
    "notes" TEXT,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "correction_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrity_check_runs" (
    "id" TEXT NOT NULL,
    "status" "IntegrityRunStatus" NOT NULL DEFAULT 'RUNNING',
    "trigger" TEXT NOT NULL,
    "triggeredById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "summary" JSONB,
    "error" TEXT,

    CONSTRAINT "integrity_check_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrity_findings" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "checkCode" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" "IntegrityStatus" NOT NULL,
    "severity" "FindingSeverity" NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "expected" TEXT,
    "actual" TEXT,
    "difference" TEXT,
    "explanation" TEXT NOT NULL,
    "references" JSONB,
    "fingerprint" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integrity_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operational_incidents" (
    "id" TEXT NOT NULL,
    "folio" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" "IncidentSeverity" NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "source" "IncidentSource" NOT NULL,
    "fingerprint" TEXT,
    "findingId" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedToId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operational_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_history" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "kind" "IncidentEventKind" NOT NULL,
    "fromStatus" "IncidentStatus",
    "toStatus" "IncidentStatus",
    "notes" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_executions" (
    "id" TEXT NOT NULL,
    "trigger" "BackupTrigger" NOT NULL,
    "status" "BackupStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "triggeredById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "recoveryPoint" TIMESTAMP(3),
    "schemaVersion" TEXT,
    "migrationsCount" INTEGER,
    "destination" TEXT NOT NULL,
    "location" TEXT,
    "tableCount" INTEGER,
    "rowCount" INTEGER,
    "evidenceCount" INTEGER,
    "sizeBytes" BIGINT,
    "artifactSha256" TEXT,
    "encryption" TEXT,
    "keyFingerprint" TEXT,
    "manifest" JSONB,
    "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'NOT_VERIFIED',
    "verifiedAt" TIMESTAMP(3),
    "verificationError" TEXT,
    "error" TEXT,
    "host" TEXT,
    "prunedAt" TIMESTAMP(3),

    CONSTRAINT "backup_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_artifacts" (
    "id" TEXT NOT NULL,
    "backupId" TEXT NOT NULL,
    "kind" "BackupArtifactKind" NOT NULL,
    "path" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backup_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restore_validations" (
    "id" TEXT NOT NULL,
    "backupId" TEXT NOT NULL,
    "status" "RestoreValidationStatus" NOT NULL DEFAULT 'RUNNING',
    "trigger" TEXT NOT NULL,
    "requestedById" TEXT,
    "targetFingerprint" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "checks" JSONB,
    "error" TEXT,
    "cleanedUp" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "restore_validations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restore_requests" (
    "id" TEXT NOT NULL,
    "backupId" TEXT NOT NULL,
    "validationId" TEXT,
    "reason" TEXT NOT NULL,
    "status" "RestoreRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "recoveryPoint" TIMESTAMP(3),
    "dataAfterRecovery" JSONB,
    "plan" TEXT,
    "executionReference" TEXT,
    "result" TEXT,
    "notes" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restore_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_maintenance" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "changedById" TEXT,
    "changedAt" TIMESTAMP(3),

    CONSTRAINT "system_maintenance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "correction_requests_folio_key" ON "correction_requests"("folio");

-- CreateIndex
CREATE UNIQUE INDEX "correction_requests_idempotencyKey_key" ON "correction_requests"("idempotencyKey");

-- CreateIndex
CREATE INDEX "correction_requests_status_requestedAt_idx" ON "correction_requests"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "correction_requests_targetType_targetId_idx" ON "correction_requests"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "correction_requests_requestedById_idx" ON "correction_requests"("requestedById");

-- CreateIndex
CREATE UNIQUE INDEX "correction_requests_executionReferenceType_executionReferen_key" ON "correction_requests"("executionReferenceType", "executionReferenceId");

-- CreateIndex
CREATE UNIQUE INDEX "correction_approvals_correctionId_key" ON "correction_approvals"("correctionId");

-- CreateIndex
CREATE INDEX "correction_events_correctionId_createdAt_idx" ON "correction_events"("correctionId", "createdAt");

-- CreateIndex
CREATE INDEX "integrity_check_runs_startedAt_idx" ON "integrity_check_runs"("startedAt");

-- CreateIndex
CREATE INDEX "integrity_findings_runId_status_idx" ON "integrity_findings"("runId", "status");

-- CreateIndex
CREATE INDEX "integrity_findings_fingerprint_idx" ON "integrity_findings"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "operational_incidents_folio_key" ON "operational_incidents"("folio");

-- CreateIndex
CREATE INDEX "operational_incidents_status_severity_idx" ON "operational_incidents"("status", "severity");

-- CreateIndex
CREATE INDEX "operational_incidents_createdAt_idx" ON "operational_incidents"("createdAt");

-- CreateIndex
CREATE INDEX "incident_history_incidentId_createdAt_idx" ON "incident_history"("incidentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "backup_executions_idempotencyKey_key" ON "backup_executions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "backup_executions_status_startedAt_idx" ON "backup_executions"("status", "startedAt");

-- CreateIndex
CREATE INDEX "backup_executions_trigger_startedAt_idx" ON "backup_executions"("trigger", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "backup_artifacts_backupId_kind_key" ON "backup_artifacts"("backupId", "kind");

-- CreateIndex
CREATE INDEX "restore_validations_backupId_startedAt_idx" ON "restore_validations"("backupId", "startedAt");

-- CreateIndex
CREATE INDEX "restore_validations_status_startedAt_idx" ON "restore_validations"("status", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "restore_requests_idempotencyKey_key" ON "restore_requests"("idempotencyKey");

-- CreateIndex
CREATE INDEX "restore_requests_status_requestedAt_idx" ON "restore_requests"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "audit_logs_module_createdAt_idx" ON "audit_logs"("module", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_sessionId_idx" ON "audit_logs"("sessionId");

-- CreateIndex
CREATE INDEX "audit_logs_playerId_idx" ON "audit_logs"("playerId");

-- CreateIndex
CREATE INDEX "audit_logs_actorRole_idx" ON "audit_logs"("actorRole");

-- AddForeignKey
ALTER TABLE "correction_requests" ADD CONSTRAINT "correction_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correction_requests" ADD CONSTRAINT "correction_requests_executedById_fkey" FOREIGN KEY ("executedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correction_approvals" ADD CONSTRAINT "correction_approvals_correctionId_fkey" FOREIGN KEY ("correctionId") REFERENCES "correction_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correction_approvals" ADD CONSTRAINT "correction_approvals_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correction_events" ADD CONSTRAINT "correction_events_correctionId_fkey" FOREIGN KEY ("correctionId") REFERENCES "correction_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correction_events" ADD CONSTRAINT "correction_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrity_check_runs" ADD CONSTRAINT "integrity_check_runs_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrity_findings" ADD CONSTRAINT "integrity_findings_runId_fkey" FOREIGN KEY ("runId") REFERENCES "integrity_check_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operational_incidents" ADD CONSTRAINT "operational_incidents_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "integrity_findings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operational_incidents" ADD CONSTRAINT "operational_incidents_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operational_incidents" ADD CONSTRAINT "operational_incidents_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operational_incidents" ADD CONSTRAINT "operational_incidents_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_history" ADD CONSTRAINT "incident_history_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "operational_incidents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_history" ADD CONSTRAINT "incident_history_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_executions" ADD CONSTRAINT "backup_executions_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_artifacts" ADD CONSTRAINT "backup_artifacts_backupId_fkey" FOREIGN KEY ("backupId") REFERENCES "backup_executions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restore_validations" ADD CONSTRAINT "restore_validations_backupId_fkey" FOREIGN KEY ("backupId") REFERENCES "backup_executions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restore_validations" ADD CONSTRAINT "restore_validations_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restore_requests" ADD CONSTRAINT "restore_requests_backupId_fkey" FOREIGN KEY ("backupId") REFERENCES "backup_executions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restore_requests" ADD CONSTRAINT "restore_requests_validationId_fkey" FOREIGN KEY ("validationId") REFERENCES "restore_validations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restore_requests" ADD CONSTRAINT "restore_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restore_requests" ADD CONSTRAINT "restore_requests_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_maintenance" ADD CONSTRAINT "system_maintenance_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Garantías del Módulo 15 (no expresables en Prisma) ──────────────────

-- Historiales y evidencias de proceso: SOLO INSERCIÓN (como audit_logs).
CREATE FUNCTION "m15_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% es de solo inserción (Módulo 15): no se modifica ni se borra', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "correction_approvals_append_only" BEFORE UPDATE OR DELETE ON "correction_approvals"
  FOR EACH ROW EXECUTE FUNCTION "m15_append_only"();
CREATE TRIGGER "correction_events_append_only" BEFORE UPDATE OR DELETE ON "correction_events"
  FOR EACH ROW EXECUTE FUNCTION "m15_append_only"();
CREATE TRIGGER "incident_history_append_only" BEFORE UPDATE OR DELETE ON "incident_history"
  FOR EACH ROW EXECUTE FUNCTION "m15_append_only"();
CREATE TRIGGER "integrity_findings_append_only" BEFORE UPDATE OR DELETE ON "integrity_findings"
  FOR EACH ROW EXECUTE FUNCTION "m15_append_only"();
CREATE TRIGGER "backup_artifacts_append_only" BEFORE UPDATE OR DELETE ON "backup_artifacts"
  FOR EACH ROW EXECUTE FUNCTION "m15_append_only"();

-- Procesos con estado: nunca se borran (el estado cambia, la fila queda).
CREATE FUNCTION "m15_no_delete"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% no admite borrado (Módulo 15)', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "correction_requests_no_delete" BEFORE DELETE ON "correction_requests"
  FOR EACH ROW EXECUTE FUNCTION "m15_no_delete"();
CREATE TRIGGER "operational_incidents_no_delete" BEFORE DELETE ON "operational_incidents"
  FOR EACH ROW EXECUTE FUNCTION "m15_no_delete"();
CREATE TRIGGER "integrity_check_runs_no_delete" BEFORE DELETE ON "integrity_check_runs"
  FOR EACH ROW EXECUTE FUNCTION "m15_no_delete"();
CREATE TRIGGER "backup_executions_no_delete" BEFORE DELETE ON "backup_executions"
  FOR EACH ROW EXECUTE FUNCTION "m15_no_delete"();
CREATE TRIGGER "restore_validations_no_delete" BEFORE DELETE ON "restore_validations"
  FOR EACH ROW EXECUTE FUNCTION "m15_no_delete"();
CREATE TRIGGER "restore_requests_no_delete" BEFORE DELETE ON "restore_requests"
  FOR EACH ROW EXECUTE FUNCTION "m15_no_delete"();

-- Una solicitud EXECUTED exige referencia real de ejecución; APPROVED/REJECTED exigen decisión.
ALTER TABLE "correction_requests" ADD CONSTRAINT "correction_requests_executed_has_reference"
  CHECK ("status" <> 'EXECUTED' OR ("executionReferenceType" IS NOT NULL AND "executionReferenceId" IS NOT NULL AND "executedById" IS NOT NULL AND "executedAt" IS NOT NULL));
ALTER TABLE "correction_requests" ADD CONSTRAINT "correction_requests_amount_non_negative"
  CHECK ("amount" IS NULL OR "amount" >= 0);

-- Un estado terminal no regresa (EXECUTED, REJECTED, CANCELLED).
CREATE FUNCTION "correction_requests_guard"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" IN ('EXECUTED', 'REJECTED', 'CANCELLED') AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'La solicitud % ya está en estado terminal %', OLD."folio", OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."folio" <> OLD."folio" OR NEW."type" <> OLD."type" OR NEW."targetId" <> OLD."targetId"
     OR NEW."reason" <> OLD."reason" OR NEW."requestedById" <> OLD."requestedById"
     OR NEW."amount" IS DISTINCT FROM OLD."amount" THEN
    RAISE EXCEPTION 'Los datos originales de la solicitud % son inmutables', OLD."folio"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "correction_requests_guard" BEFORE UPDATE ON "correction_requests"
  FOR EACH ROW EXECUTE FUNCTION "correction_requests_guard"();

-- Concurrencia: a lo sumo UNA ejecución en curso de cada proceso.
CREATE UNIQUE INDEX "integrity_check_runs_one_running" ON "integrity_check_runs" ((true)) WHERE "status" = 'RUNNING';
CREATE UNIQUE INDEX "backup_executions_one_running" ON "backup_executions" ((true)) WHERE "status" IN ('PENDING', 'RUNNING');
CREATE UNIQUE INDEX "restore_validations_one_running" ON "restore_validations" ((true)) WHERE "status" = 'RUNNING';
CREATE UNIQUE INDEX "restore_requests_one_active" ON "restore_requests" ((true))
  WHERE "status" IN ('REQUESTED', 'VALIDATING', 'VALIDATED', 'APPROVED', 'EXECUTING');

-- Una sola solicitud ACTIVA por movimiento y tipo (sin duplicados).
CREATE UNIQUE INDEX "correction_requests_one_active_per_target" ON "correction_requests" ("type", "targetType", "targetId")
  WHERE "status" IN ('REQUESTED', 'UNDER_REVIEW', 'APPROVED');

-- Sin incidencias duplicadas: una abierta por huella de hallazgo.
CREATE UNIQUE INDEX "operational_incidents_open_fingerprint" ON "operational_incidents" ("fingerprint")
  WHERE "fingerprint" IS NOT NULL AND "status" IN ('OPEN', 'IN_REVIEW');

-- Un respaldo SUCCESS tiene punto de recuperación, artefacto y checksum.
ALTER TABLE "backup_executions" ADD CONSTRAINT "backup_executions_success_complete"
  CHECK ("status" <> 'SUCCESS' OR ("recoveryPoint" IS NOT NULL AND "artifactSha256" IS NOT NULL AND "location" IS NOT NULL AND "finishedAt" IS NOT NULL));
-- Una recuperación COMPLETED exige referencia de ejecución y resultado.
ALTER TABLE "restore_requests" ADD CONSTRAINT "restore_requests_completed_has_evidence"
  CHECK ("status" <> 'COMPLETED' OR ("executionReference" IS NOT NULL AND "result" IS NOT NULL AND "validationId" IS NOT NULL AND "approvedById" IS NOT NULL));
ALTER TABLE "system_maintenance" ADD CONSTRAINT "system_maintenance_singleton" CHECK ("id" = 1);

-- Siembra (idempotente): folios COR-/INC- y fila del modo mantenimiento.
INSERT INTO "folio_sequences" ("id", "documentType", "prefix", "nextNumber", "padding", "isActive", "createdAt", "updatedAt")
VALUES ('m15-folio-correction', 'CORRECTION', 'COR', 1, 6, true, NOW(), NOW()),
       ('m15-folio-incident', 'INCIDENT', 'INC', 1, 6, true, NOW(), NOW())
ON CONFLICT ("documentType") DO NOTHING;
INSERT INTO "system_maintenance" ("id", "enabled") VALUES (1, false) ON CONFLICT ("id") DO NOTHING;
