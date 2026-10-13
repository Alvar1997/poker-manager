import "server-only"

import { Prisma } from "@/generated/prisma/client"
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@/lib/errors"
import { generateTemporaryPassword, hashPassword } from "@/lib/password"
import { prisma } from "@/lib/prisma"
import {
  AUDIT_ACTIONS,
  recordAudit,
  type DbClient,
} from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import {
  publicUserSelect,
  toPublicUser,
  type CreatedUserResult,
  type PublicUser,
} from "@/modules/users/user.dto"
import {
  createUserSchema,
  type CreateUserInput,
  type ListUsersQuery,
  type UpdateUserInput,
} from "@/modules/users/user.schemas"

/**
 * Administración de usuarios. Los permisos (users:*, roles:manage) los
 * verifica el Route Handler antes de llamar aquí; este servicio aplica
 * las reglas de negocio que valen sin importar quién llame:
 *
 * - Nunca puede quedar el sistema sin un SUPERADMIN activo.
 * - Nadie cambia su propio rol ni se desactiva a sí mismo.
 * - No hay borrado físico: solo activar/desactivar (conserva historial).
 * - Cambiar rol, desactivar o restablecer contraseña incrementa
 *   sessionVersion → las sesiones abiertas del usuario afectado caducan.
 * - Toda mutación audita dentro de la misma transacción.
 *
 * Las operaciones que pueden afectar al conteo de SUPERADMIN corren con
 * aislamiento Serializable para que dos cambios concurrentes no dejen el
 * sistema sin administrador.
 */

export async function listUsers(query: ListUsersQuery): Promise<PublicUser[]> {
  const where: Prisma.UserWhereInput = {}

  if (query.q) {
    where.OR = [
      { name: { contains: query.q, mode: "insensitive" } },
      { email: { contains: query.q, mode: "insensitive" } },
    ]
  }
  if (query.role) where.role = query.role
  if (query.status === "active") where.isActive = true
  if (query.status === "inactive") where.isActive = false

  const users = await prisma.user.findMany({
    where,
    select: publicUserSelect,
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    take: 500,
  })

  return users.map(toPublicUser)
}

export async function getUserById(id: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({
    where: { id },
    select: publicUserSelect,
  })
  if (!user) throw new NotFoundError("Usuario no encontrado")
  return toPublicUser(user)
}

export async function createUser(
  actor: SessionUser,
  rawInput: CreateUserInput,
  ctx: RequestContext = {}
): Promise<CreatedUserResult> {
  const input = createUserSchema.parse(rawInput)
  const temporaryPassword = generateTemporaryPassword()
  const passwordHash = await hashPassword(temporaryPassword)

  try {
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          name: input.name,
          email: input.email,
          role: input.role,
          isActive: input.isActive,
          passwordHash,
          mustChangePassword: true,
          createdById: actor.id,
          updatedById: actor.id,
        },
        select: publicUserSelect,
      })

      await recordAudit(
        {
          action: AUDIT_ACTIONS.USER_CREATED,
          entityType: "User",
          entityId: created.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            email: created.email,
            role: created.role,
            isActive: created.isActive,
          },
        },
        tx
      )

      return created
    })

    return { user: toPublicUser(user), temporaryPassword }
  } catch (error) {
    throw mapUniqueEmailError(error)
  }
}

export async function updateUser(
  actor: SessionUser,
  targetId: string,
  input: UpdateUserInput,
  ctx: RequestContext = {}
): Promise<PublicUser> {
  try {
    const updated = await serializable(async (tx) => {
      const current = await findUserForUpdate(tx, targetId)

      const roleChanges =
        input.role !== undefined && input.role !== current.role
      if (roleChanges && targetId === actor.id) {
        throw new ForbiddenError("No puedes cambiar tu propio rol")
      }
      if (roleChanges && current.role === "SUPERADMIN" && current.isActive) {
        await assertAnotherActiveSuperadmin(tx, targetId)
      }

      const changes: Record<string, { from: unknown; to: unknown }> = {}
      if (input.name !== undefined && input.name !== current.name) {
        changes.name = { from: current.name, to: input.name }
      }
      if (input.email !== undefined && input.email !== current.email) {
        changes.email = { from: current.email, to: input.email }
      }

      const user = await tx.user.update({
        where: { id: targetId },
        data: {
          name: input.name,
          email: input.email,
          role: input.role,
          updatedById: actor.id,
          ...(roleChanges ? { sessionVersion: { increment: 1 } } : {}),
        },
        select: publicUserSelect,
      })

      if (Object.keys(changes).length > 0) {
        await recordAudit(
          {
            action: AUDIT_ACTIONS.USER_UPDATED,
            entityType: "User",
            entityId: targetId,
            actorUserId: actor.id,
            requestId: ctx.requestId,
            metadata: { changes },
          },
          tx
        )
      }
      if (roleChanges) {
        await recordAudit(
          {
            action: AUDIT_ACTIONS.USER_ROLE_CHANGED,
            entityType: "User",
            entityId: targetId,
            actorUserId: actor.id,
            requestId: ctx.requestId,
            metadata: {
              from: current.role,
              to: input.role,
              sessionsInvalidated: true,
            },
          },
          tx
        )
      }

      return user
    })

    return toPublicUser(updated)
  } catch (error) {
    throw mapUniqueEmailError(error)
  }
}

