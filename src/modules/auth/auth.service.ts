import "server-only"

import type { Role } from "@/config/permission-matrix"
import { NotFoundError, RateLimitError, ValidationError } from "@/lib/errors"
import { logger } from "@/lib/logger"
import { burnPasswordCheck, hashPassword, verifyPassword } from "@/lib/password"
import { prisma } from "@/lib/prisma"
import {
  AUDIT_ACTIONS,
  recordAudit,
  recordAuditSafe,
} from "@/modules/audit/audit.service"
import {
  loginSchema,
  type ChangePasswordInput,
  type UpdateProfileInput,
} from "@/modules/auth/auth.schemas"
import {
  clearFailures,
  emailThrottleKey,
  ipThrottleKey,
  isThrottled,
  registerFailure,
} from "@/modules/auth/login-throttle"
import {
  publicUserSelect,
  toPublicUser,
  type PublicUser,
} from "@/modules/users/user.dto"

/**
 * Lógica de autenticación: login con credenciales, validación del
 * usuario vigente en cada request, perfil propio y cambio de contraseña.
 * Los Route Handlers y src/lib/auth.ts solo orquestan; las reglas viven aquí.
 */

export type RequestContext = {
  requestId?: string
  ip?: string
}

/** Usuario autenticado tal como está HOY en la base (no como dice el JWT). */
export type SessionUser = {
  id: string
  name: string
  email: string
  role: Role
  isActive: boolean
  mustChangePassword: boolean
  sessionVersion: number
}

const sessionUserSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  mustChangePassword: true,
  sessionVersion: true,
} as const

/**
 * Resuelve el usuario de una sesión contra la base de datos. Devuelve
 * null si ya no existe, está desactivado o su sessionVersion cambió
 * (contraseña cambiada/restablecida, rol cambiado o cuenta desactivada
 * después de emitir el JWT). Así el rol y el estado vigentes nunca
 * dependen de lo que traiga el navegador.
 */
export async function loadSessionUser(
  userId: string,
  tokenSessionVersion: number | undefined
): Promise<SessionUser | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: sessionUserSelect,
  })

  if (!user || !user.isActive) return null
  if (user.sessionVersion !== (tokenSessionVersion ?? 0)) return null

  return user
}

export type AuthenticateResult =
  | {
      ok: true
      user: {
        id: string
        name: string
        email: string
        role: Role
        isActive: boolean
        sessionVersion: number
      }
    }
  | { ok: false; reason: "invalid" | "rate_limited" }

/**
 * Verifica credenciales para Auth.js (`authorize`). Respuesta genérica
 * ante cualquier fallo (cuenta inexistente, inactiva o contraseña
 * incorrecta) y tiempos equivalentes, para no permitir enumerar cuentas.
 */
export async function authenticateWithCredentials(
  rawCredentials: unknown,
  ctx: RequestContext = {}
): Promise<AuthenticateResult> {
  const parsed = loginSchema.safeParse(rawCredentials)
  if (!parsed.success) return { ok: false, reason: "invalid" }

  const email = parsed.data.email.toLowerCase()
  const { password } = parsed.data
  const ip = ctx.ip ?? "unknown"
  const keys = [emailThrottleKey(email), ipThrottleKey(ip)]

  if (await isThrottled(keys)) {
    await recordAuditSafe({
      action: AUDIT_ACTIONS.LOGIN_RATE_LIMITED,
      entityType: "Auth",
      result: "DENIED",
      requestId: ctx.requestId,
      metadata: { ip },
    })
    return { ok: false, reason: "rate_limited" }
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { ...sessionUserSelect, passwordHash: true },
  })

  let failureReason: "unknown_account" | "inactive" | "bad_password" | null =
    null

  if (!user) {
    await burnPasswordCheck(password)
    failureReason = "unknown_account"
  } else if (!user.isActive) {
    await burnPasswordCheck(password)
    failureReason = "inactive"
  } else if (!(await verifyPassword(password, user.passwordHash))) {
    failureReason = "bad_password"
  }

  if (failureReason || !user) {
    await registerFailure(keys)
    await recordAuditSafe({
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      entityType: "User",
      entityId: user?.id ?? null,
      result: "FAILURE",
      requestId: ctx.requestId,
      metadata: { reason: failureReason, ip },
    })
    return { ok: false, reason: "invalid" }
  }

  await clearFailures(emailThrottleKey(email))
  await prisma.user
    .update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
    .catch((error: unknown) => {
      // No bloquear el login por un fallo al actualizar lastLoginAt.
      logger.warn({ event: "login_last_login_update_failed", error })
    })
  await recordAuditSafe({
    action: AUDIT_ACTIONS.LOGIN_SUCCEEDED,
    entityType: "User",
    entityId: user.id,
    actorUserId: user.id,
    requestId: ctx.requestId,
    metadata: { ip },
  })

  return {
    ok: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      sessionVersion: user.sessionVersion,
    },
  }
}

export async function getProfile(userId: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: publicUserSelect,
  })
  if (!user) throw new NotFoundError("Usuario no encontrado")
  return toPublicUser(user)
}

/** Solo el nombre es editable por el propio usuario; correo y rol los administra SUPERADMIN. */
export async function updateProfile(
  actor: SessionUser,
  input: UpdateProfileInput,
  ctx: RequestContext = {}
): Promise<PublicUser> {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: actor.id },
      data: { name: input.name, updatedById: actor.id },
      select: publicUserSelect,
    })

    if (updated.name !== actor.name) {
      await recordAudit(
        {
          action: AUDIT_ACTIONS.PROFILE_UPDATED,
          entityType: "User",
          entityId: actor.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: { changes: { name: { from: actor.name, to: input.name } } },
        },
        tx
      )
    }

    return toPublicUser(updated)
  })
}

function passwordChangeThrottleKey(userId: string) {
  return { key: `password-change:${userId}`, limit: 5 }
}

/**
 * Cambio de contraseña propia. Incrementa sessionVersion: TODAS las
 * sesiones existentes del usuario (incluida la actual) dejan de ser
 * válidas y debe iniciar sesión de nuevo con la contraseña nueva.
 */
export async function changeOwnPassword(
  actor: SessionUser,
  input: ChangePasswordInput,
  ctx: RequestContext = {}
): Promise<void> {
  const throttleKey = passwordChangeThrottleKey(actor.id)
  if (await isThrottled([throttleKey])) {
    throw new RateLimitError()
  }

  const user = await prisma.user.findUnique({
    where: { id: actor.id },
    select: { passwordHash: true },
  })
  if (!user) throw new NotFoundError("Usuario no encontrado")

  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    await registerFailure([throttleKey])
    await recordAuditSafe({
      action: AUDIT_ACTIONS.PASSWORD_CHANGE_FAILED,
      entityType: "User",
      entityId: actor.id,
      actorUserId: actor.id,
      result: "FAILURE",
      requestId: ctx.requestId,
      metadata: { reason: "bad_current_password" },
    })
    throw new ValidationError("Datos inválidos", [
      {
        path: "currentPassword",
        message: "La contraseña actual es incorrecta",
      },
    ])
  }

  const passwordHash = await hashPassword(input.newPassword)

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: actor.id },
      data: {
        passwordHash,
        mustChangePassword: false,
        passwordChangedAt: new Date(),
        sessionVersion: { increment: 1 },
        updatedById: actor.id,
      },
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.PASSWORD_CHANGED,
        entityType: "User",
        entityId: actor.id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: { sessionsInvalidated: true },
      },
      tx
    )
  })

  await clearFailures(throttleKey)
}
