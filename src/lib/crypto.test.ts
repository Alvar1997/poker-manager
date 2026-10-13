import { beforeEach, describe, expect, it } from "vitest"

import { decryptSecret, encryptSecret } from "@/lib/crypto"
import { __resetEnvCacheForTests } from "@/lib/env"
import { BusinessRuleError } from "@/lib/errors"

describe("cifrado de datos bancarios (AES-256-GCM)", () => {
  beforeEach(() => {
    process.env.SETTINGS_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64")
    __resetEnvCacheForTests()
  })

  it("cifra sin dejar el texto en claro y descifra el original", () => {
    const encrypted = encryptSecret("002010077777777771")
    expect(encrypted).not.toContain("002010077777777771")
    expect(encrypted.startsWith("v1.")).toBe(true)
    expect(decryptSecret(encrypted)).toBe("002010077777777771")
  })

  it("dos cifrados del mismo valor son distintos (IV aleatorio)", () => {
    expect(encryptSecret("1234")).not.toBe(encryptSecret("1234"))
  })

  it("detecta manipulación del texto cifrado", () => {
    const parts = encryptSecret("1234567890").split(".")
    parts[3] = Buffer.from("otro").toString("base64url")
    expect(() => decryptSecret(parts.join("."))).toThrow()
  })

  it("sin clave configurada se niega a guardar datos bancarios", () => {
    delete process.env.SETTINGS_ENCRYPTION_KEY
    __resetEnvCacheForTests()
    expect(() => encryptSecret("1234")).toThrow(BusinessRuleError)
  })
})
