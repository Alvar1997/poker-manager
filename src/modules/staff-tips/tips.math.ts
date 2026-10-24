import { Prisma } from "@/generated/prisma/client"

/**
 * Reglas PURAS de propinas (Módulo 18, simplificado). Las propinas son de
 * cada EMPLEADO por SESIÓN; solo se registran importes nominales (sin
 * turnos, firmas, pagos ni saldos del staff).
 *
 * Regla determinista para no contar dos veces:
 *  - PARCIALES: informativos (lo anotado durante la noche); NO se suman.
 *  - CONTEO: uno por empleado y sesión. Solo el CONFIRMADO cuenta.
 *  - CORRECCIONES (±, motivo): se suman al conteo confirmado.
 *  reconocido = conteo confirmado + Σ correcciones (sin conteo confirmado: $0).
 */

export type Dec = Prisma.Decimal
export const ZERO = new Prisma.Decimal(0)
export const dec = (v: Prisma.Decimal | string | number | null | undefined) =>
  new Prisma.Decimal(v ?? 0)
export const fmt = (v: Prisma.Decimal) => v.toFixed(2)

export type TipCountState = "NONE" | "DRAFT" | "CONFIRMED"

export function staffTipFigures(input: {
  count: { status: "DRAFT" | "CONFIRMED"; amount: Dec } | null
  entries: { kind: "PARTIAL" | "CORRECTION"; amount: Dec }[]
}) {
  const partials = input.entries
    .filter((e) => e.kind === "PARTIAL")
    .reduce((a, e) => a.add(e.amount), ZERO)
  const corrections = input.entries
    .filter((e) => e.kind === "CORRECTION")
    .reduce((a, e) => a.add(e.amount), ZERO)
  const state: TipCountState = input.count ? input.count.status : "NONE"
  const confirmed = state === "CONFIRMED" ? input.count!.amount : ZERO
  return {
    state,
    partials,
    draft: state === "DRAFT" ? input.count!.amount : null,
    confirmedCount: state === "CONFIRMED" ? confirmed : null,
    corrections,
    /** Importe que entra a la conciliación (una sola vez). */
    recognized: state === "CONFIRMED" ? confirmed.add(corrections) : ZERO,
    /** Conteo vs parciales anotados (informativo). */
    countVsPartials:
      state === "CONFIRMED" && partials.greaterThan(0)
        ? confirmed.sub(partials)
        : null,
  }
}
export type StaffTipFigures = ReturnType<typeof staffTipFigures>

export function tipsTotal(rows: { recognized: Dec }[]) {
  return rows.reduce((a, r) => a.add(r.recognized), ZERO)
}
