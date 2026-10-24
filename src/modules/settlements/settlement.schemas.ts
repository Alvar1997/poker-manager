import { z } from "zod"

import { ValidationError } from "@/lib/errors"
import { positiveMoneySchema } from "@/lib/money"
import { idempotencyKeySchema } from "@/modules/sessions/session.schemas"
import { strokesSchema } from "@/modules/signatures/signature.strokes"

/**
 * Schemas del Módulo 11. El cliente captura SOLO el valor nominal total
 * devuelto, la decisión de compensar y (si es parcial) su importe. Nunca
 * envía denominaciones, la distribución FIFO, el neto, saldos, la sesión,
 * la mesa, el jugador, fechas, responsables ni "firmado = true":
 * `z.strictObject` → 400.
 */

export const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Identificador inválido")

/** Monto ≥ 0 (la devolución puede ser $0), hasta 2 decimales, como string. */
export const nonNegativeMoneySchema = z
  .string({ message: "Captura el valor nominal devuelto" })
  .trim()
  .regex(
    /^\d{1,10}(\.\d{1,2})?$/,
    "Importe inválido (hasta 2 decimales, sin signos)"
  )

export const offsetDecisionSchema = z.enum(
  ["NO_COMPENSATE", "PARTIAL", "MAXIMUM"],
  { message: "Elige si se compensa la deuda" }
)

const notes = z
  .string()
  .trim()
  .max(500)
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional()

const reference = z
  .string()
  .trim()
  .min(2, "Captura la referencia bancaria")
  .max(60)
  .refine((v) => !/\d{13,19}/.test(v.replace(/[\s-]/g, "")), {
    message:
      "No captures números de cuenta o tarjeta completos: solo la referencia.",
  })

function offsetAmountRule(
  v: { offsetDecision?: string; offsetAmount?: string | null },
  ctx: z.RefinementCtx
) {
  if (v.offsetDecision === "PARTIAL" && !v.offsetAmount)
    ctx.addIssue({
      code: "custom",
      path: ["offsetAmount"],
      message: "Indica el importe a compensar",
    })
  if (v.offsetDecision && v.offsetDecision !== "PARTIAL" && v.offsetAmount)
    ctx.addIssue({
      code: "custom",
      path: ["offsetAmount"],
      message:
        "Solo la compensación parcial lleva importe: el máximo lo calcula el sistema",
    })
}

export const createSettlementSchema = z
  .strictObject({
    participationId: idSchema,
    returnedNominalAmount: nonNegativeMoneySchema,
    offsetDecision: offsetDecisionSchema,
    offsetAmount: positiveMoneySchema.optional(),
    /** OUT: perdió todas sus fichas (retorno $0, sin compensación). */
    exitKind: z.enum(["CASHOUT", "OUT"]).optional(),
    notes,
    idempotencyKey: idempotencyKeySchema,
  })
  .superRefine(offsetAmountRule)
  .superRefine((v, ctx) => {
    if (
      v.exitKind === "OUT" &&
      (!/^0+(\.0{1,2})?$/.test(v.returnedNominalAmount) ||
        v.offsetDecision !== "NO_COMPENSATE")
    )
      ctx.addIssue({
        code: "custom",
        path: ["exitKind"],
        message: "OUT significa retorno de $0 sin compensación.",
      })
  })
export type CreateSettlementInput = z.infer<typeof createSettlementSchema>

export const updateSettlementDraftSchema = z
  .strictObject({
    expectedVersion: z.number().int().min(1),
    returnedNominalAmount: nonNegativeMoneySchema.optional(),
    offsetDecision: offsetDecisionSchema.optional(),
    offsetAmount: positiveMoneySchema.nullable().optional(),
    notes,
  })
  .superRefine(offsetAmountRule)
export type UpdateSettlementDraftInput = z.infer<
  typeof updateSettlementDraftSchema
>

export const cancelSettlementSchema = z.strictObject({
  reason: z
    .string({ message: "El motivo es obligatorio" })
    .trim()
    .min(5, "Explica el motivo de la cancelación (mínimo 5 caracteres)")
    .max(300),
})

