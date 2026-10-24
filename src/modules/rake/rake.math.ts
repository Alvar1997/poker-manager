import { Prisma } from "@/generated/prisma/client"

/**
 * Reglas PURAS del rake por mesa (Módulo 18, simplificado). El rake
 * pertenece a la casa, se identifica por mesa (ciclo) y se cuenta UNA sola
 * vez sin importar la modalidad. Nunca se reduce por propinas directas.
 *
 * - MANUAL: reconocido = Σ registros + Σ correcciones; el conteo del
 *   recipiente es de comprobación (diferencia = contado − reconocido).
 * - FINAL_COUNT: reconocido = contado + Σ correcciones.
 */

export type Dec = Prisma.Decimal
export const ZERO = new Prisma.Decimal(0)
export const dec = (v: Prisma.Decimal | string | number | null | undefined) =>
  new Prisma.Decimal(v ?? 0)
export const fmt = (v: Prisma.Decimal) => v.toFixed(2)

export type RakeModeValue = "MANUAL" | "FINAL_COUNT"

export type CycleRakeStatus =
  /** El ciclo sigue abierto. */
  | "OPEN"
  /** Conteo final pendiente (FINAL_COUNT sin conteo: rake $0 por ahora). */
  | "COUNT_PENDING"
  /** Manual sin conteo de comprobación (se reconoce lo registrado). */
  | "NOT_VERIFIED"
  /** Conciliado (conteo = reconocido). */
  | "RECONCILED"
  /** Comprobación con diferencia frente a lo registrado (MANUAL). */
  | "DIFFERENCE"

export function cycleRake(input: {
  mode: RakeModeValue
  cycleClosed: boolean
  entries: Dec[]
  corrections: Dec[]
  count: { counted: Dec } | null
}) {
  const registered = input.entries.reduce((a, x) => a.add(x), ZERO)
  const corrected = input.corrections.reduce((a, x) => a.add(x), ZERO)
  const counted = input.count ? input.count.counted : null
  const recognized =
    input.mode === "FINAL_COUNT"
      ? (counted ?? ZERO).add(corrected)
      : registered.add(corrected)
  const difference =
    counted === null
      ? null
      : input.mode === "FINAL_COUNT"
        ? ZERO
        : counted.sub(registered.add(corrected))
  const status: CycleRakeStatus = !input.cycleClosed
    ? "OPEN"
    : counted === null
      ? input.mode === "FINAL_COUNT"
        ? "COUNT_PENDING"
        : "NOT_VERIFIED"
      : difference!.isZero()
        ? "RECONCILED"
        : "DIFFERENCE"
  return { registered, corrected, recognized, counted, difference, status }
}

/** Acumulado cronológico (historial de la mesa). */
export function runningTotals<T extends { amount: Dec }>(rows: T[]) {
  let acc = ZERO
  return rows.map((r) => {
    acc = acc.add(r.amount)
    return { ...r, cumulative: acc }
  })
}

/** La modalidad se cambia con la mesa cerrada (evita registros mezclados). */
export function rakeModeChangeBlocker(input: {
  openCycles: number
}): string | null {
  if (input.openCycles > 0)
    return "La mesa está abierta: cambia la modalidad con la mesa cerrada."
  return null
}
