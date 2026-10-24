import { z } from "zod"

import { ValidationError } from "@/lib/errors"
import { positiveMoneySchema } from "@/lib/money"
import { idempotencyKeySchema } from "@/modules/sessions/session.schemas"

/**
 * Schemas del Módulo 08. Compras SOLO por importe: ningún schema acepta
 * denominaciones, cantidades de fichas ni combinaciones. El cliente nunca
 * envía folio, estados, responsables, fechas, saldos, numeración ni el
 * importe autorizado (`z.strictObject` → 400): el servidor los deriva.
 */

export const idSchema = z
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

/** Referencias operativas (terminal/banco). Rechaza cadenas que parezcan un número de tarjeta. */
const referenceText = z
  .string()
  .trim()
  .min(2, "Captura la referencia")
  .max(60)
  .refine((v) => !/\d{13,19}/.test(v.replace(/[\s-]/g, "")), {
    message:
      "No captures números de tarjeta: usa solo el folio o número de autorización de la terminal.",
  })

export const PURCHASE_PAYMENT_MODES = [
  "CASH",
  "BANK_TRANSFER",
  "CARD",
  "CREDIT",
  "MIXED",
] as const
export type PurchasePaymentModeValue = (typeof PURCHASE_PAYMENT_MODES)[number]

export const createPurchaseSchema = z.strictObject({
  participationId: idSchema,
  nominalAmount: positiveMoneySchema,
  /**
   * Modalidad elegida por el cajero. CREDIT = crédito TOTAL (no admite
   * cobros); CASH/CARD = un solo componente que cubre todo; BANK_TRANSFER =
   * transferencia (pendiente = crédito hasta verificarla); MIXED = varios
   * componentes y el resto a crédito. Sin modalidad: comportamiento anterior.
   */
  paymentMode: z.enum(PURCHASE_PAYMENT_MODES).optional(),
  notes: optionalText(300),
  idempotencyKey: idempotencyKeySchema,
})
export type CreatePurchaseInput = z.infer<typeof createPurchaseSchema>

export const updateDraftSchema = z
  .strictObject({
    nominalAmount: positiveMoneySchema.optional(),
    notes: optionalText(300),
    expectedVersion: z.number().int().min(1),
  })
  .refine((v) => v.nominalAmount !== undefined || v.notes !== undefined, {
    message: "No hay cambios",
  })
export type UpdateDraftInput = z.infer<typeof updateDraftSchema>

const cashPayment = z.strictObject({
  method: z.literal("CASH"),
  amount: positiveMoneySchema,
  /** El cajero declara que recibió físicamente el efectivo. */
  cashReceived: z.literal(true, {
    message: "Confirma que recibiste el efectivo",
  }),
  idempotencyKey: idempotencyKeySchema,
})

const transferPayment = z.strictObject({
  method: z.literal("BANK_TRANSFER"),
  amount: positiveMoneySchema,
  bankReference: referenceText.optional(),
  senderName: optionalText(120),
  idempotencyKey: idempotencyKeySchema,
})

const cardPayment = z
  .strictObject({
    method: z.enum(["CARD_DEBIT", "CARD_CREDIT"]),
    amount: positiveMoneySchema,
    /** Resultado mostrado por la terminal física. */
    result: z.enum(["PENDING", "APPROVED", "DECLINED"]),
    terminalReference: referenceText.optional(),
    terminalIdentifier: optionalText(60),
    /** Confirmación operativa explícita de que la terminal mostró "aprobada". */
    approvalConfirmed: z.literal(true).optional(),
    idempotencyKey: idempotencyKeySchema,
  })
  .superRefine((v, ctx) => {
    if (v.result === "APPROVED") {
      if (!v.terminalReference)
        ctx.addIssue({
          code: "custom",
          path: ["terminalReference"],
          message: "Captura el folio o autorización de la terminal",
        })
      if (v.approvalConfirmed !== true)
        ctx.addIssue({
          code: "custom",
          path: ["approvalConfirmed"],
          message: "Confirma que la terminal mostró el cobro como aprobado",
        })
    }
  })

export const recordPaymentSchema = z.union([
  cashPayment,
  transferPayment,
  cardPayment,
])
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>

