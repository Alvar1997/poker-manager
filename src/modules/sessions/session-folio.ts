/**
 * Folio público de sesión y fecha operativa — reglas PURAS (servidor y
 * cliente). Ver docs/SESSION_FOLIO_AND_HISTORICAL_ENTRY.md.
 *
 *   S-0001-20261014 = «S» + consecutivo global (mín. 4 dígitos, sin
 *   truncar) + fecha operativa YYYYMMDD.
 *
 * El consecutivo lo emite SOLO el servidor (`issueSessionFolio`, atómico en
 * PostgreSQL); el folio nunca se recalcula después de crearse.
 */

export const SESSION_FOLIO_PREFIX = "S"
export const SESSION_FOLIO_MIN_DIGITS = 4

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** ¿Es una fecha calendario real con formato YYYY-MM-DD? */
export function isCalendarDate(value: string): boolean {
  const m = DAY.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d
  )
}

/** 2026-10-14 → 20261014. */
export function compactBusinessDate(businessDate: string): string {
  if (!isCalendarDate(businessDate))
    throw new Error(`Fecha operativa inválida: ${businessDate}`)
  return businessDate.replaceAll("-", "")
}

/** Consecutivo con al menos 4 dígitos (10000 se muestra completo). */
export function padSessionSequence(sequenceNumber: number): string {
  if (!Number.isInteger(sequenceNumber) || sequenceNumber < 1)
    throw new Error(`Consecutivo inválido: ${sequenceNumber}`)
  return String(sequenceNumber).padStart(SESSION_FOLIO_MIN_DIGITS, "0")
}

/** S-0001-20261014. */
export function formatSessionFolio(
  sequenceNumber: number,
  businessDate: string
): string {
  return `${SESSION_FOLIO_PREFIX}-${padSessionSequence(sequenceNumber)}-${compactBusinessDate(businessDate)}`
}

const FOLIO = /^S-(\d{4,})-(\d{4})(\d{2})(\d{2})$/

/** Desarma un folio nuevo (o null si no tiene el formato). */
export function parseSessionFolio(
  folio: string
): { sequenceNumber: number; businessDate: string } | null {
  const m = FOLIO.exec(folio)
  if (!m) return null
  const businessDate = `${m[2]}-${m[3]}-${m[4]}`
  if (!isCalendarDate(businessDate)) return null
  return { sequenceNumber: Number(m[1]), businessDate }
}

/** 2026-10-14 → 14/10/2026 (formato mexicano para mostrar). */
export function formatBusinessDateMx(businessDate: string): string {
  const m = DAY.exec(businessDate)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : businessDate
}

/** Fecha mínima aceptada para captura histórica (evita errores de captura). */
export const HISTORICAL_MIN_DATE = "2000-01-01"

export type HistoricalDateCheck =
  | { ok: true }
  | { ok: false; reason: "INVALID" | "TOO_OLD" | "TODAY" | "FUTURE" }

/**
 * Una sesión histórica debe ser de un día ANTERIOR al día operativo actual
 * (`today`, en la zona del negocio): no hoy ni futura. Comparación de
 * cadenas YYYY-MM-DD (orden lexicográfico = cronológico).
 */
export function checkHistoricalDate(
  businessDate: string,
  today: string
): HistoricalDateCheck {
  if (!isCalendarDate(businessDate)) return { ok: false, reason: "INVALID" }
  if (businessDate < HISTORICAL_MIN_DATE)
    return { ok: false, reason: "TOO_OLD" }
  if (businessDate === today) return { ok: false, reason: "TODAY" }
  if (businessDate > today) return { ok: false, reason: "FUTURE" }
  return { ok: true }
}

export const HISTORICAL_DATE_MESSAGE: Record<
  Exclude<HistoricalDateCheck, { ok: true }>["reason"],
  string
> = {
  INVALID: "La fecha operativa no es válida.",
  TOO_OLD: "La fecha operativa es demasiado antigua.",
  TODAY:
    "Una sesión de hoy se crea con el flujo normal, no como captura histórica.",
  FUTURE: "No se pueden registrar sesiones de fechas futuras.",
}
