import type { Prisma } from "@/generated/prisma/client"
import type { Role } from "@/config/permission-matrix"

/**
 * Forma pública (sanitizada) de un usuario. Toda lectura de usuarios
 * que termine en una respuesta HTTP o en una pantalla usa este `select`
 * explícito: passwordHash y sessionVersion nunca salen de la base.
 */
export const publicUserSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  mustChangePassword: true,
  lastLoginAt: true,
  passwordChangedAt: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { id: true, name: true } },
  updatedBy: { select: { id: true, name: true } },
} satisfies Prisma.UserSelect

type PublicUserRecord = Prisma.UserGetPayload<{
  select: typeof publicUserSelect
}>

/** Tipo serializable (fechas ISO) apto para cliente y respuestas JSON. */
export type PublicUser = {
  id: string
  name: string
  email: string
  role: Role
  isActive: boolean
  mustChangePassword: boolean
  lastLoginAt: string | null
  passwordChangedAt: string | null
  createdAt: string
  updatedAt: string
  createdBy: { id: string; name: string } | null
  updatedBy: { id: string; name: string } | null
}

export function toPublicUser(user: PublicUserRecord): PublicUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    passwordChangedAt: user.passwordChangedAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    createdBy: user.createdBy,
    updatedBy: user.updatedBy,
  }
}

/** Respuesta de alta/restablecimiento. La credencial temporal se muestra UNA vez y nunca se guarda en claro. */
export type CreatedUserResult = {
  user: PublicUser
  temporaryPassword: string
}
