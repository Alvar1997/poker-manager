import { vi } from "vitest"

import { resolveTestDatabaseUrl } from "./test-db"

const url = resolveTestDatabaseUrl()
process.env.DATABASE_URL = url
process.env.DIRECT_URL = url
process.env.AUTH_SECRET ||= "integration-secret-at-least-32-characters"
process.env.AUTH_URL ||= "http://localhost:3000"
process.env.LOG_LEVEL ||= "silent"

vi.mock("server-only", () => ({}))

/**
 * Sustituye solo la lectura de la cookie de Auth.js: cada prueba decide
 * qué sesión (id + sessionVersion del JWT) trae la request.
 */
vi.mock("@/lib/auth", () => ({
  auth: async () => globalThis.__testSession ?? null,
}))

declare global {
  var __testSession:
    | {
        user: {
          id: string
          role: string
          isActive: boolean
          sessionVersion: number
        }
      }
    | null
    | undefined
}
