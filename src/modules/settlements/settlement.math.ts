import { Prisma } from "@/generated/prisma/client"
import { settlementCashOut } from "@/modules/cash/cash.math"
import {
  allocateFifo,
  ZERO,
  type FifoAllocation,
  type OpenReceivable,
} from "@/modules/credits/credit.math"

/**
 * Cálculos PUROS de liquidaciones (Módulo 11). Importes con Prisma.Decimal;
 * nunca Float. Los usan el servidor (dentro de la transacción) y las
 * pruebas; la pantalla solo muestra lo que devuelve el servidor.
 *
 *   offsetAmount  ≤ min(returnedNominalAmount, outstandingDebt)
 *   netPayout     = returnedNominalAmount − offsetAmount
 *   pendingPayout = netPayout − Σ desembolsos EXECUTED
 *
 * La compensación es OPCIONAL: solo existe si el cajero lo decide
 * (PARTIAL o MAXIMUM). Si compensa, la distribución es el FIFO del Módulo
 * 10 (`allocateFifo`), nunca una selección manual de deudas.
 */

export type OffsetDecision = "NO_COMPENSATE" | "PARTIAL" | "MAXIMUM"

export const OFFSET_DECISIONS: readonly OffsetDecision[] = [
  "NO_COMPENSATE",
  "PARTIAL",
  "MAXIMUM",
]

export class SettlementRuleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SettlementRuleError"
  }
}

const fmt = (v: Prisma.Decimal) => v.toFixed(2)

export const SETTLEMENT_RULE_MESSAGES = {
  negative: "El valor de las fichas devueltas no puede ser negativo.",
  decimals: "Los importes admiten como máximo dos decimales.",
  zeroReturned:
    "No se puede compensar deuda si se devolvieron $0 en fichas: elige «No compensar».",
  noDebt: "El jugador no tiene deuda pendiente: elige «No compensar».",
  partialRequired: "Indica el importe a compensar.",
  partialPositive: "La compensación parcial debe ser mayor que cero.",
  offsetForbidden:
    "Solo la compensación parcial lleva un importe: el máximo lo calcula el sistema.",
} as const

function assertMoney(v: Prisma.Decimal, allowZero: boolean) {
  if (v.isNegative() || (!allowZero && v.isZero()))
    throw new SettlementRuleError(SETTLEMENT_RULE_MESSAGES.negative)
  if (!v.equals(v.toDecimalPlaces(2)))
    throw new SettlementRuleError(SETTLEMENT_RULE_MESSAGES.decimals)
}

/** Importe a compensar según la decisión EXPLÍCITA del cajero. */
export function resolveOffset(input: {
  returned: Prisma.Decimal
  outstanding: Prisma.Decimal
  decision: OffsetDecision
  requested?: Prisma.Decimal | null
}): Prisma.Decimal {
  const { returned, outstanding, decision } = input
  const requested = input.requested ?? null
  assertMoney(returned, true)
  if (decision === "NO_COMPENSATE") {
    if (requested)
      throw new SettlementRuleError(SETTLEMENT_RULE_MESSAGES.offsetForbidden)
    return ZERO
  }
  if (returned.isZero())
    throw new SettlementRuleError(SETTLEMENT_RULE_MESSAGES.zeroReturned)
  if (!outstanding.greaterThan(0))
    throw new SettlementRuleError(SETTLEMENT_RULE_MESSAGES.noDebt)
  if (decision === "MAXIMUM") {
    if (requested)
      throw new SettlementRuleError(SETTLEMENT_RULE_MESSAGES.offsetForbidden)
    return Prisma.Decimal.min(returned, outstanding)
  }
  if (!requested)
    throw new SettlementRuleError(SETTLEMENT_RULE_MESSAGES.partialRequired)
  if (!requested.greaterThan(0))
    throw new SettlementRuleError(SETTLEMENT_RULE_MESSAGES.partialPositive)
  assertMoney(requested, false)
  if (requested.greaterThan(returned))
    throw new SettlementRuleError(
      `La compensación no puede exceder el valor de las fichas devueltas (${fmt(returned)}).`
    )
  if (requested.greaterThan(outstanding))
    throw new SettlementRuleError(
      `La compensación no puede exceder la deuda pendiente (${fmt(outstanding)}).`
    )
  return requested
}

