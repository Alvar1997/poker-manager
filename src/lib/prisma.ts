import "@/lib/pg-deprecation-filter"

import { PrismaPg } from "@prisma/adapter-pg"

import { PrismaClient } from "@/generated/prisma/client"
import { getEnv } from "@/lib/env"

/**
 * Instancia reutilizable de Prisma Client.
 *
 * - Usa el driver adapter de `pg` (requerido por Prisma 7 + Neon).
 * - Se cachea en `globalThis` para no crear una conexión nueva en cada
 *   Hot Reload de `next dev`.
 * - La construcción real (y por tanto la validación de env + apertura del
 *   pool de conexiones) es perezosa: ocurre en el primer acceso a una
 *   propiedad de `prisma`, no al importar este módulo. Así `next build`
 *   no falla si todavía no hay credenciales de Neon configuradas.
 */

type PrismaClientType = PrismaClient

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClientType
}

function createPrismaClient(): PrismaClientType {
  const env = getEnv()
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL })

  return new PrismaClient({
    adapter,
    log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  })
}

function getOrCreatePrismaClient(): PrismaClientType {
  if (!globalForPrisma.prisma) {
    const client = createPrismaClient()
    if (getEnv().NODE_ENV !== "production") {
      globalForPrisma.prisma = client
    }
    return client
  }
  return globalForPrisma.prisma
}

let lazyClient: PrismaClientType | undefined

/**
 * Proxy perezoso: se comporta como un PrismaClient normal
 * (`prisma.user.findMany()`), pero no construye el cliente real hasta el
 * primer acceso.
 */
export const prisma: PrismaClientType = new Proxy({} as PrismaClientType, {
  get(_target, prop, receiver) {
    if (!lazyClient) {
      lazyClient = getOrCreatePrismaClient()
    }
    return Reflect.get(lazyClient as object, prop, receiver)
  },
})