export const cardResultSchema = z
  .strictObject({
    result: z.enum(["APPROVED", "DECLINED", "VOIDED"]),
    terminalReference: referenceText.optional(),
    approvalConfirmed: z.literal(true).optional(),
    reason: optionalText(300),
  })
  .superRefine((v, ctx) => {
    if (v.result === "APPROVED") {
      if (!v.terminalReference)
        ctx.addIssue({
          code: "custom",
          path: ["terminalReference"],
          message: "Captura el folio o autorización de la terminal",
        })
      if (v.approvalConfirmed !== true)
        ctx.addIssue({
          code: "custom",
          path: ["approvalConfirmed"],
          message: "Confirma que la terminal mostró el cobro como aprobado",
        })
    }
    if (v.result === "VOIDED" && !v.reason)
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Explica la anulación del cobro",
      })
  })
export type CardResultInput = z.infer<typeof cardResultSchema>

export const cancelPaymentSchema = z.strictObject({
  reason: z.string().trim().min(5, "Explica el motivo").max(300),
  /** Efectivo: el cajero declara que devolvió el dinero al jugador. */
  cashReturned: z.literal(true).optional(),
})
export type CancelPaymentInput = z.infer<typeof cancelPaymentSchema>

export const creditAuthorizationSchema = z.strictObject({
  partnerId: idSchema,
  channel: z.enum(["VERBAL", "MESSAGE"], {
    message: "Selecciona el medio de autorización",
  }),
  notes: optionalText(300),
  idempotencyKey: idempotencyKeySchema,
})
export type CreditAuthorizationInput = z.infer<typeof creditAuthorizationSchema>

export const prepareDeliverySchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
})

export const confirmDeliverySchema = z.strictObject({
  /** Versión del resumen que el cajero revisó (si cambió, se rechaza). */
  expectedVersion: z.number().int().min(1),
  /** Confirmación explícita de la entrega física de las fichas. */
  physicalDeliveryConfirmed: z.literal(true, {
    message: "Confirma que entregaste físicamente las fichas",
  }),
  idempotencyKey: idempotencyKeySchema,
})
export type ConfirmDeliveryInput = z.infer<typeof confirmDeliverySchema>

export const cancelPurchaseSchema = z.strictObject({
  reason: z.string().trim().min(5, "Explica el motivo").max(300),
})

export const reversalRequestSchema = z.strictObject({
  reason: z.string().trim().min(10, "Explica el motivo del reverso").max(500),
  idempotencyKey: idempotencyKeySchema,
})

export const PURCHASE_STATUSES = [
  "DRAFT",
  "READY_FOR_DELIVERY",
  "CONFIRMED",
  "CANCELLED",
  "REVERSED",
] as const

const dateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()

const boolParam = z
  .enum(["true", "false"])
  .transform((v) => v === "true")
  .optional()

export const purchasesQuerySchema = z.object({
  sessionId: idSchema.optional(),
  tableId: idSchema.optional(),
  playerId: idSchema.optional(),
  status: z.enum(PURCHASE_STATUSES).optional(),
  purchaseType: z.enum(["INITIAL_PURCHASE", "REBUY"]).optional(),
  cashierId: idSchema.optional(),
  partnerId: idSchema.optional(),
  method: z
    .enum(["CASH", "BANK_TRANSFER", "CARD_DEBIT", "CARD_CREDIT"])
    .optional(),
  withCredit: boolParam,
  from: dateParam,
  to: dateParam,
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
export type PurchasesQuery = z.infer<typeof purchasesQuerySchema>

export async function parsePurchaseIdParam(params: Promise<{ id: string }>) {
  const { id } = await params
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) throw new ValidationError("Identificador inválido")
  return parsed.data
}

export async function parsePaymentParams(
  params: Promise<{ id: string; paymentId: string }>
) {
  const { id, paymentId } = await params
  const a = idSchema.safeParse(id)
  const b = idSchema.safeParse(paymentId)
  if (!a.success || !b.success)
    throw new ValidationError("Identificador inválido")
  return { purchaseId: a.data, paymentId: b.data }
}