export type SettlementPlan = {
  returned: Prisma.Decimal
  outstanding: Prisma.Decimal
  decision: OffsetDecision
  offset: Prisma.Decimal
  allocations: FifoAllocation[]
  net: Prisma.Decimal
  remainingDebt: Prisma.Decimal
}

/**
 * Plan completo: compensación, distribución FIFO (solo si se compensa) y
 * pago neto. El servidor lo recalcula dentro de la transacción de
 * confirmación; la vista previa es informativa.
 */
export function planSettlement(input: {
  returned: Prisma.Decimal
  receivables: OpenReceivable[]
  decision: OffsetDecision
  requested?: Prisma.Decimal | null
}): SettlementPlan {
  const outstanding = input.receivables
    .filter((r) => r.balance.greaterThan(0))
    .reduce((acc, r) => acc.add(r.balance), ZERO)
  const offset = resolveOffset({
    returned: input.returned,
    outstanding,
    decision: input.decision,
    requested: input.requested,
  })
  const allocations = offset.greaterThan(0)
    ? allocateFifo(input.receivables, offset)
    : []
  return {
    returned: input.returned,
    outstanding,
    decision: input.decision,
    offset,
    allocations,
    net: settlementCashOut(input.returned, offset),
    remainingDebt: outstanding.sub(offset),
  }
}

// ── Cuenta por pagar y desembolsos ───────────────────────────────────

export type PayoutStatus = "PENDING" | "EXECUTED" | "FAILED" | "CANCELLED"
export type PayoutLike = { amount: Prisma.Decimal; status: PayoutStatus }

export type PayableState = {
  original: Prisma.Decimal
  /** Pagado de verdad (solo EXECUTED). */
  executed: Prisma.Decimal
  /** Transferencias en trámite (PENDING): no cuentan como pagadas. */
  reserved: Prisma.Decimal
  /** Lo que falta pagar = original − ejecutado. */
  pending: Prisma.Decimal
  /** Lo que aún se puede registrar = original − ejecutado − reservado. */
  available: Prisma.Decimal
  status: "OPEN" | "PARTIALLY_PAID" | "PAID"
}

export function payableState(
  original: Prisma.Decimal,
  payouts: PayoutLike[]
): PayableState {
  const sum = (status: PayoutStatus) =>
    payouts
      .filter((p) => p.status === status)
      .reduce((acc, p) => acc.add(p.amount), ZERO)
  const executed = sum("EXECUTED")
  const reserved = sum("PENDING")
  const pending = original.sub(executed)
  const available = pending.sub(reserved)
  if (pending.isNegative() || available.isNegative())
    throw new SettlementRuleError(
      "Los desembolsos exceden la cuenta por pagar (error de integridad)."
    )
  return {
    original,
    executed,
    reserved,
    pending,
    available,
    status: pending.isZero()
      ? "PAID"
      : executed.greaterThan(0)
        ? "PARTIALLY_PAID"
        : "OPEN",
  }
}

/** Un desembolso nuevo nunca excede lo pendiente (descontando lo reservado). */
export function assertPayoutFits(state: PayableState, amount: Prisma.Decimal) {
  if (!amount.greaterThan(0))
    throw new SettlementRuleError("El pago debe ser mayor que cero.")
  if (!amount.equals(amount.toDecimalPlaces(2)))
    throw new SettlementRuleError(SETTLEMENT_RULE_MESSAGES.decimals)
  if (state.pending.isZero())
    throw new SettlementRuleError(
      "La liquidación ya está pagada: no hay saldo por pagar."
    )
  if (amount.greaterThan(state.available))
    throw new SettlementRuleError(
      state.reserved.greaterThan(0)
        ? `El pago excede el saldo disponible: faltan ${fmt(state.pending)} por pagar y ${fmt(state.reserved)} están en transferencias en trámite. Máximo ${fmt(state.available)}.`
        : `El pago excede el saldo por pagar de ${fmt(state.available)}.`
    )
}
