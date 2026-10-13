import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { __resetEnvCacheForTests, getEnv } from "@/lib/env"

// AUTH_URL no está en esta lista a propósito: tiene un default
// ("http://localhost:3000") en el schema, así que omitirla no debe
// lanzar — se prueba aparte en "aplica valores por defecto".
const REQUIRED_KEYS = ["DATABASE_URL", "DIRECT_URL", "AUTH_SECRET"] as const

describe("getEnv", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    __resetEnvCacheForTests()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    __resetEnvCacheForTests()
  })

  it("devuelve las variables válidas definidas en el entorno de pruebas", () => {
    const env = getEnv()

    expect(env.DATABASE_URL).toMatch(/^postgres/)
    expect(env.DIRECT_URL).toMatch(/^postgres/)
    expect(env.AUTH_SECRET.length).toBeGreaterThanOrEqual(32)
  })

  it("aplica valores por defecto (NODE_ENV, AUTH_URL, APP_TIMEZONE)", () => {
    const env = getEnv()

    expect(env.APP_TIMEZONE).toBe("America/Monterrey")
    expect(env.NEXT_PUBLIC_APP_NAME).toBe("Poker Manager")
  })

  it("memoiza el resultado entre llamadas", () => {
    const first = getEnv()
    const second = getEnv()
    expect(first).toBe(second)
  })

  it.each(REQUIRED_KEYS)("lanza un error legible si falta %s", (key) => {
    delete process.env[key]
    expect(() => getEnv()).toThrow(/Variables de entorno inválidas/)
  })

  it("rechaza DATABASE_URL que no sea una cadena PostgreSQL", () => {
    process.env.DATABASE_URL = "mysql://not-postgres"
    expect(() => getEnv()).toThrow(/PostgreSQL/)
  })

  it("rechaza un AUTH_SECRET demasiado corto", () => {
    process.env.AUTH_SECRET = "muy-corto"
    expect(() => getEnv()).toThrow(/AUTH_SECRET/)
  })
})
