import { z } from "zod"

import { ValidationError } from "@/lib/errors"
import { positiveMoneySchema } from "@/lib/money"
import { idempotencyKeySchema } from "@/modules/sessions/session.schemas"

/**
 * Schemas del Módulo 17 (bancaje, PRIVADO). El cliente NUNCA envía
 * resultados, saldos, límites, reservas, estados, responsables ni fechas:
 * el servidor los deriva de hechos registrados. `z.strictObject` → 400 ante
 * campos no previstos (p. ej. un «approvedBy» inventado).
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

/** Importe ≥ 0 con hasta 2 decimales (el retorno puede ser $0). */
export const nonNegativeMoneySchema = z
  .string({ message: "Captura el importe" })
  .trim()
  .regex(
    /^\d{1,10}(\.\d{1,2})?$/,
    "Importe inválido (hasta 2 decimales, sin signos)"
  )

/** Ajuste con signo (corrección auditada del resultado de una jugada). */
export const signedMoneySchema = z
  .string({ message: "Captura el importe" })
  .trim()
  .regex(
    /^-?\d{1,10}(\.\d{1,2})?$/,
    "Importe inválido (hasta 2 decimales; usa - para restar)"
  )
  .refine((v) => /[1-9]/.test(v), "El ajuste no puede ser cero")

export const percentSchema = z
  .string({ message: "Captura el porcentaje del jugador" })
  .trim()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, "Porcentaje inválido (0 a 100)")
  .refine((v) => Number(v) >= 0 && Number(v) <= 100, "Entre 0 y 100")

const reason = z
  .string({ message: "Indica el motivo" })
  .trim()
  .min(10, "Describe el motivo (al menos 10 caracteres)")
  .max(1000)

const notes = z.string().trim().max(500).optional()

const reference = z
  .string()
  .trim()
  .min(2, "Captura la referencia bancaria")
  .max(60)
  .refine((v) => !/\d{13,19}/.test(v.replace(/[\s-]/g, "")), {
    message:
      "No captures números de cuenta o tarjeta completos: solo la referencia.",
  })

export const createAgreementSchema = z.strictObject({
  playerId: idSchema,
  playerPercent: percentSchema,
  reason,
  notes,
  idempotencyKey: idempotencyKeySchema,
})
export type CreateAgreementInput = z.infer<typeof createAgreementSchema>

export const endAgreementSchema = z.strictObject({
  reason,
  idempotencyKey: idempotencyKeySchema,
})

export const changeRequestSchema = z.strictObject({
  playerPercent: percentSchema,
  mode: z.enum(["WHOLE_CYCLE", "FROM_NEXT_GAME"], {
    message: "Elige si aplica a todo el ciclo o desde la siguiente jugada",
  }),
  reason,
  idempotencyKey: idempotencyKeySchema,
})
export type ChangeRequestInput = z.infer<typeof changeRequestSchema>

export const decisionSchema = z.strictObject({
  decision: z.enum(["APPROVE", "REJECT"]),
  notes: z.string().trim().max(1000).optional(),
  idempotencyKey: idempotencyKeySchema,
})

export const financedPurchaseSchema = z.strictObject({
  participationId: idSchema,
  nominalAmount: positiveMoneySchema,
  /** El cajero confirma que entregó físicamente las fichas. */
  physicalDeliveryConfirmed: z.literal(true, {
    message: "Confirma la entrega física de las fichas",
  }),
  notes,
  idempotencyKey: idempotencyKeySchema,
})
export type FinancedPurchaseInput = z.infer<typeof financedPurchaseSchema>

export const reconcileSchema = z.strictObject({
  returnedNominalAmount: nonNegativeMoneySchema,
  /** Obligatorio (true) SOLO cuando el retorno es $0: nunca se asume. */
  zeroReturnConfirmed: z.boolean(),
  /** El cajero verificó físicamente la recepción (o el retorno cero). */
  physicalReturnVerified: z.literal(true, {
    message: "Confirma que verificaste físicamente la devolución",
  }),
  expectedVersion: z.number().int().min(1),
  idempotencyKey: idempotencyKeySchema,
})
export type ReconcileInput = z.infer<typeof reconcileSchema>

export const discrepancySchema = z.strictObject({
  description: reason,
  idempotencyKey: idempotencyKeySchema,
})

export const resolveDiscrepancySchema = z.strictObject({
  notes: reason,
  idempotencyKey: idempotencyKeySchema,
})

export const adjustGameSchema = z.strictObject({
  amount: signedMoneySchema,
  reason,
  idempotencyKey: idempotencyKeySchema,
})

