import { z } from "zod"

import { ValidationError } from "@/lib/errors"
import { positiveMoneySchema } from "@/lib/money"
import { idempotencyKeySchema } from "@/modules/sessions/session.schemas"
import { strokesSchema } from "@/modules/signatures/signature.strokes"

/**
 * Schemas del Módulo 16. El cliente NUNCA envía saldos, estados, folios,
 * responsables, fechas, la distribución FIFO, el reembolso calculado ni
 * «firmado/recibido = true» como dato contable: los importes se derivan en
 * el servidor de movimientos reales. `z.strictObject` → 400 ante campos
 * no previstos.
 */

export const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Identificador inválido")

export async function parseIdParam(params: Promise<{ id: string }>) {
  const { id } = await params
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) throw new ValidationError("Identificador inválido")
  return parsed.data
}

/** Importe ≥ 0 (un canje puede aceptarse en $0 = rechazo), hasta 2 decimales. */
export const nonNegativeMoneySchema = z
  .string({ message: "Captura el importe" })
  .trim()
  .regex(
    /^\d{1,10}(\.\d{1,2})?$/,
    "Importe inválido (hasta 2 decimales, sin signos)"
  )

const reason = z
  .string({ message: "Indica el motivo" })
  .trim()
  .min(10, "Describe el motivo (al menos 10 caracteres)")
  .max(1000)

const optionalText = z.string().trim().max(500).optional()

const reference = z
  .string()
  .trim()
  .min(2, "Captura la referencia bancaria")
  .max(60)
  .refine((v) => !/\d{13,19}/.test(v.replace(/[\s-]/g, "")), {
    message:
      "No captures números de cuenta o tarjeta completos: solo la referencia.",
  })

const version = z.number().int().min(1)

export const createRedemptionSchema = z.strictObject({
  presenterName: z
    .string()
    .trim()
    .min(2, "Captura quién presenta las fichas")
    .max(120),
  playerId: idSchema.optional(),
  originSessionId: idSchema.optional(),
  originEvidence: optionalText,
  presentedNominal: positiveMoneySchema,
  notes: optionalText,
  idempotencyKey: idempotencyKeySchema,
})

const denominations = z
  .array(
    z.strictObject({
      denominationId: idSchema,
      quantity: z.number().int().min(0).max(100_000),
    })
  )
  .max(50)
  .optional()

export const validateRedemptionSchema = z.strictObject({
  expectedVersion: version,
  acceptedNominal: nonNegativeMoneySchema,
  denominations,
  notes: reason,
})

export const previewRedemptionSchema = z.strictObject({
  acceptedNominal: nonNegativeMoneySchema,
  denominations,
})

export const confirmRedemptionReceiptSchema = z.strictObject({
  expectedVersion: version,
  physicalReceiptConfirmed: z.literal(true, {
    message: "Confirma la recepción física de las fichas",
  }),
  strokes: strokesSchema,
  idempotencyKey: idempotencyKeySchema,
})

export const cancelSchema = z.strictObject({
  expectedVersion: version,
  reason,
})

export const registerPayoutSchema = z
  .strictObject({
    method: z.enum(["CASH", "BANK_TRANSFER"], { message: "Elige el método" }),
    funding: z.enum(["ADMIN_CUSTODY", "SESSION_CASH"]).optional(),
    amount: positiveMoneySchema,
    bankReference: reference.optional(),
    notes: optionalText,
    idempotencyKey: idempotencyKeySchema,
  })
  .superRefine((v, ctx) => {
    if (v.method === "BANK_TRANSFER" && v.funding)
      ctx.addIssue({
        code: "custom",
        path: ["funding"],
        message: "Una transferencia sale del banco: no elijas efectivo.",
      })
  })

export const resolvePayoutSchema = z
  .strictObject({
    outcome: z.enum(["EXECUTED", "FAILED", "CANCELLED"]),
    bankReference: reference.optional(),
    reason: optionalText,
    idempotencyKey: idempotencyKeySchema,
  })
  .superRefine((v, ctx) => {
    if (v.outcome === "EXECUTED" && !v.bankReference)
      ctx.addIssue({
        code: "custom",
        path: ["bankReference"],
        message: "Captura la referencia de la transferencia realizada.",
      })
    if (v.outcome !== "EXECUTED" && !v.reason)
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Indica el motivo.",
      })
  })

export const purchaseReversalPreviewSchema = z.strictObject({
  physicalReturnConfirmed: z.boolean().optional(),
  returnedNominal: nonNegativeMoneySchema.optional(),
})

export const executePurchaseReversalSchema = z.strictObject({
  correctionId: idSchema,
  expectedVersion: version,
  // Puede ser false: el servidor lo BLOQUEA y lo audita (nunca lo simula).
  physicalReturnConfirmed: z.boolean(),
  returnedNominal: nonNegativeMoneySchema,
  reason,
  idempotencyKey: idempotencyKeySchema,
})

const correctionKind = z.enum(["ADDITIONAL_PAYOUT", "OFFSET_REVERSAL"], {
  message: "Elige el tipo de corrección",
})

function amountRule(
  v: { kind?: string; amount?: string },
  ctx: z.RefinementCtx
) {
  if (v.kind === "ADDITIONAL_PAYOUT" && !v.amount)
    ctx.addIssue({
      code: "custom",
      path: ["amount"],
      message: "Captura el importe adicional.",
    })
  if (v.kind === "OFFSET_REVERSAL" && v.amount)
    ctx.addIssue({
      code: "custom",
      path: ["amount"],
      message: "El importe de la compensación lo calcula el servidor.",
    })
}

export const settlementCorrectionPreviewSchema = z
  .strictObject({
    kind: correctionKind,
    amount: positiveMoneySchema.optional(),
  })
  .superRefine(amountRule)

export const executeSettlementCorrectionSchema = z
  .strictObject({
    kind: correctionKind,
    amount: positiveMoneySchema.optional(),
    correctionId: idSchema,
    expectedVersion: version,
    reason,
    strokes: strokesSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .superRefine(amountRule)

export const registerUnappliedRefundSchema = z.strictObject({
  correctionId: idSchema,
  notes: optionalText,
  idempotencyKey: idempotencyKeySchema,
})

export const SPECIAL_OPERATION_KINDS = [
  "REDEMPTION",
  "PURCHASE_REVERSAL",
  "SETTLEMENT_CORRECTION",
  "UNAPPLIED_REFUND",
] as const

export const listQuerySchema = z.strictObject({
  kind: z.enum(SPECIAL_OPERATION_KINDS).optional(),
  status: z
    .string()
    .trim()
    .max(40)
    .regex(/^[A-Z_]*$/)
    .optional(),
  playerId: idSchema.optional(),
})
