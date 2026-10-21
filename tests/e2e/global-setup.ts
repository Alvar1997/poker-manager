import { execSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

import bcrypt from "bcryptjs"
import { Client } from "pg"

import { ALL_TABLES } from "../integration/tables"
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
      `TRUNCATE TABLE ${ALL_TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`
    )
    // Configuración inicial del Módulo 02 con el seed real (idempotente).
    execSync("npm run db:seed", {
      stdio: "inherit",
      env: { ...process.env, DIRECT_URL: url, DATABASE_URL: url },
    })

    // Fixtures de PRUEBA (no del seed): denominaciones del inventario
    // ÚNICO compartido por ambas mesas, para ejercitar el inventario.
    for (const [code, values] of [
      ["CHIPSET_MAIN", ["25", "100", "500"]],
    ] as const) {
      for (const [i, value] of values.entries()) {
        await db.query(
          `INSERT INTO "chip_denominations" ("id", "chipSetId", "value", "color", "sortOrder", "isActive", "createdAt", "updatedAt")
           SELECT $1, "id", $2::numeric, $3, $4, true, NOW(), NOW() FROM "chip_sets" WHERE "code" = $5`,
          [
            `e2e${randomBytes(8).toString("hex")}`,
            value,
            ["Verde", "Negra", "Morada"][i],
            i,
            code,
          ]
        )
      }
    }

    // Fixtures de PRUEBA del Módulo 05: transferencias PENDIENTES (sin
    // asiento) sobre la cuenta principal sembrada SIN datos bancarios, una
    // para confirmar y otra para rechazar por proyecto de Playwright. No
    // hay sesión abierta: el efectivo sigue bloqueado.
    for (const [project, action, amount] of [
      ["chromium", "confirmar", "1500.00"],
      ["chromium", "rechazar", "250.00"],
      ["mobile-safari", "confirmar", "1200.00"],
      ["mobile-safari", "rechazar", "300.00"],
    ] as const) {
      const ref = `e2e${randomBytes(8).toString("hex")}`
      await db.query(
        `INSERT INTO "bank_transfer_verifications" ("id", "kind", "paymentAccountId", "declaredAmount", "senderName",
           "creditAccountKind", "referenceType", "referenceId", "idempotencyKey", "updatedAt")
         SELECT $1, 'PLAYER_PAYMENT', "id", $2::numeric, $3, 'PLAYER_PURCHASES', 'E2EFixture', $1, $1, NOW()
         FROM "payment_accounts" WHERE "isPrimary" AND "isActive"`,
        [ref, amount, `E2E ${project} ${action}`]
      )
    }

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
