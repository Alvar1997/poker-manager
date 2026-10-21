import "server-only"

import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"

import { Prisma } from "@/generated/prisma/client"
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@/lib/errors"
import { verifyPassword } from "@/lib/password"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import { getBackupConfig } from "@/modules/backups/backup.config"
import { restoreInto } from "@/modules/backups/restore.service"

/**
 * Recuperación PROTEGIDA (Módulo 15, DEC-11..13). Solo SUPERADMIN.
 *
 * La app web SOLO prepara, valida y da seguimiento: solicitar (con
 * reautenticación), enlazar una prueba aislada aprobada, activar el modo
 * mantenimiento y aprobar. La EJECUCIÓN no existe por HTTP: la corre el
 * procedimiento protegido por CLI (`npm run recovery:execute -- <id>`),
 * que restaura en una base NUEVA (nunca sobrescribe la actual), verifica y
 * solo entonces marca COMPLETED. El cambio de conexión es manual (runbook).
 *
 * Cada paso se audita en la base Y en un registro externo de solo anexado
 * (BACKUP_STORAGE_DIR/recovery-audit.jsonl), que sobrevive a la restauración.
 */

const TX = { maxWait: 10_000, timeout: 20_000 } as const
const ACTIVE = [
  "REQUESTED",
  "VALIDATING",
  "VALIDATED",
  "APPROVED",
  "EXECUTING",
] as const

function assertSuperadmin(actor: SessionUser) {
  if (actor.role !== "SUPERADMIN")
    throw new ForbiddenError(
      "La recuperación de producción es exclusiva de SUPERADMIN."
    )
}

/** Autenticación reforzada: vuelve a pedir la contraseña del SUPERADMIN. */
export async function assertReauthenticated(
  actor: SessionUser,
  password: string
) {
  const u = await prisma.user.findUnique({
    where: { id: actor.id },
    select: { passwordHash: true, isActive: true, role: true },
  })
  if (
    !u?.isActive ||
    u.role !== "SUPERADMIN" ||
    !(await verifyPassword(password, u.passwordHash))
  )
    throw new ForbiddenError("Confirmación de identidad incorrecta.")
}

/** Registro externo (archivo de solo anexado), fuera de la base restaurable. */
export async function writeExternalAudit(event: Record<string, unknown>) {
  const dir = getBackupConfig().storageDir
  if (!dir)
    return {
      written: false as const,
      reason: "BACKUP_STORAGE_DIR no configurado",
    }
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await appendFile(
      join(dir, "recovery-audit.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
      { mode: 0o600 }
    )
    return { written: true as const }
  } catch (error) {
    return {
      written: false as const,
      reason: error instanceof Error ? error.message.slice(0, 120) : "error",
    }
  }
}

/** Datos que se perderían si se recupera al punto del respaldo. */
export async function dataAfter(point: Date) {
  const [cash, purchases, payments, settlements, audit] = await Promise.all([
    prisma.cashTransaction.count({ where: { createdAt: { gt: point } } }),
    prisma.chipPurchase.count({ where: { createdAt: { gt: point } } }),
    prisma.receivablePayment.count({ where: { createdAt: { gt: point } } }),
    prisma.playerSettlement.count({ where: { createdAt: { gt: point } } }),
    prisma.auditLog.count({ where: { createdAt: { gt: point } } }),
  ])
  return {
    evaluatedAt: new Date().toISOString(),
    recoveryPoint: point.toISOString(),
    cashTransactions: cash,
    purchases,
    receivablePayments: payments,
    settlements,
    auditEvents: audit,
    total: cash + purchases + payments + settlements,
  }
}

const PLAN = [
  "1. Activar el modo mantenimiento (detiene escrituras de negocio).",
  "2. Confirmar una prueba de restauración aislada APROBADA del mismo respaldo.",
  "3. Revisar los datos posteriores al punto de recuperación (se perderían o deben recapturarse).",
  "4. Aprobar (SUPERADMIN, con contraseña).",
  "5. Ejecutar por CLI: npm run recovery:execute -- <id> (restaura en RECOVERY_TARGET_DATABASE_URL, base NUEVA).",
  "6. Verificar el resultado y cambiar DATABASE_URL/DIRECT_URL según docs/DISASTER_RECOVERY_RUNBOOK.md.",
  "7. Desactivar el modo mantenimiento.",
].join("\n")

