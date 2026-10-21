import { NextRequest } from "next/server"

import type { Role } from "@/config/permission-matrix"
import { hashPassword } from "@/lib/password"
import { prisma } from "@/lib/prisma"
import { seedFinancialAccounts } from "@/modules/cash/cash.seed"
import { seedChipContainers } from "@/modules/inventory/inventory.seed"
import { seedConfiguration } from "@/modules/settings/configuration.seed"

import { ALL_TABLES } from "./tables"

export const TEST_PASSWORD = "clave-de-prueba-123"

let passwordHashCache: string | undefined

/**
 * Vacía la base de pruebas y vuelve a sembrar la configuración inicial
 * (Módulo 02), igual que una instalación nueva tras `npm run db:seed`.
 */
export async function resetDatabase() {
  // TRUNCATE no dispara el trigger de inmutabilidad de audit_logs (es de
  // fila): solo se usa en bases de prueba.
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${ALL_TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`
  )
  await seedConfiguration(prisma)
  await seedChipContainers(prisma)
  await seedFinancialAccounts(prisma)
  globalThis.__testSession = null
}

let counter = 0

export async function createUser(
  overrides: Partial<{
    name: string
    email: string
    role: Role
    isActive: boolean
    mustChangePassword: boolean
  }> = {}
) {
  passwordHashCache ??= await hashPassword(TEST_PASSWORD)
  counter += 1
  return prisma.user.create({
    data: {
      name: overrides.name ?? `Usuario ${counter}`,
      email: overrides.email ?? `user${counter}@example.test`,
      role: overrides.role ?? "CASHIER",
      isActive: overrides.isActive ?? true,
      mustChangePassword: overrides.mustChangePassword ?? false,
      passwordHash: passwordHashCache,
    },
  })
}

/** Simula la cookie de sesión de `user` (tal como estaba al emitirse el JWT). */
export function signInAs(user: {
  id: string
  role: string
  isActive: boolean
  sessionVersion: number
}) {
  globalThis.__testSession = {
    user: {
      id: user.id,
      role: user.role,
      isActive: user.isActive,
      sessionVersion: user.sessionVersion,
    },
  }
}

export function signOut() {
  globalThis.__testSession = null
}

type Handler<P> = (
  req: NextRequest,
  ctx: { params: Promise<P> }
) => Promise<Response>

export async function call<P = Record<string, string>>(
  handler: Handler<P>,
  options: {
    method?: string
    path?: string
    body?: unknown
    params?: P
    headers?: Record<string, string>
  } = {}
) {
  const req = new NextRequest(
    `http://localhost:3000${options.path ?? "/api/test"}`,
    {
      method: options.method ?? "GET",
      headers: {
        host: "localhost:3000",
        ...(options.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
        ...options.headers,
      },
      body:
        options.body !== undefined ? JSON.stringify(options.body) : undefined,
    }
  )
  const response = await handler(req, {
    params: Promise.resolve((options.params ?? {}) as P),
  })
  const text = await response.text()
  return {
    status: response.status,
    text,
    json: JSON.parse(text) as {
      success: boolean
      data?: unknown
      error?: { code: string; message: string }
    },
  }
}

let phoneCounter = 0

/**
 * Teléfono SINTÉTICO de prueba (+52 871 000 xxxx). Solo existe en la base
 * de pruebas y nunca se envía a ningún servicio.
 */
export function testPhone(): string {
  phoneCounter += 1
  return `+52871000${String(1000 + phoneCounter).slice(-4)}`
}

/** Factory de jugador para pruebas (nunca en seeds). */
export async function createTestPlayer(
  overrides: Partial<{
    name: string
    nickname: string | null
    phone: string
    isActive: boolean
  }> = {}
) {
  return prisma.player.create({
    data: {
      name: overrides.name ?? `Jugador ${phoneCounter + 1}`,
      nickname: overrides.nickname ?? null,
      phone: overrides.phone ?? testPhone(),
      countryCode: "MX",
      isActive: overrides.isActive ?? true,
    },
  })
}

export function auditRows(action?: string) {
  return prisma.auditLog.findMany({
    where: action ? { action } : undefined,
    orderBy: { createdAt: "asc" },
  })
}
