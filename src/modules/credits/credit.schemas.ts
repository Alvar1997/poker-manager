import { z } from "zod"

import { ValidationError } from "@/lib/errors"
import { positiveMoneySchema } from "@/lib/money"
import { idempotencyKeySchema } from "@/modules/sessions/session.schemas"

/**
 * Schemas del Módulo 10. El cliente NUNCA envía la distribución FIFO, la
 * sesión, el saldo, el custodio, fechas ni responsables: los deriva el
 * servidor (`z.strictObject` → 400).
 */
export const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Identificador inválido")

const reference = z
  .string()
  .trim()
  .min(2, "Captura la referencia")
  .max(60)
  .refine((v) => !/\d{13,19}/.test(v.replace(/[\s-]/g, "")), {
    message: "No captures números de tarjeta: solo el folio de la terminal.",
  })

const optionalText = z
  .string()
  .trim()
  .max(300)
  .transform((v) => (v === "" ? undefined : v))
  .optional()

const base = {
  playerId: idSchema,
  amount: positiveMoneySchema,
  /** SESSION exige una sesión OPEN (la elige el servidor); ADMINISTRATIVE nunca toca cajas de sesión. */
  origin: z.enum(["SESSION", "ADMINISTRATIVE"]),
  notes: optionalText,
  idempotencyKey: idempotencyKeySchema,
}

export const registerPaymentSchema = z.union([
  z.strictObject({
    ...base,
    method: z.literal("CASH"),
    cashReceived: z.literal(true, {
      message: "Confirma que recibiste el efectivo",
    }),
  }),
  z.strictObject({
    ...base,
    method: z.literal("BANK_TRANSFER"),
    bankReference: reference.optional(),
    senderName: optionalText,
  }),
  z
    .strictObject({
      ...base,
      method: z.enum(["CARD_DEBIT", "CARD_CREDIT"]),
      result: z.enum(["APPROVED", "DECLINED"]),
      terminalReference: reference.optional(),
      terminalIdentifier: optionalText,
      approvalConfirmed: z.literal(true).optional(),
    })
    .superRefine((v, ctx) => {
      if (
        v.result === "APPROVED" &&
        (!v.terminalReference || v.approvalConfirmed !== true)
      )
        ctx.addIssue({
          code: "custom",
          path: ["approvalConfirmed"],
          message:
            "Captura el folio y confirma que la terminal mostró APROBADO",
        })
    }),
])
export type RegisterPaymentInput = z.infer<typeof registerPaymentSchema>

export const reversePaymentSchema = z.strictObject({
  reason: z.string().trim().min(10, "Explica el motivo del reverso").max(500),
  /** Efectivo: el operador declara que devolvió físicamente el dinero. */
  moneyReturned: z.literal(true, {
    message: "Confirma que devolviste el dinero",
  }),
  idempotencyKey: idempotencyKeySchema,
})

export const custodyDepositSchema = z.strictObject({
  custodianUserId: idSchema,
  amount: positiveMoneySchema,
  bankReference: z.string().trim().max(60).optional(),
  notes: optionalText,
  depositVerified: z.literal(true, {
    message: "Confirma que verificaste el depósito en el banco",
  }),
  idempotencyKey: idempotencyKeySchema,
})
export type CustodyDepositInput = z.infer<typeof custodyDepositSchema>

/** Aportación real de efectivo a la custodia del usuario que la recibe (Módulo 11). */
export const custodyContributionSchema = z.strictObject({
  amount: positiveMoneySchema,
  counterpartyName: z
    .string()
    .trim()
    .min(2, "Indica quién entregó el efectivo")
    .max(120),
  reason: z
    .string()
    .trim()
    .min(
      5,
      "Explica para qué se aporta (p. ej. pagar liquidaciones pendientes)"
    )
    .max(300),
  cashReceived: z.literal(true, {
    message: "Confirma que recibiste físicamente el efectivo",
  }),
  idempotencyKey: idempotencyKeySchema,
})
export type CustodyContributionInput = z.infer<typeof custodyContributionSchema>

export const paymentsQuerySchema = z.object({
  playerId: idSchema.optional(),
  status: z.enum(["PENDING", "CONFIRMED", "REJECTED", "REVERSED"]).optional(),
  origin: z.enum(["SESSION", "ADMINISTRATIVE"]).optional(),
  method: z
    .enum(["CASH", "BANK_TRANSFER", "CARD_DEBIT", "CARD_CREDIT"])
    .optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
export type PaymentsQuery = z.infer<typeof paymentsQuerySchema>

export const receivablesQuerySchema = z.object({
  playerId: idSchema.optional(),
  status: z.enum(["OPEN", "PARTIALLY_PAID", "PAID"]).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
})

export const fifoPreviewSchema = z.object({ amount: positiveMoneySchema })

export const receiptShareSchema = z.strictObject({
  channel: z.enum(["NATIVE_SHARE", "DOWNLOAD", "COPY_TEXT"]),
})

export async function parseIdParam(params: Promise<{ id: string }>) {
  const { id } = await params
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) throw new ValidationError("Identificador inválido")
  return parsed.data
}
