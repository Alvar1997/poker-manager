import { Prisma } from "@/generated/prisma/client"
import {
  summarizePayments,
  type PaymentLike,
} from "@/modules/purchases/purchase.math"

/**
 * Núcleo PURO del Módulo 16 (operaciones financieras especiales). Sin base
 * de datos: los servicios cargan los hechos y estas funciones deciden qué
 * es ejecutable y con qué importes. Nunca se inventan dinero ni fichas:
 * todo importe sale de movimientos registrados.
 */

export type Dec = Prisma.Decimal
export const ZERO = new Prisma.Decimal(0)
export const dec = (v: Prisma.Decimal | string | number | null | undefined) =>
  new Prisma.Decimal(v ?? 0)
export const fmt = (v: Prisma.Decimal) => v.toFixed(2)

// ── Obligaciones especiales ───────────────────────────────────────────

export type PayoutLike = { amount: Dec; status: string }

/** Estado derivado: PAID solo con lo EJECUTADO; una transferencia pendiente no paga. */
export function payableState(original: Dec, payouts: PayoutLike[]) {
  const executed = payouts
    .filter((p) => p.status === "EXECUTED")
    .reduce((acc, p) => acc.add(p.amount), ZERO)
  const inTransit = payouts
    .filter((p) => p.status === "PENDING")
    .reduce((acc, p) => acc.add(p.amount), ZERO)
  const pending = original.sub(executed)
  const available = pending.sub(inTransit)
  const status: "OPEN" | "PARTIALLY_PAID" | "PAID" = pending.lessThanOrEqualTo(
    0
  )
    ? "PAID"
    : executed.greaterThan(0)
      ? "PARTIALLY_PAID"
      : "OPEN"
  return { executed, inTransit, pending, available, status }
}

/** Un pago nunca excede lo pendiente menos lo ya comprometido en tránsito. */
export function assertPayoutWithin(
  amount: Dec,
  original: Dec,
  payouts: PayoutLike[]
) {
  if (!amount.greaterThan(0)) throw new Error("El pago debe ser mayor que cero")
  if (!amount.equals(amount.toDecimalPlaces(2)))
    throw new Error("El importe admite como máximo dos decimales")
  const s = payableState(original, payouts)
  if (amount.greaterThan(s.available)) throw new PayoutExceedsError(s.available)
  return s
}

export class PayoutExceedsError extends Error {
  constructor(readonly available: Dec) {
    super(
      available.lessThanOrEqualTo(0)
        ? "No queda saldo pendiente por pagar (o ya está comprometido en transferencias en curso)."
        : `El pago excede lo pendiente: disponible $${available.toFixed(2)}.`
    )
    this.name = "PayoutExceedsError"
  }
}

// ── Canje posterior ───────────────────────────────────────────────────

export function redemptionStatusFor(payable: ReturnType<typeof payableState>) {
  return payable.status === "PAID"
    ? "PAID"
    : payable.status === "PARTIALLY_PAID"
      ? "PARTIALLY_PAID"
      : "PAYMENT_PENDING"
}

/**
 * Validación del valor presentado: lo aceptado nunca excede lo presentado
 * ni la circulación GLOBAL (no pueden regresar más fichas de las que
 * salieron). Si se cuenta por denominación, el conteo debe sumar lo
 * aceptado exactamente (retorno ACTUAL; no se atribuye a compras).
 */
export function validateRedemption(input: {
  presented: Dec
  accepted: Dec
  globalCirculation: Dec
  denominations?: { unitValue: Dec; quantity: number }[]
}) {
  const problems: string[] = []
  if (input.accepted.lessThan(0))
    problems.push("El valor aceptado no puede ser negativo.")
  if (input.accepted.greaterThan(input.presented))
    problems.push("El valor aceptado no puede exceder el presentado.")
  if (input.accepted.greaterThan(input.globalCirculation))
    problems.push(
      `El valor aceptado excede las fichas en circulación ($${input.globalCirculation.toFixed(2)}): no pueden regresar más fichas de las que salieron.`
    )
  let counted: Dec | null = null
  if (input.denominations && input.denominations.length > 0) {
    counted = input.denominations.reduce(
      (acc, d) => acc.add(d.unitValue.mul(d.quantity)),
      ZERO
    )
    if (
      input.denominations.some(
        (d) => !Number.isInteger(d.quantity) || d.quantity < 0
      )
    )
      problems.push(
        "Las cantidades por denominación deben ser enteros no negativos."
      )
    if (!counted.equals(input.accepted))
      problems.push(
        `El conteo por denominación suma $${counted.toFixed(2)} y no coincide con el valor aceptado.`
      )
  }
  return {
    ok: problems.length === 0,
    problems,
    rejected: input.presented.sub(input.accepted),
    counted,
  }
}

