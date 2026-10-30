import { appConfig } from "@/config/app.config"

/**
 * Utilidades de fecha/moneda — ver docs/BUSINESS_RULES.md sección "Fechas
 * y zona horaria".
 *
 * Regla: los timestamps se almacenan siempre como instantes UTC (así los
 * guarda Prisma/PostgreSQL por defecto con `DateTime`). Estas funciones
 * son la única vía para mostrarlos al usuario en la zona horaria del
 * negocio — nunca formatear una fecha "a mano" en otra parte del código.
 */

const DEFAULT_LOCALE = appConfig.locale // es-MX
const DEFAULT_TIMEZONE = appConfig.timezone // America/Monterrey

export function formatDateTime(date: Date | string): string {
  const value = typeof date === "string" ? new Date(date) : date
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    timeZone: DEFAULT_TIMEZONE,
    dateStyle: "short",
    timeStyle: "short",
  }).format(value)
}

export function formatDate(date: Date | string): string {
  const value = typeof date === "string" ? new Date(date) : date
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    timeZone: DEFAULT_TIMEZONE,
    dateStyle: "long",
  }).format(value)
}

export function formatCurrencyMXN(amount: number): string {
  return new Intl.NumberFormat(DEFAULT_LOCALE, {
    style: "currency",
    currency: appConfig.currency,
  }).format(amount)
}

/**
 * Fecha operativa ("businessDate") de un instante dado: el día calendario
 * en la zona horaria del negocio, no la del servidor. Una sesión que
 * empieza a las 23:30 y termina a la 1:00 del día siguiente pertenece
 * operativamente a la fecha en que comenzó — ese cálculo de "a qué
 * sesión/día pertenece" se implementa en el módulo de sesiones; esta
 * función solo resuelve el día calendario en la zona horaria correcta.
 */
export function businessDateOf(date: Date | string): string {
  const value = typeof date === "string" ? new Date(date) : date
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value) // YYYY-MM-DD
}

/** Diferencia (ms) entre la hora local del negocio y UTC en ese instante. */
function zoneOffsetMs(instant: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_TIMEZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant))
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value)
  const asUtc = Date.UTC(
    n("year"),
    n("month") - 1,
    n("day"),
    n("hour"),
    n("minute"),
    n("second")
  )
  return asUtc - Math.floor(instant / 1000) * 1000
}

/**
 * Instante UTC de una fecha y hora LOCALES del negocio (America/Monterrey):
 * `2026-10-24` + `20:00` → 2026-10-25T02:00:00Z. Devuelve null si la fecha
 * u hora no son válidas o si esa hora no existe en la zona (cambio de horario).
 */
export function zonedDateTimeToUtc(day: string, time: string): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  const t = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time)
  if (!d || !t) return null
  const guess = Date.UTC(
    Number(d[1]),
    Number(d[2]) - 1,
    Number(d[3]),
    Number(t[1]),
    Number(t[2])
  )
  let utc = guess - zoneOffsetMs(guess)
  utc = guess - zoneOffsetMs(utc)
  const back = new Date(utc)
  // Verifica que la hora local resultante sea exactamente la pedida.
  if (businessDateOf(back) !== day || localTimeOf(back) !== time) return null
  return back
}

/** Hora local del negocio `HH:MM` de un instante. */
export function localTimeOf(date: Date | string): string {
  const value = typeof date === "string" ? new Date(date) : date
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: DEFAULT_TIMEZONE,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value)
}
