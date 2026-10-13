/**
 * Bootstrap del primer usuario SUPERADMIN.
 *
 * Uso:
 *   SEED_SUPERADMIN_NAME="Tu Nombre" \
 *   SEED_SUPERADMIN_EMAIL="tu@correo.com" \
 *   SEED_SUPERADMIN_PASSWORD="una-contraseña-fuerte" \
 *   npm run db:seed
 *
 * Garantías:
 * - Idempotente: si ya existe al menos un SUPERADMIN, no hace nada
 *   (no crea uno nuevo, no falla, no modifica el existente).
 * - No acepta una contraseña fija/hardcodeada: siempre viene de una
 *   variable de entorno que tú provees al ejecutar el comando, nunca
 *   almacenada en el repositorio.
 * - Nunca imprime la contraseña ni el hash en logs/consola.
 * - Pensado para ejecutarse manualmente en un entorno autorizado
 *   (tu máquina o un `migrate deploy` job controlado) — no se ejecuta
 *   automáticamente en cada deploy.
 */
import bcrypt from "bcryptjs"

import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

const MIN_PASSWORD_LENGTH = 12

async function main() {
  const name = process.env.SEED_SUPERADMIN_NAME
  const email = process.env.SEED_SUPERADMIN_EMAIL?.trim().toLowerCase()
  const password = process.env.SEED_SUPERADMIN_PASSWORD

  if (!name || !email || !password) {
    console.error(
      "[seed] Faltan variables de entorno. Define SEED_SUPERADMIN_NAME, " +
        "SEED_SUPERADMIN_EMAIL y SEED_SUPERADMIN_PASSWORD antes de ejecutar " +
        "`npm run db:seed`. Ver el encabezado de prisma/seed.ts."
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
    const existingSuperadmin = await prisma.user.findFirst({
      where: { role: "SUPERADMIN" },
      select: { id: true, email: true },
    })

    if (existingSuperadmin) {
      console.log(
        "[seed] Ya existe un SUPERADMIN — no se crea uno nuevo (operación idempotente)."
      )
      return
    }

    const passwordHash = await bcrypt.hash(password, 12)

    const created = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash,
        role: "SUPERADMIN",
        isActive: true,
      },
      select: { id: true, email: true },
    })

    console.log(
      `[seed] SUPERADMIN creado: ${created.email} (id: ${created.id})`
    )
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error("[seed] Error inesperado:", error)
  process.exitCode = 1
})