// ── Reverso de compra ─────────────────────────────────────────────────

export type ReversalClassification =
  | "CANCEL_PURCHASE"
  | "FULL_REVERSAL"
  | "PHYSICAL_RETURN_PENDING"
  | "NOT_REVERSIBLE_AUTOMATICALLY"
  | "ALREADY_REVERSED"

export type AllocationLite = {
  kind: "APPLICATION" | "REVERSAL"
  source:
    | "RECEIVABLE_PAYMENT"
    | "PURCHASE_PAYMENT"
    | "CHIP_SETTLEMENT_OFFSET"
    | "PURCHASE_REVERSAL"
  amount: Dec
}

export type PurchaseReversalFacts = {
  status: string
  nominal: Dec
  payments: PaymentLike[]
  debt: { original: Dec; allocations: AllocationLite[] } | null
  alreadyReversed: boolean
  approvedCorrection: boolean
  physicalReturn: { confirmed: boolean; nominal: Dec | null }
  /** Estado de la sesión de la compra (CLOSING bloquea: el arqueo final está en curso). */
  sessionStatus: string
  /** La participación ya se liquidó o tiene una liquidación en curso. */
  participationSettled: boolean
}

const net = (list: AllocationLite[], source: AllocationLite["source"]) =>
  list
    .filter((a) => a.source === source)
    .reduce(
      (acc, a) =>
        a.kind === "APPLICATION" ? acc.add(a.amount) : acc.sub(a.amount),
      ZERO
    )

/**
 * Plan de reverso de una compra. Devuelve exactamente qué se haría:
 *   - fichas que deben regresar FÍSICAMENTE (el valor nominal entregado);
 *   - saldo de la deuda que se extingue SIN dinero (las fichas volvieron);
 *   - dinero que el jugador pagó por esa compra y que se le debe devolver
 *     (efectivo, terminal y transferencias verificadas de la compra + abonos
 *     y compensaciones aplicados A ESA deuda; nunca el importe completo si
 *     no se pagó). Identidad verificada: extinción + reembolso = nominal.
 * Bloquea (no ejecutable) cuando falta algo material.
 */
export function planPurchaseReversal(f: PurchaseReversalFacts) {
  const blockers: string[] = []
  if (f.alreadyReversed || f.status === "REVERSED")
    return {
      classification: "ALREADY_REVERSED" as const,
      executable: false,
      blockers: ["La compra ya fue revertida."],
      effects: null,
    }
  if (f.status !== "CONFIRMED")
    return {
      classification: "CANCEL_PURCHASE" as const,
      executable: false,
      blockers: [
        f.status === "CANCELLED"
          ? "La compra ya está cancelada."
          : "La compra no entregó fichas: se cancela con el procedimiento del Módulo 08 (liberando la reserva); no requiere contraasientos.",
      ],
      effects: null,
    }
  const summary = summarizePayments(f.nominal, f.payments)
  const a = f.debt?.allocations ?? []
  const abonos = net(a, "RECEIVABLE_PAYMENT")
  const offsets = net(a, "CHIP_SETTLEMENT_OFFSET")
  const extinguishedBefore = net(a, "PURCHASE_REVERSAL")
  const linked = net(a, "PURCHASE_PAYMENT")
  const applied = abonos.add(offsets).add(linked).add(extinguishedBefore)
  const balance = f.debt ? f.debt.original.sub(applied) : ZERO
  const purchaseMoney = summary.confirmedPayments
  const refund = purchaseMoney.add(abonos).add(offsets)
  const breakdown = {
    cash: fmt(summary.confirmedCash),
    card: fmt(summary.approvedCardDebit.add(summary.approvedCardCredit)),
    transferVerified: fmt(summary.verifiedBankTransfers),
    abonos: fmt(abonos),
    offsets: fmt(offsets),
  }
  if (summary.pendingTransfers.greaterThan(0))
    blockers.push(
      "La compra tiene una transferencia pendiente de verificar: verifícala o recházala primero (no es dinero recibido)."
    )
  if (summary.pendingCards.greaterThan(0))
    blockers.push("La compra tiene un cobro de terminal sin resolver.")
  if (balance.lessThan(0))
    blockers.push(
      "La deuda de la compra está sobreaplicada: revisa la integridad antes de revertir."
    )
  if (f.sessionStatus === "CLOSING")
    blockers.push(
      "La sesión de la compra está en cierre: regrésala a OPEN o termina el cierre antes de revertir."
    )
  if (f.participationSettled)
    blockers.push(
      "La participación ya se liquidó (o tiene una liquidación en curso): las fichas ya regresaron por la liquidación. Corrige la liquidación (16.3) en lugar de revertir la compra."
    )
  if (!f.approvedCorrection)
    blockers.push(
      "Requiere una solicitud de corrección APROBADA por PARTNER o SUPERADMIN (Módulo 15)."
    )
  let classification: ReversalClassification = "FULL_REVERSAL"
  if (
    !f.physicalReturn.confirmed ||
    !f.physicalReturn.nominal?.equals(f.nominal)
  ) {
    classification = "PHYSICAL_RETURN_PENDING"
    blockers.push(
      `Las fichas deben regresar físicamente por el valor completo de la compra ($${fmt(f.nominal)}) y confirmarse su recepción. No se registra una restitución ficticia.`
    )
  }
  if (
    summary.pendingTransfers.greaterThan(0) ||
    summary.pendingCards.greaterThan(0) ||
    balance.lessThan(0) ||
    f.participationSettled ||
    f.sessionStatus === "CLOSING"
  )
    classification = "NOT_REVERSIBLE_AUTOMATICALLY"
  const identity = balance.add(refund).equals(f.nominal)
  if (!identity && blockers.length === 0)
    blockers.push(
      "Los importes de la compra no cuadran (extinción + reembolso ≠ nominal): revísalo con el diagnóstico de integridad."
    )
  return {
    classification,
    executable: blockers.length === 0,
    blockers,
    effects: {
      chipsToReturn: fmt(f.nominal),
      extinguish: fmt(balance.greaterThan(0) ? balance : ZERO),
      refund: fmt(refund),
      refundBreakdown: breakdown,
      linkedAlreadyCounted: fmt(linked),
      identityOk: identity,
      refundPending: refund.greaterThan(0),
    },
  }
}