export const confirmReturnSchema = z
  .strictObject({
    expectedVersion: z.number().int().min(1),
    /**
     * El cajero declara que recibió físicamente las fichas (obligatorio si
     * se devolvieron fichas). Con retorno $0 (OUT) no hay recepción: se usa
     * `zeroReturnConfirmed`.
     */
    chipsReceived: z.literal(true).optional(),
    /**
     * OBLIGATORIO cuando el retorno es $0: el jugador terminó sin fichas y
     * no conserva fichas de esta participación (nunca se asume).
     */
    zeroReturnConfirmed: z.literal(true).optional(),
    /** Pago inmediato en efectivo (opcional) dentro de la misma operación. */
    immediateCashAmount: positiveMoneySchema.optional(),
    cashDelivered: z.literal(true).optional(),
    idempotencyKey: idempotencyKeySchema,
  })
  .superRefine((v, ctx) => {
    if (v.immediateCashAmount && v.cashDelivered !== true)
      ctx.addIssue({
        code: "custom",
        path: ["cashDelivered"],
        message: "Confirma que entregaste el efectivo al jugador",
      })
  })
export type ConfirmReturnInput = z.infer<typeof confirmReturnSchema>

export const registerPayoutSchema = z.union([
  z.strictObject({
    method: z.literal("CASH"),
    amount: positiveMoneySchema,
    cashDelivered: z.literal(true, {
      message: "Confirma que entregaste el efectivo al jugador",
    }),
    notes,
    idempotencyKey: idempotencyKeySchema,
  }),
  z.strictObject({
    method: z.literal("BANK_TRANSFER"),
    amount: positiveMoneySchema,
    bankReference: reference.optional(),
    notes,
    idempotencyKey: idempotencyKeySchema,
  }),
])
export type RegisterPayoutInput = z.infer<typeof registerPayoutSchema>

export const resolvePayoutSchema = z.union([
  z.strictObject({
    outcome: z.literal("EXECUTED"),
    bankReference: reference,
    /** Quien confirma verificó en el banco que la transferencia salió. */
    executionVerified: z.literal(true, {
      message: "Confirma que verificaste la transferencia en el banco",
    }),
    executedAt: z.iso.datetime({ offset: true }).optional(),
    idempotencyKey: idempotencyKeySchema,
  }),
  z.strictObject({
    outcome: z.enum(["FAILED", "CANCELLED"]),
    reason: z
      .string()
      .trim()
      .min(5, "Explica qué ocurrió con la transferencia")
      .max(300),
    idempotencyKey: idempotencyKeySchema,
  }),
])
export type ResolvePayoutInput = z.infer<typeof resolvePayoutSchema>

export const reverseSettlementSchema = z.strictObject({
  reason: z.string().trim().min(10, "Explica el motivo del reverso").max(500),
  /** Si se devolvieron fichas: el cajero se las regresó físicamente al jugador. */
  chipsHandedBack: z.boolean().optional(),
  idempotencyKey: idempotencyKeySchema,
})
export type ReverseSettlementInput = z.infer<typeof reverseSettlementSchema>

export const SETTLEMENT_STATUSES = [
  "DRAFT",
  "READY_FOR_CONFIRMATION",
  "PENDING_PAYOUT",
  "COMPLETED",
  "CANCELLED",
  "REVERSED",
] as const

export const settlementsQuerySchema = z.object({
  status: z.enum(SETTLEMENT_STATUSES).optional(),
  sessionId: idSchema.optional(),
  playerId: idSchema.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
export type SettlementsQuery = z.infer<typeof settlementsQuerySchema>

/** Vista previa informativa antes de crear el borrador. */
export const draftPreviewQuerySchema = z
  .object({
    participationId: idSchema,
    returnedNominalAmount: nonNegativeMoneySchema,
    offsetDecision: offsetDecisionSchema,
    offsetAmount: positiveMoneySchema.optional(),
  })
  .superRefine(offsetAmountRule)

export const captureSettlementSignatureSchema = z.strictObject({
  snapshotId: idSchema,
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/, "Resumen inválido"),
  strokes: strokesSchema,
  idempotencyKey: idempotencyKeySchema,
})
export type CaptureSettlementSignatureInput = z.infer<
  typeof captureSettlementSignatureSchema
>

export const settlementReceiptShareSchema = z.strictObject({
  channel: z.enum(["NATIVE_SHARE", "DOWNLOAD", "COPY_TEXT"]),
  receiptId: idSchema.optional(),
})

export async function parseSettlementIdParam(params: Promise<{ id: string }>) {
  const { id } = await params
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) throw new ValidationError("Identificador inválido")
  return parsed.data
}

export function parseOptionalId(raw: string | null) {
  if (raw === null) return null
  const parsed = idSchema.safeParse(raw)
  if (!parsed.success) throw new ValidationError("Identificador inválido")
  return parsed.data
}
