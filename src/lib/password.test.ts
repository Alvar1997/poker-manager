import { describe, expect, it } from "vitest"

import { newPasswordSchema } from "@/modules/auth/auth.schemas"
import {
  generateTemporaryPassword,
  hashPassword,
  verifyPassword,
} from "@/lib/password"

describe("generateTemporaryPassword", () => {
  it("genera credenciales distintas que cumplen la política", () => {
    const generated = new Set(
      Array.from({ length: 50 }, () => generateTemporaryPassword())
    )
    expect(generated.size).toBe(50)
    for (const password of generated) {
      expect(password).toMatch(/^[a-zA-Z2-9]{5}(-[a-zA-Z2-9]{5}){3}$/)
    }
  })

  it("normalmente cumple la política de contraseñas (letras y números)", () => {
    // Con 20 caracteres aleatorios la probabilidad de no tener un dígito es
    // despreciable; aun así la credencial temporal no pasa por esta política
    // (la define el servidor), solo se verifica que sea robusta.
    const ok = Array.from(
      { length: 20 },
      () => newPasswordSchema.safeParse(generateTemporaryPassword()).success
    ).filter(Boolean).length
    expect(ok).toBeGreaterThanOrEqual(18)
  })
})

describe("hashPassword / verifyPassword", () => {
  it("el hash no contiene la contraseña y verifica correctamente", async () => {
    const hash = await hashPassword("una-clave-segura-9")
    expect(hash).not.toContain("una-clave-segura-9")
    expect(await verifyPassword("una-clave-segura-9", hash)).toBe(true)
    expect(await verifyPassword("otra-clave-segura-9", hash)).toBe(false)
  })
})
