import { beforeEach, describe, expect, it } from "vitest"

import * as changePasswordRoute from "@/app/api/auth/change-password/route"
import * as meRoute from "@/app/api/auth/me/route"
import * as profileRoute from "@/app/api/auth/profile/route"
import { prisma } from "@/lib/prisma"
import {
  authenticateWithCredentials,
  loadSessionUser,
} from "@/modules/auth/auth.service"
import { THROTTLE_LIMITS } from "@/modules/auth/login-throttle"

import {
  auditRows,
  call,
  createUser,
  resetDatabase,
  signInAs,
  signOut,
  TEST_PASSWORD,
} from "./helpers"

beforeEach(resetDatabase)

describe("inicio de sesión (authorize de Auth.js)", () => {
  it("credenciales válidas: ok, actualiza lastLoginAt y audita", async () => {
    const user = await createUser({
      role: "PARTNER",
      email: "socio@example.test",
    })

    const result = await authenticateWithCredentials(
      { email: "SOCIO@example.test", password: TEST_PASSWORD },
      { ip: "10.0.0.1" }
    )

    expect(result).toMatchObject({
      ok: true,
      user: { id: user.id, role: "PARTNER", sessionVersion: 0 },
    })
    expect(JSON.stringify(result)).not.toMatch(/passwordHash|\$2[aby]\$/)
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    })
    expect(stored.lastLoginAt).not.toBeNull()
    expect(await auditRows("AUTH_LOGIN_SUCCEEDED")).toHaveLength(1)
  })

  it("usuario inactivo no inicia sesión aunque la contraseña sea correcta", async () => {
    await createUser({ email: "inactivo@example.test", isActive: false })

    const result = await authenticateWithCredentials({
      email: "inactivo@example.test",
      password: TEST_PASSWORD,
    })
    expect(result).toEqual({ ok: false, reason: "invalid" })
    const [audit] = await auditRows("AUTH_LOGIN_FAILED")
    expect(audit.metadata).toMatchObject({ reason: "inactive" })
  })

  it("misma respuesta genérica para cuenta inexistente y contraseña incorrecta", async () => {
    await createUser({ email: "real@example.test" })

    const unknown = await authenticateWithCredentials({
      email: "nadie@example.test",
      password: TEST_PASSWORD,
    })
    const wrong = await authenticateWithCredentials({
      email: "real@example.test",
      password: "incorrecta-123",
    })
    expect(unknown).toEqual(wrong)
    expect(unknown).toEqual({ ok: false, reason: "invalid" })
  })

  it("bloquea temporalmente tras intentos fallidos repetidos (incluso con la contraseña correcta)", async () => {
    await createUser({ email: "victima@example.test" })

    for (let i = 0; i < THROTTLE_LIMITS.email; i++) {
      await authenticateWithCredentials({
        email: "victima@example.test",
        password: `incorrecta-${i}`,
      })
    }

    const result = await authenticateWithCredentials({
      email: "victima@example.test",
      password: TEST_PASSWORD,
    })
    expect(result).toEqual({ ok: false, reason: "rate_limited" })
    expect(await auditRows("AUTH_LOGIN_RATE_LIMITED")).toHaveLength(1)

    // No se guarda el correo en claro en la tabla del limitador.
    const keys = await prisma.loginThrottle.findMany({ select: { key: true } })
    expect(JSON.stringify(keys)).not.toContain("victima")
  })

  it("el bloqueo aplica igual a correos inexistentes (no permite enumerar cuentas)", async () => {
    for (let i = 0; i < THROTTLE_LIMITS.email; i++) {
      await authenticateWithCredentials({
        email: "fantasma@example.test",
        password: `x-${i}`,
      })
    }
    expect(
      await authenticateWithCredentials({
        email: "fantasma@example.test",
        password: "x",
      })
    ).toEqual({ ok: false, reason: "rate_limited" })
  })

  it("no registra contraseñas en la auditoría", async () => {
    await createUser({ email: "real@example.test" })
    await authenticateWithCredentials({
      email: "real@example.test",
      password: "contraseña-secreta-99",
    })
    const rows = await auditRows()
    expect(JSON.stringify(rows)).not.toContain("contraseña-secreta-99")
  })
})

