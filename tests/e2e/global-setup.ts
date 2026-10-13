import { randomBytes } from "node:crypto"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

import bcrypt from "bcryptjs"
import { Client } from "pg"

import { resolveTestDatabaseUrl } from "../integration/test-db"

export const E2E_USERS_FILE = path.join(__dirname, ".auth", "users.json")

export type E2EUser = { name: string; email: string; password: string }
export type E2EUsers = Record<
  "superadmin" | "partner" | "cashier" | "inactive",
  E2EUser
>

/**
 * Prepara la base de pruebas para los E2E con sesión real: la vacía y
 * crea un usuario por rol con contraseñas ALEATORIAS generadas en cada
 * corrida (nunca fijas en el código), guardadas solo en
 * tests/e2e/.auth/users.json (ignorado por git).
 *
 * Sin TEST_DATABASE_URL no hace nada: solo corren los smoke tests que no
 * requieren base de datos.
 */
export default async function globalSetup() {
  rmSync(E2E_USERS_FILE, { force: true })
  if (!process.env.TEST_DATABASE_URL) return

  const url = resolveTestDatabaseUrl()
  const { execSync } = await import("node:child_process")
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DIRECT_URL: url },
  })

  // pg directo: el cliente Prisma generado es ESM y el loader de
  // Playwright transpila este archivo a CommonJS.
  const db = new Client({ connectionString: url })
  await db.connect()

  try {
    await db.query(
      'TRUNCATE TABLE "audit_logs", "login_throttles", "users" CASCADE'
    )

    const make = (name: string, email: string): E2EUser => ({
      name,
      email,
      password: `E2e-${randomBytes(12).toString("base64url")}-9`,
    })
    const users: E2EUsers = {
      superadmin: make("Admin E2E", "admin@e2e.test"),
      partner: make("Socio E2E", "socio@e2e.test"),
      cashier: make("Cajero E2E", "cajero@e2e.test"),
      inactive: make("Inactivo E2E", "inactivo@e2e.test"),
    }
    const roles = {
      superadmin: "SUPERADMIN",
      partner: "PARTNER",
      cashier: "CASHIER",
      inactive: "CASHIER",
    } as const

    for (const [key, user] of Object.entries(users) as [
      keyof E2EUsers,
      E2EUser,
    ][]) {
      await db.query(
        `INSERT INTO "users" ("id", "name", "email", "passwordHash", "role", "isActive", "updatedAt")
         VALUES ($1, $2, $3, $4, $5::"Role", $6, NOW())`,
        [
          `e2e${randomBytes(8).toString("hex")}`,
          user.name,
          user.email,
          await bcrypt.hash(user.password, 10),
          roles[key],
          key !== "inactive",
        ]
      )
    }

    mkdirSync(path.dirname(E2E_USERS_FILE), { recursive: true })
    writeFileSync(E2E_USERS_FILE, JSON.stringify(users), { mode: 0o600 })
  } finally {
    await db.end()
  }
}
