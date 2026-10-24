import { z } from "zod"

import { positiveMoneySchema } from "@/lib/money"
import { idempotencyKeySchema } from "@/modules/sessions/session.schemas"
import {
  idSchema,
  nonNegativeMoneySchema,
} from "@/modules/settlements/settlement.schemas"

/**
 * Schemas del staff y propinas (Módulo 18, simplificado). El cliente nunca
 * envía totales, el estado, la hora ni el responsable (`z.strictObject`).
 */

const notes = z
  .string()
  .trim()
  .max(500)
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional()

export const createStaffSchema = z.strictObject({
  name: z.string().trim().min(2, "Captura el nombre").max(120),
  positionId: idSchema,
  phone: z.string().trim().max(30).optional(),
  dealerId: idSchema.optional(),
  notes,
})
export type CreateStaffInput = z.infer<typeof createStaffSchema>

export const updateStaffSchema = z
  .strictObject({
    name: z.string().trim().min(2).max(120).optional(),
    positionId: idSchema.optional(),
    phone: z.string().trim().max(30).nullable().optional(),
    isActive: z.boolean().optional(),
    notes,
  })
  .refine((v) => Object.keys(v).length > 0, "Nada que actualizar")
export type UpdateStaffInput = z.infer<typeof updateStaffSchema>

export const createPositionSchema = z.strictObject({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{1,29}$/, "Código en MAYÚSCULAS (A-Z, 0-9, _)"),
  name: z.string().trim().min(2).max(60),
})

export const addSessionStaffSchema = z.strictObject({
  staffMemberId: idSchema,
})

export const partialTipSchema = z.strictObject({
  amount: positiveMoneySchema,
  notes,
  idempotencyKey: idempotencyKeySchema,
})
export type PartialTipInput = z.infer<typeof partialTipSchema>

export const saveTipCountSchema = z.strictObject({
  amount: nonNegativeMoneySchema,
  /** Versión del borrador que se está editando (omitir al crearlo). */
  expectedVersion: z.number().int().min(1).optional(),
})
export type SaveTipCountInput = z.infer<typeof saveTipCountSchema>

export const confirmTipCountSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  /** Debe coincidir con el borrador guardado (evita confirmar otra cifra). */
  amount: nonNegativeMoneySchema,
  zeroConfirmed: z.literal(true).optional(),
  physicallyReceived: z.literal(true, {
    message: "Confirma que recibiste físicamente las fichas contadas",
  }),
})
export type ConfirmTipCountInput = z.infer<typeof confirmTipCountSchema>

export const correctTipCountSchema = z.strictObject({
  amount: z
    .string()
    .trim()
    .regex(/^-?\d{1,10}(\.\d{1,2})?$/, "Importe inválido")
    .refine((v) => /[1-9]/.test(v), "La corrección no puede ser $0"),
  reason: z
    .string()
    .trim()
    .min(10, "Explica el motivo (mínimo 10 caracteres)")
    .max(500),
  idempotencyKey: idempotencyKeySchema,
})
export type CorrectTipCountInput = z.infer<typeof correctTipCountSchema>