export async function requestRecovery(
  actor: SessionUser,
  input: {
    backupId: string
    reason: string
    password: string
    idempotencyKey: string
  },
  ctx: RequestContext = {}
) {
  assertSuperadmin(actor)
  await assertReauthenticated(actor, input.password)
  const replay = await prisma.restoreRequest.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true },
  })
  if (replay) return { id: replay.id, replayed: true }
  const backup = await prisma.backupExecution.findUnique({
    where: { id: input.backupId },
  })
  if (!backup) throw new NotFoundError("Respaldo no encontrado")
  if (
    backup.status !== "SUCCESS" ||
    backup.verificationStatus !== "PASSED" ||
    backup.prunedAt ||
    !backup.recoveryPoint
  )
    throw new BusinessRuleError(
      "Solo se recupera desde un respaldo exitoso, verificado y disponible."
    )
  const validation = await prisma.restoreValidation.findFirst({
    where: { backupId: backup.id, status: "PASSED" },
    orderBy: { finishedAt: "desc" },
    select: { id: true },
  })
  const assessment = await dataAfter(backup.recoveryPoint)
  try {
    const created = await prisma.$transaction(async (tx) => {
      const r = await tx.restoreRequest.create({
        data: {
          backupId: backup.id,
          validationId: validation?.id ?? null,
          reason: input.reason,
          status: validation ? "VALIDATED" : "REQUESTED",
          requestedById: actor.id,
          recoveryPoint: backup.recoveryPoint,
          dataAfterRecovery: assessment,
          plan: PLAN,
          idempotencyKey: input.idempotencyKey,
        },
        select: { id: true, status: true },
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.RECOVERY_REQUESTED,
          entityType: "RestoreRequest",
          entityId: r.id,
          actorUserId: actor.id,
          actorRole: actor.role,
          requestId: ctx.requestId,
          reason: input.reason,
          metadata: {
            backupId: backup.id,
            validationId: validation?.id ?? null,
            dataAfter: assessment,
          },
        },
        tx
      )
      return r
    }, TX)
    await writeExternalAudit({
      event: "RECOVERY_REQUESTED",
      requestId: created.id,
      actorId: actor.id,
      backupId: backup.id,
    })
    return { id: created.id, replayed: false }
  } catch (error) {
    if (isUniqueViolation(error))
      throw new ConflictError("Ya existe una solicitud de recuperación activa.")
    throw error
  }
}

