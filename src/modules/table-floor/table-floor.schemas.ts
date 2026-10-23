import { z } from "zod"

import { ValidationError } from "@/lib/errors"
import { idempotencyKeySchema } from "@/modules/sessions/session.schemas"
import { FELT_COLORS, SEAT_COUNT } from "@/modules/table-floor/table-floor.math"

/**
 * Schemas de la mesa interactiva. El cliente nunca envía fechas, ciclos,
 * responsables ni estados: el servidor los deriva (`z.strictObject` → 400).
 */
const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Identificador inválido")

export const seatNumberSchema = z.coerce
  .number({ message: "Asiento inválido" })
  .int("Asiento inválido")
  .min(1, "Asiento inválido")
  .max(SEAT_COUNT, "Asiento inválido")

/** Ocupar un asiento libre: con un jugador del directorio o con un jugador ya activo sin asiento. */
export const assignSeatSchema = z
  .strictObject({
    playerId: idSchema.optional(),
    participationId: idSchema.optional(),
    idempotencyKey: idempotencyKeySchema,
  })
  .refine((v) => Boolean(v.playerId) !== Boolean(v.participationId), {
    message: "Indica el jugador o la participación (solo uno)",
  })
export type AssignSeatInput = z.infer<typeof assignSeatSchema>

export const changeSeatSchema = z.strictObject({
  participationId: idSchema,
  toSeat: seatNumberSchema,
  idempotencyKey: idempotencyKeySchema,
})
export type ChangeSeatInput = z.infer<typeof changeSeatSchema>

export const withdrawSchema = z.strictObject({
  reason: z
    .string()
    .trim()
    .min(5, "Explica el motivo (mínimo 5 caracteres)")
    .max(300),
  idempotencyKey: idempotencyKeySchema,
})
export type WithdrawInput = z.infer<typeof withdrawSchema>

const personName = z
  .string()
  .trim()
  .min(2, "El nombre debe tener al menos 2 caracteres")
  .max(80)
const nickname = z.string().trim().max(40)

export const createDealerSchema = z.strictObject({
  name: personName,
  nickname: nickname.optional(),
})
export type CreateDealerInput = z.infer<typeof createDealerSchema>

export const updateDealerSchema = z
  .strictObject({
    name: personName.optional(),
    nickname: nickname.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Nada que actualizar",
  })
export type UpdateDealerInput = z.infer<typeof updateDealerSchema>

export const dealersQuerySchema = z.object({
  status: z.enum(["active", "inactive", "all"]).default("active"),
})

export const assignDealerSchema = z.strictObject({
  dealerId: idSchema,
  idempotencyKey: idempotencyKeySchema,
})
export type AssignDealerInput = z.infer<typeof assignDealerSchema>

export const releaseDealerSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
})

export const appearanceSchema = z.strictObject({
  feltColor: z.enum(FELT_COLORS, { message: "Color de paño no permitido" }),
})
export type AppearanceInput = z.infer<typeof appearanceSchema>

export const seatCandidatesQuerySchema = z.object({
  q: z.string().trim().min(2, "Escribe al menos 2 caracteres").max(60),
})

export async function parseIdParam(params: Promise<{ id: string }>) {
  const { id } = await params
  const r = idSchema.safeParse(id)
  if (!r.success) throw new ValidationError("Identificador inválido")
  return r.data
}

export async function parseSeatParams(
  params: Promise<{ id: string; tableId: string; seatNumber: string }>
) {
  const { id, tableId, seatNumber } = await params
  const a = idSchema.safeParse(id)
  const b = idSchema.safeParse(tableId)
  const c = seatNumberSchema.safeParse(seatNumber)
  if (!a.success || !b.success || !c.success)
    throw new ValidationError("Identificador inválido")
  return { sessionId: a.data, tableId: b.data, seatNumber: c.data }
}
