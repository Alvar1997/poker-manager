import "server-only"

import type { Prisma } from "@/generated/prisma/client"
import { logger } from "@/lib/logger"
import { prisma } from "@/lib/prisma"

/**
 * Auditoría de seguridad y de acciones administrativas.
 *
 * - `audit_logs` es de solo inserción (trigger en la migración del
 *   Módulo 01): no existe API para editar ni borrar registros.
 * - Nunca se guardan contraseñas, hashes, tokens ni secretos: además de
 *   no pasarlos, `sanitizeMetadata` elimina cualquier clave sospechosa.
 * - Las mutaciones administrativas registran su auditoría dentro de la
 *   misma transacción (`db` = cliente de la transacción): si la auditoría
 *   falla, el cambio no se aplica.
 */

export const AUDIT_ACTIONS = {
  LOGIN_SUCCEEDED: "AUTH_LOGIN_SUCCEEDED",
  LOGIN_FAILED: "AUTH_LOGIN_FAILED",
  LOGIN_RATE_LIMITED: "AUTH_LOGIN_RATE_LIMITED",
  LOGOUT: "AUTH_LOGOUT",
  ACCESS_DENIED: "AUTH_ACCESS_DENIED",
  PASSWORD_CHANGED: "AUTH_PASSWORD_CHANGED",
  PASSWORD_CHANGE_FAILED: "AUTH_PASSWORD_CHANGE_FAILED",
  PROFILE_UPDATED: "AUTH_PROFILE_UPDATED",

  USER_CREATED: "USER_CREATED",
  USER_UPDATED: "USER_UPDATED",
  USER_ROLE_CHANGED: "USER_ROLE_CHANGED",
  USER_ACTIVATED: "USER_ACTIVATED",
  USER_DEACTIVATED: "USER_DEACTIVATED",
  USER_PASSWORD_RESET: "USER_PASSWORD_RESET",
} as const

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS]

export type AuditResultValue = "SUCCESS" | "FAILURE" | "DENIED"

export type AuditEntry = {
  action: AuditAction
  entityType: string
  entityId?: string | null
  actorUserId?: string | null
  result?: AuditResultValue
  requestId?: string | null
  metadata?: Record<string, unknown>
}

export type DbClient = Prisma.TransactionClient | typeof prisma

const FORBIDDEN_KEY = /pass(word)?|hash|token|secret|cookie|authorization/i

/** Elimina recursivamente claves que puedan contener secretos. */
export function sanitizeMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeMetadata)
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !FORBIDDEN_KEY.test(key))
        .map(([key, v]) => [key, sanitizeMetadata(v)])
    )
  }
  return value
}

export async function recordAudit(
  entry: AuditEntry,
  db: DbClient = prisma
): Promise<void> {
  await db.auditLog.create({
    data: {
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      actorUserId: entry.actorUserId ?? null,
      result: entry.result ?? "SUCCESS",
      requestId: entry.requestId ?? null,
      metadata: entry.metadata
        ? (sanitizeMetadata(entry.metadata) as Prisma.InputJsonValue)
        : undefined,
    },
  })
}

/**
 * Variante que nunca lanza: para eventos que no deben bloquear la
 * respuesta (accesos denegados, logins fallidos, logout). Si falla, queda
 * en el log del servidor.
 */
export async function recordAuditSafe(entry: AuditEntry): Promise<void> {
  try {
    await recordAudit(entry)
  } catch (error) {
    logger.error({
      event: "audit_write_failed",
      action: entry.action,
      requestId: entry.requestId,
      err: error,
    })
  }
}