export const createAdvanceSchema = z.strictObject({
  playerId: idSchema,
  enablingGameId: idSchema,
  requestedAmount: positiveMoneySchema,
  authorizedAmount: positiveMoneySchema,
  authorizerId: idSchema,
  channel: z.enum(["VERBAL", "MESSAGE"], {
    message: "Indica cómo comunicó el socio la autorización",
  }),
  notes,
  idempotencyKey: idempotencyKeySchema,
})
export type CreateAdvanceInput = z.infer<typeof createAdvanceSchema>

/** Desembolso REAL (efectivo entregado o transferencia en trámite). */
export const disburseSchema = z
  .strictObject({
    amount: positiveMoneySchema,
    method: z.enum(["CASH", "BANK_TRANSFER"]),
    funding: z.enum(["ADMIN_CUSTODY", "SESSION_CASH"]).optional(),
    bankReference: reference.optional(),
    notes,
    idempotencyKey: idempotencyKeySchema,
  })
  .superRefine((v, ctx) => {
    if (v.method === "BANK_TRANSFER" && v.funding)
      ctx.addIssue({
        code: "custom",
        path: ["funding"],
        message: "Una transferencia sale del banco.",
      })
  })
export type DisburseInput = z.infer<typeof disburseSchema>

export const resolvePayoutSchema = z
  .strictObject({
    outcome: z.enum(["EXECUTED", "FAILED", "CANCELLED"]),
    bankReference: reference.optional(),
    reason: z.string().trim().max(500).optional(),
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

export const closeRemainderSchema = z.strictObject({
  reason,
  idempotencyKey: idempotencyKeySchema,
})

const allocationSchema = z
  .record(
    idSchema,
    z
      .string()
      .trim()
      .regex(/^\d{1,10}(\.\d{1,2})?$/, "Importe inválido")
  )
  .refine((r) => Object.keys(r).length <= 4, "Máximo cuatro tramos")

export const prepareClosingSchema = z.strictObject({
  reserveAmount: nonNegativeMoneySchema,
  payAmount: nonNegativeMoneySchema,
  lossAllocation: allocationSchema.optional(),
  notes: z.string().trim().max(1000).optional(),
  idempotencyKey: idempotencyKeySchema,
})
export type PrepareClosingInput = z.infer<typeof prepareClosingSchema>

export const approveClosingSchema = z.strictObject({
  closingId: idSchema,
  /** Huella del snapshot revisado: si los datos cambiaron, 409. */
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/, "Huella inválida"),
  notes: z.string().trim().max(1000).optional(),
  idempotencyKey: idempotencyKeySchema,
})

export const rejectClosingSchema = z.strictObject({
  closingId: idSchema,
  notes: reason,
  idempotencyKey: idempotencyKeySchema,
})

export const withdrawalRequestSchema = z.strictObject({
  playerId: idSchema,
  amount: positiveMoneySchema,
  reason,
  idempotencyKey: idempotencyKeySchema,
})

export const withdrawalDecisionSchema = z
  .strictObject({
    decision: z.enum(["APPROVE", "REJECT"]),
    approvedAmount: positiveMoneySchema.optional(),
    notes: z.string().trim().max(1000).optional(),
    idempotencyKey: idempotencyKeySchema,
  })
  .superRefine((v, ctx) => {
    if (v.decision === "REJECT" && !v.notes)
      ctx.addIssue({
        code: "custom",
        path: ["notes"],
        message: "Indica el motivo del rechazo.",
      })
  })

export const cancelSchema = z.strictObject({
  reason,
  idempotencyKey: idempotencyKeySchema,
})

export const resolveRegularizationSchema = z.strictObject({
  resolution: z.enum([
    "RECOVER_FROM_FUTURE",
    "APPLY_RESERVE",
    "MONEY_RETURNED",
    "DOCUMENTED_WRITE_OFF",
  ]),
  notes: reason,
  idempotencyKey: idempotencyKeySchema,
})

/** Dinero REAL devuelto por el jugador (efectivo a custodia de quien lo recibe). */
export const regularizationReceiptSchema = z.strictObject({
  amount: positiveMoneySchema,
  cashReceived: z.literal(true, {
    message: "Confirma que recibiste físicamente el efectivo",
  }),
  idempotencyKey: idempotencyKeySchema,
})

export const bankingListQuerySchema = z.strictObject({
  playerId: idSchema.optional(),
  status: z
    .string()
    .trim()
    .max(40)
    .regex(/^[A-Z_]*$/)
    .optional(),
})
