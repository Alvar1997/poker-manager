import { z } from "zod"

import { ROLES } from "@/config/permission-matrix"
import { ValidationError } from "@/lib/errors"
import { emailSchema, personNameSchema } from "@/modules/auth/auth.schemas"

/**
 * Schemas de administración de usuarios (exclusiva de SUPERADMIN).
 * `strictObject`: campos no previstos (passwordHash, sessionVersion,
 * createdById, lastLoginAt…) se rechazan con 400.
 */

export const roleSchema = z.enum(ROLES, {
  message: "Rol inválido",
})

export const userIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Identificador inválido")

/** Valida el segmento `[id]` de una ruta dinámica. */
export async function parseUserIdParam(
  params: Promise<{ id: string }>
): Promise<string> {
  const { id } = await params
  const parsed = userIdSchema.safeParse(id)
  if (!parsed.success) throw new ValidationError("Identificador inválido")
  return parsed.data
}

export const createUserSchema = z.strictObject({
  name: personNameSchema,
  email: emailSchema,
  role: roleSchema,
  isActive: z.boolean().default(true),
})

export type CreateUserInput = z.input<typeof createUserSchema>

export const updateUserSchema = z
  .strictObject({
    name: personNameSchema.optional(),
    email: emailSchema.optional(),
    role: roleSchema.optional(),
  })
  .refine(
    (data) => Object.values(data).some((value) => value !== undefined),
    "Indica al menos un campo a modificar"
  )

export type UpdateUserInput = z.infer<typeof updateUserSchema>

export const userStatusSchema = z.strictObject({
  isActive: z.boolean({ message: "isActive debe ser true o false" }),
})

export type UserStatusInput = z.infer<typeof userStatusSchema>

export const USER_STATUS_FILTERS = ["all", "active", "inactive"] as const

export const listUsersQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  role: roleSchema.optional(),
  status: z.enum(USER_STATUS_FILTERS).default("all"),
})

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>
