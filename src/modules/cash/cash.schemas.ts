import { z } from "zod"

import { ValidationError } from "@/lib/errors"
import { positiveMoneySchema } from "@/lib/money"

/**
 * Schemas de la caja. Importes como STRING decimal ("1500.00"), nunca
 * number. Toda operación que mueve dinero exige `idempotencyKey`. No existe
 * ningún schema de "gasto".
 */

const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Identificador inválido")

export const idempotencyKeySchema = z
  .string({ message: "Falta la clave de idempotencia" })
  .min(8)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/, "Clave de idempotencia inválida")

const reasonSchema = z
  .string({ message: "El motivo es obligatorio" })
  .trim()
  .min(3, "El motivo es obligatorio (mínimo 3 caracteres)")
  .max(300)

const personSchema = (label: string) =>
  z
    .string({ message: `${label} es obligatorio` })
    .trim()
    .min(2, `${label} es obligatorio`)
    .max(120)

const notesSchema = z
  .string()
  .trim()
  .max(500)
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional()

/** APO: aportación real de efectivo (procedencia y motivo obligatorios). */
export const contributionSchema = z.strictObject({
  sessionId: idSchema,
  amount: positiveMoneySchema,
  contributorName: personSchema("Quién aporta"),
  reason: reasonSchema,
  reference: z.string().trim().max(100).optional(),
  notes: notesSchema,
  idempotencyKey: idempotencyKeySchema,
})
export type ContributionInput = z.infer<typeof contributionSchema>

/** Destinos de un retiro ordinario (el de cierre pertenece al cierre). */
export const WITHDRAWAL_DESTINATIONS = [
  "OWNER_CUSTODY",
  "SAFEKEEPING",
  "CONTRIBUTION_RETURN",
] as const
export const WITHDRAWAL_DESTINATION_LABEL: Record<
  (typeof WITHDRAWAL_DESTINATIONS)[number] | "SESSION_CLOSING",
  string
> = {
  OWNER_CUSTODY: "Entrega a propietario/socio",
  SAFEKEEPING: "Resguardo (caja fuerte)",
  CONTRIBUTION_RETURN: "Devolución de aportación",
  SESSION_CLOSING: "Retiro total del cierre",
}

export const withdrawalSchema = z.strictObject({
  sessionId: idSchema,
  amount: positiveMoneySchema,
  destination: z.enum(WITHDRAWAL_DESTINATIONS, {
    message: "Selecciona el destino del retiro",
  }),
  recipientName: personSchema("Quién recibe"),
  reason: reasonSchema,
  notes: notesSchema,
  idempotencyKey: idempotencyKeySchema,
})
export type WithdrawalInput = z.infer<typeof withdrawalSchema>

/** Traslado de efectivo al banco (depósito): queda en tránsito hasta verificarse. */
export const cashDepositSchema = z.strictObject({
  sessionId: idSchema,
  amount: positiveMoneySchema,
  depositedBy: personSchema("Quién deposita"),
  bankReference: z.string().trim().max(100).optional(),
  reason: reasonSchema,
  notes: notesSchema,
  idempotencyKey: idempotencyKeySchema,
})
export type CashDepositInput = z.infer<typeof cashDepositSchema>

export const confirmBankTransferSchema = z.strictObject({
  /** BAN-15: el usuario declara que verificó el ingreso en el banco. */
  verifiedInBank: z.literal(true, {
    message: "Confirma que verificaste el ingreso en la cuenta bancaria",
  }),
  confirmedAmount: positiveMoneySchema.optional(),
  bankReference: z.string().trim().max(100).optional(),
  notes: notesSchema,
  /** Confirmar aunque exista otra transferencia confirmada con la misma referencia e importe. */
  acknowledgePossibleDuplicate: z.boolean().optional(),
})
export type ConfirmBankTransferInput = z.infer<typeof confirmBankTransferSchema>

export const rejectBankTransferSchema = z.strictObject({
  reason: reasonSchema,
})

export const reverseSchema = z.strictObject({
  reason: reasonSchema,
  idempotencyKey: idempotencyKeySchema,
})
export type ReverseInput = z.infer<typeof reverseSchema>

const CASH_UNITS = [
  "1000",
  "500",
  "200",
  "100",
  "50",
  "20",
  "10",
  "5",
  "2",
  "1",
  "0.50",
] as const

