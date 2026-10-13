import "server-only"

import { createHash } from "node:crypto"

import { prisma } from "@/lib/prisma"

/**
 * Protección contra fuerza bruta en el login.
 *
 * Ventana fija por clave, con bloqueo temporal al superar el umbral:
 * - Por correo: 5 fallos en 15 min → bloqueo de 15 min.
 * - Por IP:    30 fallos en 15 min → bloqueo de 15 min.
 *
 * Se cuentan fallos también para correos inexistentes, de modo que el
 * bloqueo no revela si una cuenta existe. El correo se guarda como hash
 * SHA-256 (sin PII en claro). Persistido en Postgres porque en
 * serverless no hay memoria compartida entre instancias.
 */

const WINDOW_MS = 15 * 60 * 1000
const LOCK_MS = 15 * 60 * 1000

export const THROTTLE_LIMITS = {
  email: 5,
  ip: 30,
} as const

type ThrottleKey = { key: string; limit: number }

export function emailThrottleKey(email: string): ThrottleKey {
  const digest = createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex")
  return { key: `email:${digest}`, limit: THROTTLE_LIMITS.email }
}

export function ipThrottleKey(ip: string): ThrottleKey {
  return { key: `ip:${ip}`, limit: THROTTLE_LIMITS.ip }
}

/** true si alguna de las claves está bloqueada en este momento. */
export async function isThrottled(
  keys: readonly ThrottleKey[],
  now = new Date()
): Promise<boolean> {
  const locked = await prisma.loginThrottle.findFirst({
    where: {
      key: { in: keys.map((k) => k.key) },
      lockedUntil: { gt: now },
    },
    select: { key: true },
  })
  return locked !== null
}

/** Registra un fallo de forma atómica (concurrencia-segura) y bloquea si se alcanza el límite. */
export async function registerFailure(
  keys: readonly ThrottleKey[],
  now = new Date()
): Promise<void> {
  const windowStart = new Date(now.getTime() - WINDOW_MS)
  const lockedUntil = new Date(now.getTime() + LOCK_MS)

  for (const { key, limit } of keys) {
    await prisma.$executeRaw`
      INSERT INTO "login_throttles" ("key", "failures", "windowStartedAt", "lockedUntil", "updatedAt")
      VALUES (${key}, 1, ${now}, ${limit <= 1 ? lockedUntil : null}, ${now})
      ON CONFLICT ("key") DO UPDATE SET
        "failures" = CASE
          WHEN "login_throttles"."windowStartedAt" < ${windowStart} THEN 1
          ELSE "login_throttles"."failures" + 1
        END,
        "windowStartedAt" = CASE
          WHEN "login_throttles"."windowStartedAt" < ${windowStart} THEN ${now}
          ELSE "login_throttles"."windowStartedAt"
        END,
        "lockedUntil" = CASE
          WHEN "login_throttles"."windowStartedAt" >= ${windowStart}
            AND "login_throttles"."failures" + 1 >= ${limit}
          THEN ${lockedUntil}
          ELSE "login_throttles"."lockedUntil"
        END,
        "updatedAt" = ${now}
    `
  }
}

/** Tras un login exitoso se limpia el contador del correo (no el de la IP). */
export async function clearFailures(key: ThrottleKey): Promise<void> {
  await prisma.loginThrottle.deleteMany({ where: { key: key.key } })
}

/**
 * IP del cliente según el proxy de la plataforma (Vercel fija
 * x-forwarded-for). Fuera de un proxy de confianza este header es
 * falsificable: por eso el límite por correo es el control principal.
 */
export function clientIpFrom(headers: Headers | undefined): string {
  const forwarded = headers?.get("x-forwarded-for")?.split(",")[0]?.trim()
  return forwarded || headers?.get("x-real-ip")?.trim() || "unknown"
}
