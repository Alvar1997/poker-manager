import { Prisma } from "@/generated/prisma/client"

/**
 * Cálculos PUROS de cuentas por cobrar (Módulo 10). Importes con
 * Prisma.Decimal; nunca Float.
 *
 *   saldo de una deuda = original − Σ aplicaciones + Σ reversos de aplicaciones
 *
 * FIFO: primero la deuda más antigua (fecha en que nació), con desempate
 * estable por id. Nunca se aplica más que el saldo de una deuda ni más que
 * el importe del pago; la suma de aplicaciones es exactamente lo aplicado.
 */

export const ZERO = new Prisma.Decimal(0)

export type AllocationLike = {
  kind: "APPLICATION" | "REVERSAL"
  amount: Prisma.Decimal
}

export function appliedNet(allocations: AllocationLike[]): Prisma.Decimal {
  return allocations.reduce(
    (acc, a) =>
      a.kind === "APPLICATION" ? acc.add(a.amount) : acc.sub(a.amount),
    ZERO
  )
}

export type ReceivableStatus = "OPEN" | "PARTIALLY_PAID" | "PAID" | "VOIDED"

/** Estado derivado (nunca editable): coherente con el saldo real. */
export function receivableStatus(
  original: Prisma.Decimal,
  applied: Prisma.Decimal,
  voided = false
): ReceivableStatus {
  if (voided) return "VOIDED"
  const balance = original.sub(applied)
  if (balance.lessThanOrEqualTo(0)) return "PAID"
  return applied.greaterThan(0) ? "PARTIALLY_PAID" : "OPEN"
}

export type OpenReceivable = {
  id: string
  createdAt: Date
  balance: Prisma.Decimal
}

/** Orden FIFO: fecha de nacimiento y luego id (estable para empates). */
export function fifoOrder<T extends { id: string; createdAt: Date }>(
  receivables: T[]
): T[] {
  return [...receivables].sort((a, b) => {
    const t = a.createdAt.getTime() - b.createdAt.getTime()
    return t !== 0 ? t : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

export type FifoAllocation = {
  receivableId: string
  amount: Prisma.Decimal
  order: number
  balanceBefore: Prisma.Decimal
  balanceAfter: Prisma.Decimal
}

/**
 * Distribuye `amount` por FIFO. Lanza si excede la deuda total (no hay
 * saldos a favor). Devuelve solo las deudas afectadas.
 */
export function allocateFifo(
  receivables: OpenReceivable[],
  amount: Prisma.Decimal
): FifoAllocation[] {
  if (!amount.greaterThan(0))
    throw new Error("El importe debe ser mayor que cero")
  if (!amount.equals(amount.toDecimalPlaces(2)))
    throw new Error("El importe admite como máximo dos decimales")
  const open = fifoOrder(receivables.filter((r) => r.balance.greaterThan(0)))
  const total = open.reduce((acc, r) => acc.add(r.balance), ZERO)
  if (amount.greaterThan(total)) throw new ExcessPaymentError(total)
  let remaining = amount
  const result: FifoAllocation[] = []
  for (const r of open) {
    if (!remaining.greaterThan(0)) break
    const take = Prisma.Decimal.min(remaining, r.balance)
    result.push({
      receivableId: r.id,
      amount: take,
      order: result.length + 1,
      balanceBefore: r.balance,
      balanceAfter: r.balance.sub(take),
    })
    remaining = remaining.sub(take)
  }
  return result
}

export class ExcessPaymentError extends Error {
  constructor(readonly outstanding: Prisma.Decimal) {
    super(
      outstanding.isZero()
        ? "El jugador no tiene deuda pendiente: no se registran abonos ni saldos a favor."
        : `El importe supera la deuda pendiente de $${outstanding.toFixed(2)}.`
    )
    this.name = "ExcessPaymentError"
  }
}

/** Parte aplicable y excedente (dinero ya recibido que no se puede aplicar). */
export function splitApplicable(
  received: Prisma.Decimal,
  outstanding: Prisma.Decimal
) {
  const applicable = Prisma.Decimal.min(
    received,
    Prisma.Decimal.max(outstanding, ZERO)
  )
  return { applicable, excess: received.sub(applicable) }
}