export const createReconciliationSchema = z
  .strictObject({
    sessionId: idSchema,
    reconciliationType: z.enum(["OPENING", "CONTROL", "CLOSING"]),
    countedAmount: z
      .string()
      .trim()
      .regex(/^\d{1,10}(\.\d{1,2})?$/, "Importe inválido")
      .optional(),
    details: z
      .array(
        z.strictObject({
          unitValue: z.enum(CASH_UNITS),
          quantity: z.number().int().min(0).max(100_000),
        })
      )
      .max(CASH_UNITS.length)
      .optional(),
    notes: notesSchema,
  })
  .refine((d) => d.countedAmount !== undefined || d.details !== undefined, {
    message: "Captura el efectivo contado (importe o desglose)",
  })
export type CreateReconciliationInput = z.infer<
  typeof createReconciliationSchema
>
export { CASH_UNITS }

export const confirmReconciliationSchema = z.strictObject({
  explanation: z.string().trim().max(500).optional(),
})

export const adjustReconciliationSchema = z.strictObject({
  reason: reasonSchema,
  idempotencyKey: idempotencyKeySchema,
})

export const TRANSACTION_TYPES = [
  "CASH_CONTRIBUTION",
  "CASH_WITHDRAWAL",
  "CASH_TRANSFER",
  "BANK_TRANSFER_RECEIPT",
  "BANK_TRANSFER_PAYOUT",
  "PURCHASE_PAYMENT",
  "DEBT_PAYMENT",
  "PLAYER_SETTLEMENT",
  "REVERSAL",
  "CASH_RECONCILIATION_ADJUSTMENT",
  "CARD_TERMINAL_SETTLEMENT",
] as const
export const TRANSACTION_TYPE_LABEL: Record<
  (typeof TRANSACTION_TYPES)[number],
  string
> = {
  CASH_CONTRIBUTION: "Aportación",
  CASH_WITHDRAWAL: "Retiro",
  CASH_TRANSFER: "Traslado",
  BANK_TRANSFER_RECEIPT: "Transferencia recibida",
  BANK_TRANSFER_PAYOUT: "Transferencia pagada",
  PURCHASE_PAYMENT: "Cobro de compra",
  DEBT_PAYMENT: "Cobro de abono",
  PLAYER_SETTLEMENT: "Pago de liquidación",
  REVERSAL: "Reverso",
  CASH_RECONCILIATION_ADJUSTMENT: "Ajuste de arqueo",
  CARD_TERMINAL_SETTLEMENT: "Depósito de terminal",
}

const dateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()

export const movementsQuerySchema = z.object({
  type: z.enum(TRANSACTION_TYPES).optional(),
  status: z.enum(["ACTIVE", "REVERSED", "REVERSAL"]).optional(),
  method: z.enum(["CASH", "BANK"]).optional(),
  account: z
    .string()
    .regex(/^[A-Z_]+$/)
    .optional(),
  userId: idSchema.optional(),
  sessionId: idSchema.optional(),
  tableId: idSchema.optional(),
  playerId: idSchema.optional(),
  folio: z.string().trim().max(30).optional(),
  reference: z.string().trim().max(100).optional(),
  from: dateParam,
  to: dateParam,
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
})
export type CashMovementsQuery = z.infer<typeof movementsQuerySchema>

export const bankTransfersQuerySchema = z.object({
  status: z
    .enum(["PENDING_VERIFICATION", "CONFIRMED", "REJECTED", "CANCELLED"])
    .optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
})

export async function parseCashIdParam(
  params: Promise<{ id: string }>
): Promise<string> {
  const { id } = await params
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) throw new ValidationError("Identificador inválido")
  return parsed.data
}

/** Depósito de la terminal que liquida cobros con tarjeta aprobados (Módulo 08). */
export const cardSettlementSchema = z.strictObject({
  paymentIds: z.array(idSchema).min(1, "Selecciona los cobros").max(200),
  depositedAmount: positiveMoneySchema,
  bankReference: z.string().trim().max(60).optional(),
  notes: z
    .string()
    .trim()
    .max(300)
    .transform((v) => (v === "" ? undefined : v))
    .optional(),
  /** El usuario declara que verificó el depósito en el banco. */
  depositVerified: z.literal(true, {
    message: "Confirma que verificaste el depósito en el banco",
  }),
  idempotencyKey: z
    .string()
    .min(8)
    .max(100)
    .regex(/^[A-Za-z0-9_-]+$/),
})
export type CardSettlementInput = z.infer<typeof cardSettlementSchema>