export async function setUserStatus(
  actor: SessionUser,
  targetId: string,
  isActive: boolean,
  ctx: RequestContext = {}
): Promise<PublicUser> {
  const updated = await serializable(async (tx) => {
    const current = await findUserForUpdate(tx, targetId)

    if (current.isActive === isActive) {
      // Idempotente: sin cambio, sin auditoría duplicada.
      return tx.user.findUniqueOrThrow({
        where: { id: targetId },
        select: publicUserSelect,
      })
    }

    if (!isActive) {
      if (targetId === actor.id) {
        throw new BusinessRuleError("No puedes desactivar tu propia cuenta")
      }
      if (current.role === "SUPERADMIN") {
        await assertAnotherActiveSuperadmin(tx, targetId)
      }
    }

    const user = await tx.user.update({
      where: { id: targetId },
      data: {
        isActive,
        updatedById: actor.id,
        ...(isActive ? {} : { sessionVersion: { increment: 1 } }),
      },
      select: publicUserSelect,
    })

    await recordAudit(
      {
        action: isActive
          ? AUDIT_ACTIONS.USER_ACTIVATED
          : AUDIT_ACTIONS.USER_DEACTIVATED,
        entityType: "User",
        entityId: targetId,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: isActive ? undefined : { sessionsInvalidated: true },
      },
      tx
    )

    return user
  })

  return toPublicUser(updated)
}

/**
 * Restablecimiento por SUPERADMIN: genera una credencial temporal que se
 * muestra una sola vez, obliga a cambiarla en el siguiente acceso e
 * invalida las sesiones abiertas del usuario. No se envía por correo.
 */
export async function resetUserPassword(
  actor: SessionUser,
  targetId: string,
  ctx: RequestContext = {}
): Promise<CreatedUserResult> {
  if (targetId === actor.id) {
    throw new BusinessRuleError(
      "Para cambiar tu propia contraseña usa la opción de tu perfil"
    )
  }

  const temporaryPassword = generateTemporaryPassword()
  const passwordHash = await hashPassword(temporaryPassword)

  const user = await prisma.$transaction(async (tx) => {
    await findUserForUpdate(tx, targetId)

    const updated = await tx.user.update({
      where: { id: targetId },
      data: {
        passwordHash,
        mustChangePassword: true,
        passwordChangedAt: new Date(),
        sessionVersion: { increment: 1 },
        updatedById: actor.id,
      },
      select: publicUserSelect,
    })

    await recordAudit(
      {
        action: AUDIT_ACTIONS.USER_PASSWORD_RESET,
        entityType: "User",
        entityId: targetId,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: { sessionsInvalidated: true, temporaryCredential: true },
      },
      tx
    )

    return updated
  })

  return { user: toPublicUser(user), temporaryPassword }
}

async function findUserForUpdate(db: DbClient, id: string) {
  const user = await db.user.findUnique({
    where: { id },
    select: { id: true, name: true, email: true, role: true, isActive: true },
  })
  if (!user) throw new NotFoundError("Usuario no encontrado")
  return user
}

async function assertAnotherActiveSuperadmin(db: DbClient, exceptId: string) {
  const others = await db.user.count({
    where: { role: "SUPERADMIN", isActive: true, id: { not: exceptId } },
  })
  if (others === 0) {
    throw new BusinessRuleError(
      "El sistema debe conservar al menos un SUPERADMIN activo"
    )
  }
}

async function serializable<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  try {
    return await prisma.$transaction(fn, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    })
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2034"
    ) {
      throw new ConflictError(
        "Otro cambio simultáneo afectó a este usuario. Intenta de nuevo."
      )
    }
    throw error
  }
}

function mapUniqueEmailError(error: unknown): unknown {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    return new ConflictError("Ya existe un usuario con ese correo")
  }
  return error
}
