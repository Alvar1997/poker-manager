import { Prisma } from "@/generated/prisma/client"

/**
 * Cálculos puros de la caja. Importes SIEMPRE con Prisma.Decimal (nunca
 * Float). Precisión MXN: 2 decimales.
 */

export const ZERO = new Prisma.Decimal(0)

export function money(value: string | number | Prisma.Decimal): Prisma.Decimal {
  return new Prisma.Decimal(value).toDecimalPlaces(
    2,
    Prisma.Decimal.ROUND_HALF_UP
  )
}

export function formatMoney(value: Prisma.Decimal): string {
  return value.toFixed(2)
}

/** Efecto de una partida en el saldo deudor (DEBIT suma, CREDIT resta). */
export function signedAmount(
  direction: "DEBIT" | "CREDIT",
  amount: Prisma.Decimal
) {
  return direction === "DEBIT" ? amount : amount.neg()
}

export type EntryLike = {
  direction: "DEBIT" | "CREDIT"
  amount: Prisma.Decimal
}

/** Una transacción cuadra si sus débitos igualan a sus créditos. */
export function isBalanced(entries: EntryLike[]): boolean {
  if (entries.length < 2) return false
  const total = entries.reduce(
    (acc, e) => acc.add(signedAmount(e.direction, e.amount)),
    ZERO
  )
  return total.isZero()
}

/** Faltante para cubrir una salida (0 si alcanza). */
export function shortfall(
  available: Prisma.Decimal,
  requested: Prisma.Decimal
): Prisma.Decimal {
  return requested.greaterThan(available) ? requested.sub(available) : ZERO
}

export type PaymentComponent =
  | { method: "CASH"; amount: Prisma.Decimal }
  | { method: "BANK_TRANSFER"; amount: Prisma.Decimal }
  | { method: "CREDIT"; amount: Prisma.Decimal }

/**
 * Pago mixto (MIX-01…07): cada componente por separado; deben sumar
 * exactamente el importe (el excedente no se maneja implícitamente) y no
 * se repite un método. Solo efectivo genera entrada inmediata; la
 * transferencia queda pendiente de verificación; el crédito NO es dinero.
 */
export function splitPayment(
  total: Prisma.Decimal,
  components: PaymentComponent[]
) {
  if (!total.greaterThan(0))
    throw new Error("El importe debe ser mayor que cero")
  const methods = new Set<string>()
  for (const c of components) {
    if (!c.amount.greaterThan(0))
      throw new Error("Cada componente debe ser mayor que cero")
    if (methods.has(c.method))
      throw new Error(`Componente ${c.method} repetido`)
    methods.add(c.method)
  }
  const sum = components.reduce((acc, c) => acc.add(c.amount), ZERO)
  if (!sum.equals(total)) {
    throw new Error(
      sum.greaterThan(total)
        ? "Los componentes exceden el importe de la operación"
        : "Los componentes no cubren el importe: el resto debe registrarse explícitamente como crédito"
    )
  }
  const get = (m: PaymentComponent["method"]) =>
    components.find((c) => c.method === m)?.amount ?? ZERO
  return {
    cashNow: get("CASH"),
    bankPending: get("BANK_TRANSFER"),
    credit: get("CREDIT"),
    /** Dinero que entra en el momento: solo efectivo. */
    moneyReceivedNow: get("CASH"),
  }
}

/**
 * Liquidación: la compensación FIFO de deuda NO mueve efectivo; solo se
 * paga en efectivo el neto (valor de fichas − deuda compensada).
 */
export function settlementCashOut(
  chipsValue: Prisma.Decimal,
  debtCompensated: Prisma.Decimal
) {
  if (chipsValue.isNegative() || debtCompensated.isNegative())
    throw new Error("Importes inválidos")
  if (debtCompensated.greaterThan(chipsValue))
    throw new Error("La compensación no puede exceder el valor de las fichas")
  return chipsValue.sub(debtCompensated)
}

/**
 * Defensa complementaria (no es el control principal, que es el catálogo
 * cerrado de tipos y destinos): rechaza motivos que describen un gasto
 * operativo evidente en retiros y traslados.
 */
const EXPENSE_WORDS = [
  "comida",
  "comidas",
  "bebida",
  "bebidas",
  "refresco",
  "refrescos",
  "cerveza",
  "cervezas",
  "botana",
  "botanas",
  "alimento",
  "alimentos",
  "cena",
  "desayuno",
  "insumo",
  "insumos",
  "gasolina",
  "transporte",
  "taxi",
  "uber",
  "renta",
  "propina",
  "propinas",
  "limpieza",
  "papeleria",
  "papelería",
  "servicio de luz",
  "recibo de luz",
  "pago de luz",
  "internet",
  "gasto",
  "gastos",
]

export function looksLikeOperatingExpense(text: string): boolean {
  const normalized = ` ${text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")} `
  return EXPENSE_WORDS.some((word) => {
    const w = word.normalize("NFD").replace(/[̀-ͯ]/g, "")
    return new RegExp(`[^a-z]${w}[^a-z]`).test(normalized)
  })
}