export type PurchaseReversalPlan = ReturnType<typeof planPurchaseReversal>

// ── Corrección de liquidación ─────────────────────────────────────────

export function planSettlementCorrection(f: {
  status: string
  activeOffsets: Dec
  alreadyReversedOffsets: boolean
  approvedCorrection: boolean
  kind: "ADDITIONAL_PAYOUT" | "OFFSET_REVERSAL"
  amount: Dec | null
}) {
  const blockers: string[] = []
  if (!["PENDING_PAYOUT", "COMPLETED"].includes(f.status))
    blockers.push(
      "Solo se corrigen liquidaciones con fichas recibidas (y no revertidas)."
    )
  if (!f.approvedCorrection)
    blockers.push(
      "Requiere una solicitud de corrección APROBADA por PARTNER o SUPERADMIN (Módulo 15)."
    )
  let amount = ZERO
  if (f.kind === "OFFSET_REVERSAL") {
    if (f.alreadyReversedOffsets)
      blockers.push("La compensación de esta liquidación ya se revirtió.")
    if (!f.activeOffsets.greaterThan(0))
      blockers.push(
        "La liquidación no tiene compensación vigente que revertir."
      )
    amount = f.activeOffsets
  } else {
    if (!f.amount || !f.amount.greaterThan(0))
      blockers.push("Indica el importe adicional que el negocio debe pagar.")
    amount = f.amount ?? ZERO
  }
  return {
    executable: blockers.length === 0,
    blockers,
    effects: {
      kind: f.kind,
      amount: fmt(amount),
      /** OFFSET_REVERSAL: las deudas recuperan el saldo compensado (contraasientos). */
      debtsRestored: f.kind === "OFFSET_REVERSAL" ? fmt(amount) : "0.00",
      /** Nueva obligación por pagar al jugador (dinero real pendiente). */
      newPayable: fmt(amount),
      cashIn: "0.00",
    },
  }
}

// ── Fondos no aplicados ───────────────────────────────────────────────

export type UnappliedStatus =
  "PENDING_REVIEW" | "PENDING_REFUND" | "PARTIALLY_REFUNDED" | "REFUNDED"

export function unappliedStatusFor(
  payable: { original: Dec; payouts: PayoutLike[] } | null
): UnappliedStatus {
  if (!payable) return "PENDING_REVIEW"
  const s = payableState(payable.original, payable.payouts)
  return s.status === "PAID"
    ? "REFUNDED"
    : s.status === "PARTIALLY_PAID"
      ? "PARTIALLY_REFUNDED"
      : "PENDING_REFUND"
}

export const SPECIAL_DECLARATIONS = {
  REDEMPTION:
    "Entrego físicamente las fichas descritas, acepto el valor validado y entiendo que se me pagará únicamente lo registrado como pagado; lo pendiente queda como obligación.",
  SETTLEMENT_CORRECTION:
    "Acepto la corrección de mi liquidación descrita en este resumen; la liquidación original, su firma y los pagos ya realizados se conservan.",
} as const

export const SPECIAL_DECLARATION_VERSION = "2026-10-m16-v1"
