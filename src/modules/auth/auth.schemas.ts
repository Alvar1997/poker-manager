import { z } from "zod"

/**
 * Schemas de autenticación y perfil. Se comparten entre cliente
 * (formularios) y servidor (Route Handlers) — la validación del servidor
 * es la que cuenta; la del cliente es solo UX.
 *
 * Los schemas de entrada son `strictObject`: cualquier campo no previsto
 * (p. ej. `role`, `isActive`, `passwordHash`) hace fallar la validación
 * con 400 en vez de ignorarse en silencio — así un intento de elevar
 * privilegios manipulando el body queda visible y nunca se aplica.
 */

/** `code` que Auth.js devuelve al cliente cuando el login está bloqueado temporalmente. */
export const LOGIN_RATE_LIMITED_CODE = "rate_limited"

export const PASSWORD_MIN_LENGTH = 12
/** bcrypt solo usa los primeros 72 bytes: más que eso daría una falsa sensación de seguridad. */
export const PASSWORD_MAX_BYTES = 72

export const emailSchema = z
  .string()
  .trim()
  .min(1, "El correo es requerido")
  .max(254, "Correo demasiado largo")
  .email("Correo inválido")
  .transform((email) => email.toLowerCase())

export const personNameSchema = z
  .string()
  .trim()
  .min(2, "El nombre debe tener al menos 2 caracteres")
  .max(80, "El nombre no puede exceder 80 caracteres")

export const newPasswordSchema = z
  .string()
  .min(
    PASSWORD_MIN_LENGTH,
    `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`
  )
  .refine(
    (value) => new TextEncoder().encode(value).length <= PASSWORD_MAX_BYTES,
    `La contraseña no puede exceder ${PASSWORD_MAX_BYTES} bytes`
  )
  .refine(
    (value) => /[A-Za-z]/.test(value) && /\d/.test(value),
    "La contraseña debe incluir letras y números"
  )

export const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "El correo es requerido")
    .email("Correo inválido"),
  password: z
    .string()
    .min(1, "La contraseña es requerida")
    .max(256, "Contraseña demasiado larga"),
})

export type LoginInput = z.infer<typeof loginSchema>

export const updateProfileSchema = z.strictObject({
  name: personNameSchema,
})

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>

const changePasswordBaseSchema = z.strictObject({
  currentPassword: z.string().min(1, "Ingresa tu contraseña actual").max(256),
  newPassword: newPasswordSchema,
  confirmPassword: z.string().min(1, "Confirma la nueva contraseña"),
})

export const changePasswordSchema = changePasswordBaseSchema
  .refine((data) => data.newPassword === data.confirmPassword, {
    path: ["confirmPassword"],
    message: "Las contraseñas no coinciden",
  })
  .refine((data) => data.newPassword !== data.currentPassword, {
    path: ["newPassword"],
    message: "La nueva contraseña debe ser distinta a la actual",
  })

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>
