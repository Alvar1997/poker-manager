/**
 * Configuración general de la aplicación, no secreta (segura de importar
 * tanto en cliente como servidor). Credenciales y connection strings
 * viven en src/lib/env.ts, no aquí.
 */
export const appConfig = {
  name: process.env.NEXT_PUBLIC_APP_NAME || "Poker Manager",
  timezone: process.env.APP_TIMEZONE || "America/Monterrey",
  locale: "es-MX",
  currency: "MXN",
} as const
