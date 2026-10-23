/**
 * Seed de Poker Manager. Idempotente: se puede ejecutar cuantas veces se
 * quiera sin duplicar registros.
 *
 * 1. Configuración del Módulo 02 (siempre): negocio, Caja Central MAIN,
 *    mesas 25/25 y 10/10 con su juego físico de fichas, métodos de pago,
 *    cuenta principal sin datos, folios, políticas y WhatsApp pendiente.
 *    Ver src/modules/settings/configuration.seed.ts.
 *    Inventario general de fichas CHIPSET_MAIN (compartido por ambas mesas)
 *    y su ubicación INVENTARIO-GENERAL, sin denominaciones ni cantidades.
 *    Cuentas financieras de la Caja Central (Módulo 05), sin saldos.
 * 2. Bootstrap del primer SUPERADMIN (opcional): solo si se definen las
 *    variables de entorno y no existe ya un SUPERADMIN.
 *
 * Uso:
 *   npm run db:seed                                  # solo configuración
 *   SEED_SUPERADMIN_NAME="Tu Nombre" \
 *   SEED_SUPERADMIN_EMAIL="tu@correo.com" \
 *   SEED_SUPERADMIN_PASSWORD="una-contraseña-fuerte" \
 *   npm run db:seed                                  # + primer SUPERADMIN
 *
 * Garantías del bootstrap:
 * - Si ya existe al menos un SUPERADMIN, no hace nada.
 * - No acepta una contraseña fija/hardcodeada: viene de una variable de
 *   entorno que tú provees al ejecutar el comando.
 * - Nunca imprime la contraseña ni el hash.
 * - Se ejecuta manualmente en un entorno autorizado — no en cada deploy.
 */
import bcrypt from "bcryptjs"

import { PrismaClient } from "@/generated/prisma/client"
import { seedFinancialAccounts } from "@/modules/cash/cash.seed"
import { seedChipContainers } from "@/modules/inventory/inventory.seed"
import { seedConfiguration } from "@/modules/settings/configuration.seed"
import "@/lib/pg-deprecation-filter"
import { PrismaPg } from "@prisma/adapter-pg"

const MIN_PASSWORD_LENGTH = 12

async function bootstrapSuperadmin(prisma: PrismaClient) {
  const name = process.env.SEED_SUPERADMIN_NAME
  const email = process.env.SEED_SUPERADMIN_EMAIL?.trim().toLowerCase()
  const password = process.env.SEED_SUPERADMIN_PASSWORD

  if (!name && !email && !password) {
    console.log(
      "[seed] Sin variables SEED_SUPERADMIN_*: se omite el bootstrap del SUPERADMIN."
    )
    return
  }

  if (!name || !email || !password) {
    console.error(
      "[seed] Para crear el SUPERADMIN define SEED_SUPERADMIN_NAME, " +
        "SEED_SUPERADMIN_EMAIL y SEED_SUPERADMIN_PASSWORD. Ver prisma/seed.ts."
    )
    process.exitCode = 1
    return
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(
      `[seed] SEED_SUPERADMIN_PASSWORD debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`
    )
    process.exitCode = 1
    return
  }

  const existingSuperadmin = await prisma.user.findFirst({
    where: { role: "SUPERADMIN" },
    select: { id: true },
  })

  if (existingSuperadmin) {
    console.log(
      "[seed] Ya existe un SUPERADMIN — no se crea uno nuevo (operación idempotente)."
    )
    return
  }

  const created = await prisma.user.create({
    data: {
      name,
      email,
      passwordHash: await bcrypt.hash(password, 12),
      role: "SUPERADMIN",
      isActive: true,
    },
    select: { id: true, email: true },
  })

  console.log(`[seed] SUPERADMIN creado: ${created.email} (id: ${created.id})`)
}

async function main() {
  const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL
  if (!connectionString) {
    console.error(
      "[seed] Falta DATABASE_URL/DIRECT_URL. Configura .env.local (ver .env.example)."
    )
    process.exitCode = 1
    return
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  })

  try {
    await seedConfiguration(prisma)
    console.log("[seed] Configuración del Módulo 02 verificada (idempotente).")
    await seedChipContainers(prisma)
    console.log(
      "[seed] Inventario general de fichas verificado (una ubicación, sin cantidades)."
    )
    await seedFinancialAccounts(prisma)
    console.log(
      "[seed] Cuentas financieras del Módulo 05 verificadas (sin saldos ni movimientos)."
    )
    await bootstrapSuperadmin(prisma)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error("[seed] Error inesperado:", error)
  process.exitCode = 1
})