async function lockRequest(tx: Prisma.TransactionClient, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "restore_requests" WHERE "id" = ${id} FOR UPDATE`
  if (!rows.length)
    throw new NotFoundError("Solicitud de recuperación no encontrada")
  return tx.restoreRequest.findUniqueOrThrow({ where: { id } })
}

/** Enlaza una prueba aislada APROBADA del MISMO respaldo. */
export async function linkValidation(
  actor: SessionUser,
  id: string,
  validationId: string,
  ctx: RequestContext = {}
) {
  assertSuperadmin(actor)
  await prisma.$transaction(async (tx) => {
    const r = await lockRequest(tx, id)
    if (r.status !== "REQUESTED" && r.status !== "VALIDATING")
      throw new BusinessRuleError("La solicitud no espera validación.")
    const v = await tx.restoreValidation.findUnique({
      where: { id: validationId },
    })
    if (!v || v.backupId !== r.backupId || v.status !== "PASSED")
      throw new BusinessRuleError(
        "La prueba debe estar APROBADA y ser del mismo respaldo."
      )
    await tx.restoreRequest.update({
      where: { id },
      data: { validationId, status: "VALIDATED", version: { increment: 1 } },
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.RECOVERY_VALIDATION_LINKED,
        entityType: "RestoreRequest",
        entityId: id,
        actorUserId: actor.id,
        actorRole: actor.role,
        requestId: ctx.requestId,
        metadata: { validationId },
      },
      tx
    )
  }, TX)
}

export async function approveRecovery(
  actor: SessionUser,
  id: string,
  input: { password: string; confirmation: string; expectedVersion: number },
  ctx: RequestContext = {}
) {
  assertSuperadmin(actor)
  await assertReauthenticated(actor, input.password)
  if (input.confirmation !== "RECUPERAR")
    throw new BusinessRuleError("Escribe RECUPERAR para confirmar.")
  const maintenance = await prisma.systemMaintenance.findUnique({
    where: { id: 1 },
  })
  if (!maintenance?.enabled)
    throw new BusinessRuleError("Activa primero el modo mantenimiento.")
  await prisma.$transaction(async (tx) => {
    const r = await lockRequest(tx, id)
    if (r.version !== input.expectedVersion)
      throw new ConflictError("La solicitud cambió. Vuelve a cargarla.")
    if (r.status !== "VALIDATED" || !r.validationId)
      throw new BusinessRuleError(
        "Se requiere una prueba aislada aprobada antes de aprobar."
      )
    const assessment = r.recoveryPoint ? await dataAfter(r.recoveryPoint) : null
    await tx.restoreRequest.update({
      where: { id },
      data: {
        status: "APPROVED",
        approvedById: actor.id,
        approvedAt: new Date(),
        dataAfterRecovery: assessment ?? undefined,
        version: { increment: 1 },
      },
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.RECOVERY_APPROVED,
        entityType: "RestoreRequest",
        entityId: id,
        actorUserId: actor.id,
        actorRole: actor.role,
        requestId: ctx.requestId,
        metadata: { dataAfter: assessment },
      },
      tx
    )
  }, TX)
  await writeExternalAudit({
    event: "RECOVERY_APPROVED",
    requestId: id,
    actorId: actor.id,
  })
}

export async function cancelRecovery(
  actor: SessionUser,
  id: string,
  notes: string,
  ctx: RequestContext = {}
) {
  assertSuperadmin(actor)
  await prisma.$transaction(async (tx) => {
    const r = await lockRequest(tx, id)
    if (
      !(ACTIVE as readonly string[]).includes(r.status) ||
      r.status === "EXECUTING"
    )
      throw new BusinessRuleError("Esta solicitud ya no se puede cancelar.")
    await tx.restoreRequest.update({
      where: { id },
      data: { status: "CANCELLED", notes, version: { increment: 1 } },
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.RECOVERY_CANCELLED,
        entityType: "RestoreRequest",
        entityId: id,
        actorUserId: actor.id,
        actorRole: actor.role,
        requestId: ctx.requestId,
        reason: notes,
      },
      tx
    )
  }, TX)
  await writeExternalAudit({
    event: "RECOVERY_CANCELLED",
    requestId: id,
    actorId: actor.id,
  })
}

/**
 * Ejecución PROTEGIDA (solo CLI). Restaura en RECOVERY_TARGET_DATABASE_URL
 * (base NUEVA y vacía con «recovery» en el nombre), verifica y registra el
 * resultado real. Nunca toca la base actual.
 */
export async function executeRecovery(requestId: string, operator: string) {
  const config = getBackupConfig()
  if (!config.configured || !config.recoveryTargetUrl)
    throw new BusinessRuleError(
      `Configuración incompleta: ${[...config.missing, ...(config.recoveryTargetUrl ? [] : ["RECOVERY_TARGET_DATABASE_URL"])].join(", ")}`
    )
  const maintenance = await prisma.systemMaintenance.findUnique({
    where: { id: 1 },
  })
  if (!maintenance?.enabled)
    throw new BusinessRuleError("El modo mantenimiento debe estar activo.")
  const claimed = await prisma.restoreRequest.updateMany({
    where: { id: requestId, status: "APPROVED" },
    data: { status: "EXECUTING", version: { increment: 1 } },
  })
  if (claimed.count !== 1)
    throw new BusinessRuleError(
      "La solicitud no está APROBADA (o ya se está ejecutando)."
    )
  const req = await prisma.restoreRequest.findUniqueOrThrow({
    where: { id: requestId },
  })
  await recordAudit({
    action: AUDIT_ACTIONS.RECOVERY_EXECUTION_STARTED,
    entityType: "RestoreRequest",
    entityId: requestId,
    actorUserId: req.approvedById,
    metadata: { operator: operator.slice(0, 100), backupId: req.backupId },
  })
  await writeExternalAudit({
    event: "RECOVERY_EXECUTION_STARTED",
    requestId,
    operator,
  })
  try {
    const result = await restoreInto(req.backupId, config.recoveryTargetUrl, {
      config,
      wipe: false,
      purpose: "recovery",
    })
    if ("close" in result && result.close) await result.close()
    const passed = result.passed
    const reference =
      "target" in result && result.target
        ? `${result.target.database}@${result.target.fingerprint}`
        : null
    await prisma.restoreRequest.update({
      where: { id: requestId },
      data: passed
        ? {
            status: "COMPLETED",
            executionReference: reference,
            result: `Restaurado y verificado en ${reference}. Pendiente: cambiar DATABASE_URL/DIRECT_URL (runbook). Comprobaciones: ${result.checks.map((c) => `${c.code}=${c.status}`).join(", ")}`,
          }
        : {
            status: "FAILED",
            executionReference: reference,
            result: `Verificación posterior fallida: ${result.checks
              .filter((c) => c.status === "FAILED")
              .map((c) => c.code)
              .join(", ")}`,
          },
    })
    await recordAudit({
      action: passed
        ? AUDIT_ACTIONS.RECOVERY_COMPLETED
        : AUDIT_ACTIONS.RECOVERY_FAILED,
      entityType: "RestoreRequest",
      entityId: requestId,
      actorUserId: req.approvedById,
      result: passed ? "SUCCESS" : "FAILURE",
      metadata: {
        checks: result.checks.map((c) => `${c.code}:${c.status}`),
        target: reference,
      },
    })
    await writeExternalAudit({
      event: passed ? "RECOVERY_COMPLETED" : "RECOVERY_FAILED",
      requestId,
      target: reference,
      checks: result.checks,
    })
    return { passed, checks: result.checks, target: reference }
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 500) : "error"
    await prisma.restoreRequest.update({
      where: { id: requestId },
      data: { status: "FAILED", result: message },
    })
    await recordAudit({
      action: AUDIT_ACTIONS.RECOVERY_FAILED,
      entityType: "RestoreRequest",
      entityId: requestId,
      actorUserId: req.approvedById,
      result: "FAILURE",
      metadata: { error: message },
    })
    await writeExternalAudit({
      event: "RECOVERY_FAILED",
      requestId,
      error: message,
    })
    throw error
  }
}

// ── Modo mantenimiento ────────────────────────────────────────────────

let cache: { at: number; enabled: boolean } | null = null

/** Lectura con caché corta (5 s) para no consultar en cada escritura. */
export async function isMaintenanceEnabled() {
  if (cache && Date.now() - cache.at < 5_000) return cache.enabled
  const m = await prisma.systemMaintenance.findUnique({
    where: { id: 1 },
    select: { enabled: true },
  })
  cache = { at: Date.now(), enabled: Boolean(m?.enabled) }
  return cache.enabled
}

export async function setMaintenance(
  actor: SessionUser,
  input: { enabled: boolean; reason: string; password: string },
  ctx: RequestContext = {}
) {
  assertSuperadmin(actor)
  await assertReauthenticated(actor, input.password)
  await prisma.$transaction(async (tx) => {
    await tx.systemMaintenance.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        enabled: input.enabled,
        reason: input.reason,
        changedById: actor.id,
        changedAt: new Date(),
      },
      update: {
        enabled: input.enabled,
        reason: input.reason,
        changedById: actor.id,
        changedAt: new Date(),
      },
    })
    await recordAudit(
      {
        action: input.enabled
          ? AUDIT_ACTIONS.MAINTENANCE_ENABLED
          : AUDIT_ACTIONS.MAINTENANCE_DISABLED,
        entityType: "SystemMaintenance",
        entityId: "1",
        actorUserId: actor.id,
        actorRole: actor.role,
        requestId: ctx.requestId,
        reason: input.reason,
      },
      tx
    )
  }, TX)
  cache = null
  await writeExternalAudit({
    event: input.enabled ? "MAINTENANCE_ENABLED" : "MAINTENANCE_DISABLED",
    actorId: actor.id,
    reason: input.reason,
  })
}

export async function getRecoveryOverview() {
  const [requests, maintenance] = await Promise.all([
    prisma.restoreRequest.findMany({
      orderBy: { requestedAt: "desc" },
      take: 20,
      include: {
        requestedBy: { select: { id: true, name: true } },
        approvedBy: { select: { id: true, name: true } },
        validation: { select: { id: true, status: true, finishedAt: true } },
      },
    }),
    prisma.systemMaintenance.findUnique({
      where: { id: 1 },
      include: { changedBy: { select: { id: true, name: true } } },
    }),
  ])
  return {
    maintenance: {
      enabled: Boolean(maintenance?.enabled),
      reason: maintenance?.reason ?? null,
      changedAt: maintenance?.changedAt?.toISOString() ?? null,
      changedBy: maintenance?.changedBy ?? null,
    },
    requests: requests.map((r) => ({
      id: r.id,
      backupId: r.backupId,
      reason: r.reason,
      status: r.status,
      version: r.version,
      requestedAt: r.requestedAt.toISOString(),
      approvedAt: r.approvedAt?.toISOString() ?? null,
      recoveryPoint: r.recoveryPoint?.toISOString() ?? null,
      requestedBy: r.requestedBy,
      approvedBy: r.approvedBy,
      validation: r.validation
        ? {
            ...r.validation,
            finishedAt: r.validation.finishedAt?.toISOString() ?? null,
          }
        : null,
      dataAfterRecovery: r.dataAfterRecovery,
      plan: r.plan,
      executionReference: r.executionReference,
      result: r.result,
      notes: r.notes,
    })),
  }
}
