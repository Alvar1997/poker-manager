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
