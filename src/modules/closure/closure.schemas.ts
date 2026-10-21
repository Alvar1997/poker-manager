import { z } from "zod"

import { ValidationError } from "@/lib/errors"
import { positiveMoneySchema } from "@/lib/money"
import { idempotencyKeySchema } from "@/modules/sessions/session.schemas"

/**
 * Schemas del Módulo 12. El cliente NUNCA envía importes esperados, saldos,
 * diferencias, estados, fechas reales, el autorizador ni "aprobado = true":
 * todo lo calcula el servidor bajo bloqueo. `z.strictObject` → 400.
 */

const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Identificador inválido")

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional()

const reason = (message: string) =>
  z
    .string({ message })
    .trim()
    .min(5, `${message} (mínimo 5 caracteres)`)
    .max(500)

/** Monto ≥ 0 (el efectivo contado puede ser $0), como string. */
const countedMoneySchema = z
  .string({ message: "Captura el efectivo contado" })
  .trim()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, "Importe inválido (hasta 2 decimales)")

export const startClosingSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
  notes: optionalText(500),
})
export type StartClosingInput = z.infer<typeof startClosingSchema>

export const returnToOpenSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
  reason: reason("Explica qué operación real quedó pendiente"),
  /** Hora INFORMADA en que ocurrió la operación olvidada (opcional). */
  forgottenOperationAt: z.iso
    .datetime({ offset: true, message: "Fecha y hora inválidas" })
    .optional(),
})
export type ReturnToOpenInput = z.infer<typeof returnToOpenSchema>

export const inventoryCountActionSchema = z.discriminatedUnion("action", [
  /** Inicia (o retoma) el arqueo global; si el último tuvo diferencia, es un recuento. */
  z.strictObject({ action: z.literal("start") }),
  z.strictObject({
    action: z.literal("confirm"),
    countId: idSchema,
    idempotencyKey: idempotencyKeySchema,
  }),
])
export type InventoryCountActionInput = z.infer<
  typeof inventoryCountActionSchema
>

export const cashCountSchema = z
  .strictObject({
    countedAmount: countedMoneySchema,
    physicallyCounted: z.literal(true, {
      message: "Confirma que contaste físicamente el efectivo de la caja",
    }),
    details: z
      .array(
        z.strictObject({
          unitValue: positiveMoneySchema,
          quantity: z.number().int().min(0).max(1_000_000),
        })
      )
      .max(30)
      .optional(),
    notes: optionalText(500),
    explanation: optionalText(500),
  })
  .refine(
    (d) =>
      !d.details ||
      new Set(d.details.map((x) => Number(x.unitValue))).size ===
        d.details.length,
    { path: ["details"], message: "Denominación repetida en el desglose" }
  )
export type CashCountInput = z.infer<typeof cashCountSchema>

export const cashWithdrawalSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
  /** Importe que el operador entrega: debe ser EXACTAMENTE el disponible. */
  amount: positiveMoneySchema,
  recipientName: z
    .string({ message: "Indica quién recibe el efectivo" })
    .trim()
    .min(3, "Indica quién recibe el efectivo (mínimo 3 caracteres)")
    .max(120),
  recipientUserId: idSchema.optional(),
  physicallyDelivered: z.literal(true, {
    message: "Confirma que entregaste físicamente el efectivo",
  }),
  notes: optionalText(500),
})
export type CashWithdrawalInput = z.infer<typeof cashWithdrawalSchema>

export const resolveDiscrepancySchema = z.discriminatedUnion("action", [
  /** Seguimiento de la investigación (no cambia importes ni resuelve). */
  z.strictObject({
    action: z.literal("note"),
    notes: z
      .string({ message: "Escribe la observación" })
      .trim()
      .min(3)
      .max(1000),
  }),
  /** Ajuste EXCEPCIONAL autorizado (solo PARTNER/SUPERADMIN). */
  z.strictObject({
    action: z.literal("authorize-adjustment"),
    idempotencyKey: idempotencyKeySchema,
    reason: reason("Explica el motivo del ajuste excepcional"),
  }),
])
export type ResolveDiscrepancyInput = z.infer<typeof resolveDiscrepancySchema>

export const confirmClosureSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
  /** Huella del resumen que el autorizador revisó (GET …/closure/preview). */
  previewHash: z.string().regex(/^[a-f0-9]{64}$/, "Resumen inválido"),
  noActivityReason: z.string().trim().max(500).optional(),
})
export type ConfirmClosureInput = z.infer<typeof confirmClosureSchema>

export const reportShareEventSchema = z.strictObject({
  channel: z.enum(["NATIVE_SHARE", "COPY_TEXT", "DOWNLOAD"]),
})

export async function parseDiscrepancyIdParam(
  params: Promise<Record<string, string>>
): Promise<string> {
  const value = (await params).discrepancyId
  const parsed = idSchema.safeParse(value)
  if (!parsed.success) throw new ValidationError("Identificador inválido")
  return parsed.data
}
