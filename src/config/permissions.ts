import "server-only"

import { redirect } from "next/navigation"
import { cache } from "react"

import {
  PERMISSIONS,
  roleHasPermission,
  type Permission,
} from "@/config/permission-matrix"
import { auth } from "@/lib/auth"
import { ForbiddenError, UnauthorizedError } from "@/lib/errors"
import { AUDIT_ACTIONS, recordAuditSafe } from "@/modules/audit/audit.service"
import { loadSessionUser, type SessionUser } from "@/modules/auth/auth.service"

export {
  PERMISSIONS,
  ROLES,
  roleHasPermission,
  type Permission,
  type Role,
} from "@/config/permission-matrix"

export type AuthenticatedUser = SessionUser

/**
 * Autorización en el servidor — la única que cuenta.
 *
 * - El JWT solo identifica al usuario. Rol, estado y vigencia de la
 *   sesión se leen de la BASE en cada request (getCurrentUser), así que
 *   un JWT viejo o manipulado no eleva privilegios ni revive una cuenta
 *   desactivada.
 * - Se autoriza por capacidades (requirePermission), no por roles
 *   sueltos: la matriz vive en src/config/permission-matrix.ts.
 * - Ocultar un botón en el cliente NUNCA sustituye estas verificaciones.
 * - Mientras el usuario tenga una credencial temporal (mustChangePassword)
 *   solo puede consultar su perfil y cambiar su contraseña.
 */

type AuthorizationContext = {
  requestId?: string
  /** Ruta o recurso solicitado, solo para el registro de auditoría. */
  resource?: string
}

/** Usuario autenticado y vigente, o null. Memoizado por request (React cache). No lanza. */
export const getCurrentUser = cache(
  async (): Promise<AuthenticatedUser | null> => {
    const session = await auth()
    const userId = session?.user?.id
    if (!userId) return null

    return loadSessionUser(userId, session.user.sessionVersion)
  }
)

/** Exige sesión válida y usuario activo. Lanza UnauthorizedError (401) si no. */
export async function requireUser(): Promise<AuthenticatedUser> {
  const user = await getCurrentUser()
  if (!user) throw new UnauthorizedError()
  return user
}

export function can(
  user: Pick<AuthenticatedUser, "role" | "mustChangePassword"> | null,
  permission: Permission
): boolean {
  return (
    !!user &&
    !user.mustChangePassword &&
    roleHasPermission(user.role, permission)
  )
}

/**
 * Exige sesión + permiso. 401 sin sesión; 403 sin permiso (y deja
 * registro ACCESS_DENIED en auditoría).
 */
export async function requirePermission(
  permission: Permission,
  ctx: AuthorizationContext = {}
): Promise<AuthenticatedUser> {
  const user = await requireUser()

  if (user.mustChangePassword) {
    throw new ForbiddenError(
      "Debes cambiar tu contraseña temporal antes de continuar"
    )
  }

  if (!roleHasPermission(user.role, permission)) {
    await auditDenied(user, permission, ctx)
    throw new ForbiddenError()
  }

  return user
}

/** Para Server Components: sin sesión vigente → /login (no lanza 401). */
export async function requirePageUser(): Promise<AuthenticatedUser> {
  const user = await getCurrentUser()
  if (!user) redirect("/login")
  return user
}

/**
 * Variante para Server Components (páginas): sin sesión → /login; sin
 * permiso → pantalla de acceso denegado.
 */
export async function requirePagePermission(
  permission: Permission,
  resource?: string
): Promise<AuthenticatedUser> {
  const user = await requirePageUser()

  if (!can(user, permission)) {
    if (!user.mustChangePassword) {
      await auditDenied(user, permission, { resource })
    }
    redirect("/dashboard/access-denied")
  }

  return user
}

async function auditDenied(
  user: AuthenticatedUser,
  permission: Permission,
  ctx: AuthorizationContext
) {
  await recordAuditSafe({
    action: AUDIT_ACTIONS.ACCESS_DENIED,
    entityType: "Permission",
    entityId: permission,
    actorUserId: user.id,
    result: "DENIED",
    requestId: ctx.requestId,
    metadata: { role: user.role, resource: ctx.resource },
  })
  // Módulo 15 §19: un intento de acceso administrativo no autorizado es una
  // incidencia (una abierta por usuario y capacidad; no se duplica).
  const severity = SENSITIVE_PERMISSIONS[permission]
  if (severity) {
    try {
      const { raiseIncident } =
        await import("@/modules/incidents/incident.service")
      await raiseIncident({
        source: "SECURITY",
        fingerprint: `security:denied:${user.id}:${permission}`,
        title: `Acceso administrativo denegado: ${permission}`,
        description: `${user.name} (${user.role}) intentó usar «${permission}» en ${ctx.resource ?? "un recurso protegido"} sin autorización.`,
        severity,
        entityType: "User",
        entityId: user.id,
        actorId: user.id,
        requestId: ctx.requestId,
      })
    } catch {
      // La incidencia es complementaria: la denegación ya quedó auditada.
    }
  }
}

/** Capacidades cuyo intento no autorizado abre una incidencia de seguridad. */
const SENSITIVE_PERMISSIONS: Partial<Record<Permission, "HIGH" | "CRITICAL">> =
  {
    [PERMISSIONS.RECOVERY_MANAGE]: "CRITICAL",
    [PERMISSIONS.ROLES_MANAGE]: "HIGH",
    [PERMISSIONS.USERS_CREATE]: "HIGH",
    [PERMISSIONS.USERS_UPDATE]: "HIGH",
    [PERMISSIONS.USERS_DISABLE]: "HIGH",
    [PERMISSIONS.USERS_RESET_PASSWORD]: "HIGH",
    [PERMISSIONS.SETTINGS_MANAGE]: "HIGH",
    [PERMISSIONS.AUDIT_SECURITY_READ]: "HIGH",
  }
