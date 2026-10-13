import { describe, expect, it } from "vitest"

import {
  changePasswordSchema,
  newPasswordSchema,
  updateProfileSchema,
} from "@/modules/auth/auth.schemas"
import {
  createUserSchema,
  updateUserSchema,
  userStatusSchema,
} from "@/modules/users/user.schemas"

describe("protección contra campos no autorizados en el body", () => {
  it.each([
    { name: "Ana", role: "SUPERADMIN" },
    { name: "Ana", isActive: true },
    { name: "Ana", email: "otro@example.com" },
    { name: "Ana", passwordHash: "x" },
  ])("perfil propio rechaza %o", (body) => {
    expect(updateProfileSchema.safeParse(body).success).toBe(false)
  })

  it("perfil propio acepta solo el nombre", () => {
    expect(updateProfileSchema.parse({ name: "  Ana  " })).toEqual({
      name: "Ana",
    })
  })

  it("edición de usuario rechaza passwordHash, sessionVersion e isActive", () => {
    for (const extra of [
      { passwordHash: "x" },
      { sessionVersion: 0 },
      { isActive: false },
      { createdById: "abc" },
    ]) {
      expect(
        updateUserSchema.safeParse({ name: "Ana", ...extra }).success
      ).toBe(false)
    }
  })

  it("edición de usuario exige al menos un campo", () => {
    expect(updateUserSchema.safeParse({}).success).toBe(false)
  })

  it("alta rechaza roles inexistentes y campos extra", () => {
    const base = { name: "Ana", email: "ana@example.com", role: "CASHIER" }
    expect(createUserSchema.safeParse(base).success).toBe(true)
    expect(createUserSchema.safeParse({ ...base, role: "ROOT" }).success).toBe(
      false
    )
    expect(
      createUserSchema.safeParse({ ...base, password: "elegida-por-mi-1" })
        .success
    ).toBe(false)
  })

  it("normaliza el correo a minúsculas", () => {
    expect(
      createUserSchema.parse({
        name: "Ana",
        email: " Ana@Example.COM ",
        role: "PARTNER",
      }).email
    ).toBe("ana@example.com")
  })

  it("status solo acepta booleano", () => {
    expect(userStatusSchema.safeParse({ isActive: "false" }).success).toBe(
      false
    )
    expect(userStatusSchema.safeParse({ isActive: false }).success).toBe(true)
  })
})

describe("política de contraseñas", () => {
  it("exige mínimo 12 caracteres con letras y números", () => {
    expect(newPasswordSchema.safeParse("corta1").success).toBe(false)
    expect(newPasswordSchema.safeParse("solamenteletras").success).toBe(false)
    expect(newPasswordSchema.safeParse("123456789012").success).toBe(false)
    expect(newPasswordSchema.safeParse("una-clave-segura-9").success).toBe(true)
  })

  it("rechaza contraseñas de más de 72 bytes (límite de bcrypt)", () => {
    expect(newPasswordSchema.safeParse(`a1${"x".repeat(71)}`).success).toBe(
      false
    )
  })

  it("el cambio exige confirmación igual y contraseña distinta a la actual", () => {
    expect(
      changePasswordSchema.safeParse({
        currentPassword: "actual-clave-1",
        newPassword: "nueva-clave-12",
        confirmPassword: "otra-clave-123",
      }).success
    ).toBe(false)
    expect(
      changePasswordSchema.safeParse({
        currentPassword: "misma-clave-12",
        newPassword: "misma-clave-12",
        confirmPassword: "misma-clave-12",
      }).success
    ).toBe(false)
    expect(
      changePasswordSchema.safeParse({
        currentPassword: "actual-clave-1",
        newPassword: "nueva-clave-12",
        confirmPassword: "nueva-clave-12",
      }).success
    ).toBe(true)
  })
})
