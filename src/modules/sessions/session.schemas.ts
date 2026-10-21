import { z } from "zod"

import { ValidationError } from "@/lib/errors"
import { SESSION_STATUSES } from "@/modules/sessions/session.state"

/**
 * Schemas de sesiones. El cliente NUNCA envía folio, creador, estado ni
 * fechas reales: `z.strictObject` rechaza esos campos (400).
 */

const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Identificador inválido")

export const idempotencyKeySchema = z
  .string({ message: "Falta la clave de idempotencia" })
  .min(8)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/, "Clave de idempotencia inválida")

const notes = z
  .string()
  .trim()
  .max(500)
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional()

export const createSessionSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
  notes,
})
export type CreateSessionInput = z.infer<typeof createSessionSchema>

export const openSessionSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
})

export const cancelSessionSchema = z.strictObject({
  reason: z
    .string({ message: "El motivo es obligatorio" })
    .trim()
    .min(5, "Explica el motivo de la cancelación (mínimo 5 caracteres)")
    .max(300),
})

/** Caja inicial: el usuario declara que contó físicamente el efectivo. */
export const openingCashSchema = z
  .strictObject({
    countedAmount: z
      .string({ message: "Captura el efectivo contado" })
      .trim()
      .regex(/^\d{1,10}(\.\d{1,2})?$/, "Importe inválido (hasta 2 decimales)"),
    physicallyVerified: z.literal(true, {
      message: "Confirma que contaste físicamente el efectivo de la caja",
    }),
    explanation: z.string().trim().max(500).optional(),
  })
  .refine(
    (d) => Number(d.countedAmount) === 0 || (d.explanation ?? "").length >= 5,
    {
      path: ["explanation"],
      message:
        "Hay efectivo en la caja: explica su procedencia (se debe retirar antes de abrir)",
    }
  )
export type OpeningCashInput = z.infer<typeof openingCashSchema>

export const sessionsQuerySchema = z.object({
  status: z.enum(SESSION_STATUSES).optional(),
  q: z.string().trim().max(30).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  sort: z.enum(["desc", "asc"]).default("desc"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
})
export type SessionsQuery = z.infer<typeof sessionsQuerySchema>

export async function parseSessionIdParam(
  params: Promise<{ id: string }>
): Promise<string> {
  const { id } = await params
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) throw new ValidationError("Identificador inválido")
  return parsed.data
}
