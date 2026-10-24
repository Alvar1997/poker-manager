import { Prisma } from "@/generated/prisma/client"

/**
 * Cálculos PUROS de una compra (Módulo 08). Importes siempre con
 * Prisma.Decimal (nunca Float). Sin acceso a base de datos: los servicios
 * leen los registros y estas funciones derivan el estado financiero.
 *
 *   confirmedPayments = efectivo recibido + transferencias VERIFICADAS
 *                       + débito APROBADO + crédito de terminal APROBADO
 *   outstanding       = importe − confirmedPayments   (nunca negativo)
 *
 * Una transferencia pendiente NO es cobro: forma parte del saldo por
 * cobrar (no se registra además como otra deuda). El crédito no es un
 * método de pago: es el saldo por cobrar al entregar.
 */

export const ZERO = new Prisma.Decimal(0)

export type PaymentMethodValue =
  "CASH" | "BANK_TRANSFER" | "CARD_DEBIT" | "CARD_CREDIT"

export type PaymentStatusValue =
  "PENDING" | "CONFIRMED" | "APPROVED" | "DECLINED" | "VOIDED" | "CANCELLED"

export type TransferStatusValue =
  "PENDING_VERIFICATION" | "CONFIRMED" | "REJECTED" | "CANCELLED"

export type PaymentLike = {
  id: string
  method: PaymentMethodValue
  amount: Prisma.Decimal
  status: PaymentStatusValue
  /** Solo transferencias: estado de su verificación manual (Módulo 05). */
  transferStatus?: TransferStatusValue | null
  transferConfirmedAmount?: Prisma.Decimal | null
}

/** Efecto financiero de un componente: cobrado, por resolver o sin efecto. */
export type PaymentEffect = "CONFIRMED" | "PENDING" | "VOID"

export function paymentEffect(p: PaymentLike): PaymentEffect {
  switch (p.method) {
    case "CASH":
      return p.status === "CONFIRMED" ? "CONFIRMED" : "VOID"
    case "CARD_DEBIT":
    case "CARD_CREDIT":
      if (p.status === "APPROVED") return "CONFIRMED"
      if (p.status === "PENDING") return "PENDING"
      return "VOID"
    case "BANK_TRANSFER":
      if (p.status === "CANCELLED") return "VOID"
      if (p.transferStatus === "CONFIRMED") return "CONFIRMED"
      if (p.transferStatus === "PENDING_VERIFICATION") return "PENDING"
      return "VOID"
  }
}

/** Importe que realmente cuenta (una transferencia verificada usa el importe confirmado). */
export function effectiveAmount(p: PaymentLike): Prisma.Decimal {
  if (
    p.method === "BANK_TRANSFER" &&
    p.transferStatus === "CONFIRMED" &&
    p.transferConfirmedAmount
  ) {
    return p.transferConfirmedAmount
  }
  return p.amount
}

export type PurchaseFinancials = {
  nominalAmount: Prisma.Decimal
  confirmedCash: Prisma.Decimal
  verifiedBankTransfers: Prisma.Decimal
  approvedCardDebit: Prisma.Decimal
  approvedCardCredit: Prisma.Decimal
  confirmedPayments: Prisma.Decimal
  /** Transferencias declaradas sin verificar (parte del saldo por cobrar). */
  pendingTransfers: Prisma.Decimal
  /** Cobros de terminal en proceso (bloquean la entrega hasta resolverse). */
  pendingCards: Prisma.Decimal
  /** Componentes vivos (confirmados + pendientes). */
  committedPayments: Prisma.Decimal
  /** Importe − pagos confirmados. Si es > 0 al entregar, hay crédito. */
  outstanding: Prisma.Decimal
  /** Parte del saldo por cobrar sin ningún componente de pago (crédito puro). */
  uncoveredCredit: Prisma.Decimal
  /** true si los pagos confirmados exceden el importe (requiere tratamiento explícito). */
  overApplied: boolean
}

export function summarizePayments(
  nominalAmount: Prisma.Decimal,
  payments: PaymentLike[]
): PurchaseFinancials {
  let confirmedCash = ZERO
  let verifiedBankTransfers = ZERO
  let approvedCardDebit = ZERO
  let approvedCardCredit = ZERO
  let pendingTransfers = ZERO
  let pendingCards = ZERO
  for (const p of payments) {
    const effect = paymentEffect(p)
    const amount = effectiveAmount(p)
    if (effect === "CONFIRMED") {
      if (p.method === "CASH") confirmedCash = confirmedCash.add(amount)
      else if (p.method === "BANK_TRANSFER")
        verifiedBankTransfers = verifiedBankTransfers.add(amount)
      else if (p.method === "CARD_DEBIT")
        approvedCardDebit = approvedCardDebit.add(amount)
      else approvedCardCredit = approvedCardCredit.add(amount)
    } else if (effect === "PENDING") {
      if (p.method === "BANK_TRANSFER")
        pendingTransfers = pendingTransfers.add(amount)
      else pendingCards = pendingCards.add(amount)
    }
  }
  const confirmedPayments = confirmedCash
    .add(verifiedBankTransfers)
    .add(approvedCardDebit)
    .add(approvedCardCredit)
  const committedPayments = confirmedPayments
    .add(pendingTransfers)
    .add(pendingCards)
  const overApplied = confirmedPayments.greaterThan(nominalAmount)
  const outstanding = overApplied ? ZERO : nominalAmount.sub(confirmedPayments)
  const uncovered = nominalAmount.sub(committedPayments)
  return {
    nominalAmount,
    confirmedCash,
    verifiedBankTransfers,
    approvedCardDebit,
    approvedCardCredit,
    confirmedPayments,
    pendingTransfers,
    pendingCards,
    committedPayments,
    outstanding,
    uncoveredCredit: uncovered.isNegative() ? ZERO : uncovered,
    overApplied,
  }
}

