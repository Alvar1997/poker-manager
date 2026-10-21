import { z } from "zod"

import { ValidationError } from "@/lib/errors"
import { idempotencyKeySchema } from "@/modules/sessions/session.schemas"

/**
 * Schemas del Módulo 07. El cliente nunca envía fechas, responsables,
 * estados ni ciclos: el servidor los deriva (`z.strictObject` → 400).
 */
const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Identificador inválido")

export const openTableSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
})

export const closeTableSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
  notes: z.string().trim().max(300).optional(),
})

export const addPlayerSchema = z.strictObject({
  playerId: idSchema,
  idempotencyKey: idempotencyKeySchema,
})

export const transferSchema = z.strictObject({
  sourceParticipationId: idSchema,
  destinationTableId: idSchema,
  notes: z.string().trim().max(300).optional(),
  idempotencyKey: idempotencyKeySchema,
})
export type TransferInput = z.infer<typeof transferSchema>

export const participationsQuerySchema = z.object({
  status: z.enum(["ACTIVE", "TRANSFERRED", "SETTLED"]).optional(),
  tableId: idSchema.optional(),
})

export const historyQuerySchema = z.object({
  cycle: z.coerce.number().int().min(1).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
})
export type HistoryQuery = z.infer<typeof historyQuerySchema>

export async function parseTableParams(
  params: Promise<{ id: string; tableId: string }>
) {
  const { id, tableId } = await params
  const a = idSchema.safeParse(id)
  const b = idSchema.safeParse(tableId)
  if (!a.success || !b.success)
    throw new ValidationError("Identificador inválido")
  return { sessionId: a.data, tableId: b.data }
}

export async function parseParticipationParams(
  params: Promise<{ id: string; participationId: string }>
) {
  const { id, participationId } = await params
  const a = idSchema.safeParse(id)
  const b = idSchema.safeParse(participationId)
  if (!a.success || !b.success)
    throw new ValidationError("Identificador inválido")
  return { sessionId: a.data, participationId: b.data }
}
