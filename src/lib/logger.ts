import pino from "pino"

/**
 * Logger estructurado centralizado.
 *
 * Nunca pasar aquí: contraseñas, tokens, cookies, connection strings,
 * firmas digitales ni datos personales innecesarios. `redact` corta de
 * raíz los campos más comunes por accidente; aun así, revisa el payload
 * antes de loguearlo.
 */
export const logger = pino({
  level:
    process.env.LOG_LEVEL ??
    (process.env.NODE_ENV === "production" ? "info" : "debug"),
  redact: {
    paths: [
      "password",
      "passwordHash",
      "*.password",
      "*.passwordHash",
      "token",
      "*.token",
      "authorization",
      "req.headers.authorization",
      "req.headers.cookie",
      "DATABASE_URL",
      "DIRECT_URL",
      "AUTH_SECRET",
    ],
    censor: "[REDACTED]",
  },
  formatters: {
    level(label) {
      return { level: label }
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
})

export type LogEvent = {
  event: string
  requestId?: string
  userId?: string
  durationMs?: number
  [key: string]: unknown
}

/** Logger hijo para una request HTTP: incluye requestId en cada línea. */
export function createRequestLogger(requestId: string) {
  return logger.child({ requestId })
}
