import { z } from "zod"

import { positiveMoneySchema } from "@/lib/money"
import { idempotencyKeySchema } from "@/modules/sessions/session.schemas"
import {
  idSchema,
  nonNegativeMoneySchema,
} from "@/modules/settlements/settlement.schemas"

/**
 * Schemas del rake (Módulo 18). El cliente nunca envía la hora REAL de
 * captura, el responsable, la mesa lógica derivada, el modo vigente ni
 * importes calculados (reconocido, diferencia): `z.strictObject` → 400.
 */

const notes = z
  .string()
  .trim()
  .max(500)
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional()

/** Hora efectiva declarada para capturas atrasadas (ISO); nunca futura. */
const effectiveAt = z
  .string()
  .datetime({ offset: true, message: "Hora inválida" })
  .optional()

export const rakeEntrySchema = z.strictObject({
  amount: positiveMoneySchema,
  /** Ciclo cerrado de la sesión (captura atrasada); por defecto, el abierto. */
  cycleId: idSchema.optional(),
  effectiveAt,
  notes,
  idempotencyKey: idempotencyKeySchema,
})
export type RakeEntryInput = z.infer<typeof rakeEntrySchema>

const signedMoney = z
  .string()
  .trim()
  .regex(/^-?\d{1,10}(\.\d{1,2})?$/, "Importe inválido")
  .refine((v) => /[1-9]/.test(v), "La corrección no puede ser $0")

/**
 * Corrección auditable (±): de un registro manual (`movementId`) o del
 * conteo final del ciclo. Motivo obligatorio; lo original no cambia.
 */
export const rakeCorrectionSchema = z.strictObject({
  cycleId: idSchema,
  movementId: idSchema.optional(),
  amount: signedMoney,
  reason: z
    .string()
    .trim()
    .min(10, "Explica el motivo (mínimo 10 caracteres)")
    .max(500),
  idempotencyKey: idempotencyKeySchema,
})
export type RakeCorrectionInput = z.infer<typeof rakeCorrectionSchema>

export const rakeCountSchema = z.strictObject({
  cycleId: idSchema,
  countedAmount: nonNegativeMoneySchema,
  /** Obligatorio si el recipiente estaba vacío ($0). */
  zeroConfirmed: z.literal(true).optional(),
  /** El cajero declara que contó físicamente el recipiente. */
  physicallyCounted: z.literal(true, {
    message: "Confirma que contaste físicamente las fichas del recipiente",
  }),
  notes,
  idempotencyKey: idempotencyKeySchema,
})
export type RakeCountInput = z.infer<typeof rakeCountSchema>

export const rakeModeSchema = z.strictObject({
  mode: z.enum(["MANUAL", "FINAL_COUNT"]),
  reason: z.string().trim().min(5).max(300),
})
export type RakeModeInput = z.infer<typeof rakeModeSchema>