describe("GET /api/auth/me", () => {
  it("401 sin sesión", async () => {
    signOut()
    expect((await call(meRoute.GET)).status).toBe(401)
  })

  it("devuelve perfil vigente y permisos efectivos, sin passwordHash", async () => {
    const cashier = await createUser({ role: "CASHIER" })
    signInAs(cashier)

    const res = await call(meRoute.GET)
    expect(res.status).toBe(200)
    const data = res.json.data as { user: unknown; permissions: string[] }
    expect(data.user).toMatchObject({ id: cashier.id, role: "CASHIER" })
    expect(data.permissions).toContain("cash:operate")
    expect(data.permissions).not.toContain("users:create")
    // Módulo 14 (DEC-08): CASHIER consulta reportes financieros; Módulo 15
    // (DEC-03): también la auditoría, pero no autoriza correcciones ni
    // recupera producción.
    expect(data.permissions).toContain("reports:financial")
    expect(data.permissions).toContain("audit:read")
    expect(data.permissions).not.toContain("corrections:operate")
    expect(data.permissions).not.toContain("recovery:manage")
    expect(res.text).not.toMatch(/passwordHash|\$2[aby]\$/)
  })
})

describe("PATCH /api/auth/profile", () => {
  it("permite cambiar solo el nombre propio y lo audita", async () => {
    const partner = await createUser({ role: "PARTNER", name: "Socio" })
    signInAs(partner)

    const res = await call(profileRoute.PATCH, {
      method: "PATCH",
      body: { name: "Socio Renombrado" },
    })
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({
      name: "Socio Renombrado",
      role: "PARTNER",
    })
    expect(await auditRows("AUTH_PROFILE_UPDATED")).toHaveLength(1)
  })

  it("rechaza cambiar el correo propio por esta vía", async () => {
    const partner = await createUser({ role: "PARTNER" })
    signInAs(partner)
    const res = await call(profileRoute.PATCH, {
      method: "PATCH",
      body: { name: "Socio", email: "otro@example.test" },
    })
    expect(res.status).toBe(400)
  })
})

describe("POST /api/auth/change-password", () => {
  it("con contraseña actual incorrecta → 400 y no cambia nada", async () => {
    const user = await createUser()
    signInAs(user)

    const res = await call(changePasswordRoute.POST, {
      method: "POST",
      body: {
        currentPassword: "no-es-la-actual-1",
        newPassword: "nueva-clave-segura-1",
        confirmPassword: "nueva-clave-segura-1",
      },
    })
    expect(res.status).toBe(400)
    expect(await auditRows("AUTH_PASSWORD_CHANGE_FAILED")).toHaveLength(1)
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    })
    expect(stored.sessionVersion).toBe(0)
  })

  it("cambia la contraseña e invalida TODAS las sesiones existentes", async () => {
    const user = await createUser({
      email: "cambio@example.test",
      mustChangePassword: true,
    })
    signInAs(user)

    const res = await call(changePasswordRoute.POST, {
      method: "POST",
      body: {
        currentPassword: TEST_PASSWORD,
        newPassword: "nueva-clave-segura-1",
        confirmPassword: "nueva-clave-segura-1",
      },
    })
    expect(res.status).toBe(200)
    expect(res.json.data).toEqual({ reauthenticate: true })

    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    })
    expect(stored.sessionVersion).toBe(1)
    expect(stored.mustChangePassword).toBe(false)
    expect(stored.passwordChangedAt).not.toBeNull()

    // La sesión con la que se hizo el cambio (y cualquier otra) ya no vale.
    expect((await call(meRoute.GET)).status).toBe(401)
    expect(await loadSessionUser(user.id, 0)).toBeNull()
    expect(await loadSessionUser(user.id, 1)).not.toBeNull()

    expect(
      (
        await authenticateWithCredentials({
          email: "cambio@example.test",
          password: TEST_PASSWORD,
        })
      ).ok
    ).toBe(false)
    expect(
      (
        await authenticateWithCredentials({
          email: "cambio@example.test",
          password: "nueva-clave-segura-1",
        })
      ).ok
    ).toBe(true)

    const [audit] = await auditRows("AUTH_PASSWORD_CHANGED")
    expect(JSON.stringify(audit)).not.toContain("nueva-clave-segura-1")
  })

  it("401 sin sesión", async () => {
    signOut()
    const res = await call(changePasswordRoute.POST, {
      method: "POST",
      body: {
        currentPassword: "x",
        newPassword: "nueva-clave-segura-1",
        confirmPassword: "nueva-clave-segura-1",
      },
    })
    expect(res.status).toBe(401)
  })
})