/**
 * Un componente nuevo no puede llevar el total de componentes vivos por
 * encima del importe (no hay cambio/excedentes en este módulo).
 */
export function assertPaymentFits(
  financials: PurchaseFinancials,
  amount: Prisma.Decimal
) {
  if (!amount.greaterThan(0)) throw new Error("El pago debe ser mayor que cero")
  const after = financials.committedPayments.add(amount)
  if (after.greaterThan(financials.nominalAmount)) {
    const room = financials.nominalAmount.sub(financials.committedPayments)
    throw new Error(
      `El pago excede el importe de la compra: solo faltan $${(room.isNegative() ? ZERO : room).toFixed(2)} por asignar. Los excedentes y el cambio no se registran en compras.`
    )
  }
}

export type DeliveryBlocker =
  | "PENDING_CARD_PAYMENT"
  | "OVER_APPLIED"
  | "CREDIT_AUTHORIZATION_REQUIRED"
  | "CREDIT_SIGNATURE_REQUIRED"
  | "PARTICIPATION_NOT_ACTIVE"
  | "PURCHASE_NOT_EDITABLE"

export const BLOCKER_MESSAGE: Record<DeliveryBlocker, string> = {
  PENDING_CARD_PAYMENT:
    "Hay un cobro con terminal en proceso: regístralo como aprobado o rechazado.",
  OVER_APPLIED:
    "Los pagos confirmados exceden el importe: requiere tratamiento explícito del excedente.",
  CREDIT_AUTHORIZATION_REQUIRED:
    "Hay saldo por cobrar: selecciona al socio que autorizó el crédito.",
  CREDIT_SIGNATURE_REQUIRED:
    "Hay saldo por cobrar: la entrega requiere la firma auténtica del jugador.",
  PARTICIPATION_NOT_ACTIVE:
    "El jugador ya no está activo en la mesa de esta compra.",
  PURCHASE_NOT_EDITABLE: "La compra ya no está en preparación.",
}

/** Bloqueos para confirmar la entrega, en el orden en que se resuelven. */
export function deliveryBlockers(input: {
  editable: boolean
  participationActive: boolean
  financials: PurchaseFinancials
  creditAuthorizationValid: boolean
  signatureValid: boolean
}): DeliveryBlocker[] {
  const blockers: DeliveryBlocker[] = []
  if (!input.editable) blockers.push("PURCHASE_NOT_EDITABLE")
  if (!input.participationActive) blockers.push("PARTICIPATION_NOT_ACTIVE")
  if (input.financials.overApplied) blockers.push("OVER_APPLIED")
  if (input.financials.pendingCards.greaterThan(0))
    blockers.push("PENDING_CARD_PAYMENT")
  if (input.financials.outstanding.greaterThan(0)) {
    if (!input.creditAuthorizationValid)
      blockers.push("CREDIT_AUTHORIZATION_REQUIRED")
    if (!input.signatureValid) blockers.push("CREDIT_SIGNATURE_REQUIRED")
  }
  return blockers
}

/** La firma solo se exige si queda saldo por cobrar (aunque sea parcial). */
export function requiresSignature(financials: PurchaseFinancials): boolean {
  return financials.outstanding.greaterThan(0)
}

/**
 * Numeración por (sesión, jugador): la primera compra CONFIRMADA es la
 * compra inicial; las siguientes, Recompra 1, 2, 3… No se reinicia al
 * cambiar de mesa y los borradores cancelados no consumen números.
 */
export function nextPurchaseNumber(lastSequence: number | null) {
  const sequenceNumber = (lastSequence ?? 0) + 1
  return sequenceNumber === 1
    ? {
        sequenceNumber,
        purchaseType: "INITIAL_PURCHASE" as const,
        rebuyNumber: null,
      }
    : {
        sequenceNumber,
        purchaseType: "REBUY" as const,
        rebuyNumber: sequenceNumber - 1,
      }
}

/**
 * Clasificación compra inicial / recompra POR MESA (regla vigente):
 *  - el consecutivo (`sequenceNumber`) sigue siendo por (sesión, jugador),
 *    único y en orden real (nunca se reinicia);
 *  - es RECOMPRA solo si el jugador ya tuvo una compra entregada en ESA
 *    mesa lógica (`tableId` del catálogo; una mesa cerrada y reabierta es la
 *    misma) durante la sesión, o en su cadena de transferencias (llegó con
 *    sus fichas desde otra mesa sin liquidarse);
 *  - si hizo OUT/CASHOUT en una mesa y entra a OTRA, su primera compra ahí es
 *    COMPRA INICIAL. `priorInScope` = compras previas en ese alcance.
 */
export function classifyPurchase(
  lastSequence: number | null,
  priorInScope: number
) {
  const sequenceNumber = (lastSequence ?? 0) + 1
  return priorInScope <= 0
    ? {
        sequenceNumber,
        purchaseType: "INITIAL_PURCHASE" as const,
        rebuyNumber: null,
      }
    : {
        sequenceNumber,
        purchaseType: "REBUY" as const,
        rebuyNumber: priorInScope,
      }
}

export function purchaseTypeLabel(
  purchaseType: "INITIAL_PURCHASE" | "REBUY" | null,
  rebuyNumber: number | null
): string {
  if (purchaseType === "INITIAL_PURCHASE") return "Compra inicial"
  if (purchaseType === "REBUY") return `Recompra ${rebuyNumber}`
  return "Por definir al confirmar"
}
