import "server-only"

import { auth } from "@/lib/auth"
import { ForbiddenError, UnauthorizedError } from "@/lib/errors"

export type Role = "SUPERADMIN" | "PARTNER" | "CASHIER"

export const ROLES: readonly Role[] = ["SUPERADMIN", "PARTNER", "CASHIER"]

export type AuthenticatedUser = {
  id: string
  name?: string | null
  email?: string | null
  role: Role
  isActive: boolean
}

/**
 * Infraestructura central de autorización — Módulo 00.
 *
 * Reglas:
 * - Toda verificación vive en el servidor (Route Handlers / Server
 *   Components). Ocultar un botón en el cliente NUNCA sustituye esto.
 * - Un cliente nunca puede autoasignarse un rol: el rol siempre se lee
 *   de la sesión firmada en el servidor (JWT), jamás de un parámetro de
 *   la request.
 * - El set de permisos detallado por rol (qué puede hacer cada uno sobre
 *   cada entidad) se construye en el Módulo 01. Aquí solo existe la
 *   infraestructura: obtener el usuario, verificar sesión/estado/rol.
 */

/** Usuario autenticado actual, o `null` si no hay sesión. No lanza. */
export async function getCurrentUser(): Promise<AuthenticatedUser | null> {
  const session = await auth()
  if (!session?.user) return null

  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    role: session.user.role,
    isActive: session.user.isActive,
  }
}

/** Exige una sesión válida y un usuario activo. Lanza UnauthorizedError si no. */
export async function requireUser(): Promise<AuthenticatedUser> {
  const user = await getCurrentUser()

  if (!user || !user.isActive) {
    throw new UnauthorizedError()
  }

  return user
}

/** Exige una sesión válida, activa, y con uno de los roles permitidos. */
export async function requireRole(
  ...allowed: readonly Role[]
): Promise<AuthenticatedUser> {
  const user = await requireUser()

  if (!allowed.includes(user.role)) {
    throw new ForbiddenError(
      `Esta acción requiere uno de los siguientes roles: ${allowed.join(", ")}`
    )
  }

  return user
}

/** true/false sin lanzar — útil para condicionar UI en Server Components (no como única defensa). */
export async function hasRole(...allowed: readonly Role[]): Promise<boolean> {
  const user = await getCurrentUser()
  return !!user && user.isActive && allowed.includes(user.role)
}
