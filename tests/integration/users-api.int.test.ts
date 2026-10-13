import { beforeEach, describe, expect, it } from "vitest"

import * as userByIdRoute from "@/app/api/users/[id]/route"
import * as resetPasswordRoute from "@/app/api/users/[id]/reset-password/route"
import * as statusRoute from "@/app/api/users/[id]/status/route"
import * as usersRoute from "@/app/api/users/route"
import * as meRoute from "@/app/api/auth/me/route"
import * as profileRoute from "@/app/api/auth/profile/route"
import { BusinessRuleError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import { authenticateWithCredentials } from "@/modules/auth/auth.service"
import { setUserStatus, updateUser } from "@/modules/users/user.service"

import {
  auditRows,
  call,
  createUser,
  resetDatabase,
  signInAs,
  signOut,
  TEST_PASSWORD,
} from "./helpers"

const newUserBody = {
  name: "Nuevo Cajero",
  email: "Nuevo.Cajero@Example.test",
  role: "CASHIER",
}

beforeEach(resetDatabase)

describe("POST /api/users", () => {
  it("SUPERADMIN puede crear usuarios (credencial temporal, auditoría, sin passwordHash)", async () => {
    const admin = await createUser({ role: "SUPERADMIN" })
    signInAs(admin)

    const res = await call(usersRoute.POST, {
      method: "POST",
      body: newUserBody,
      headers: { "x-request-id": "req-create-1" },
    })

    expect(res.status).toBe(201)
    const data = res.json.data as {
      user: Record<string, unknown>
      temporaryPassword: string
    }
    expect(data.user).toMatchObject({
      email: "nuevo.cajero@example.test",
      role: "CASHIER",
      isActive: true,
      mustChangePassword: true,
      createdBy: { id: admin.id, name: admin.name },
    })
    expect(data.user).not.toHaveProperty("passwordHash")
    expect(data.user).not.toHaveProperty("sessionVersion")
    expect(res.text).not.toMatch(/passwordHash|\$2[aby]\$/)
    expect(data.temporaryPassword).toMatch(/^[\w]{5}(-[\w]{5}){3}$/)

    const stored = await prisma.user.findUniqueOrThrow({
      where: { email: "nuevo.cajero@example.test" },
    })
    expect(stored.passwordHash).not.toBe(data.temporaryPassword)
    expect(stored.createdById).toBe(admin.id)

    const [audit] = await auditRows("USER_CREATED")
    expect(audit).toMatchObject({
      actorUserId: admin.id,
      entityId: stored.id,
      requestId: "req-create-1",
      result: "SUCCESS",
    })
    expect(JSON.stringify(audit.metadata)).not.toContain(data.temporaryPassword)
  })

  it.each(["PARTNER", "CASHIER"] as const)(
    "%s no puede crear usuarios (403 + auditoría de acceso denegado)",
    async (role) => {
      const actor = await createUser({ role })
      signInAs(actor)

      const res = await call(usersRoute.POST, {
        method: "POST",
        body: newUserBody,
      })

      expect(res.status).toBe(403)
      expect(res.json.error?.code).toBe("FORBIDDEN")
      expect(await prisma.user.count()).toBe(1)
      const [denied] = await auditRows("AUTH_ACCESS_DENIED")
      expect(denied).toMatchObject({
        actorUserId: actor.id,
        result: "DENIED",
        entityId: "users:create",
      })
    }
  )

  it("usuario sin sesión recibe 401", async () => {
    signOut()
    const res = await call(usersRoute.POST, {
      method: "POST",
      body: newUserBody,
    })
    expect(res.status).toBe(401)
    expect(res.json.error?.code).toBe("UNAUTHORIZED")
  })

  it("una sesión de un SUPERADMIN ya desactivado recibe 401", async () => {
    const admin = await createUser({ role: "SUPERADMIN" })
    signInAs(admin)
    await prisma.user.update({
      where: { id: admin.id },
      data: { isActive: false },
    })

    const res = await call(usersRoute.POST, {
      method: "POST",
      body: newUserBody,
    })
    expect(res.status).toBe(401)
  })

  it("rechaza correos duplicados con 409", async () => {
    const admin = await createUser({ role: "SUPERADMIN" })
    await createUser({ email: "nuevo.cajero@example.test" })
    signInAs(admin)

    const res = await call(usersRoute.POST, {
      method: "POST",
      body: newUserBody,
    })
    expect(res.status).toBe(409)
  })

  it("rechaza campos no autorizados en el body (p. ej. passwordHash) con 400", async () => {
    const admin = await createUser({ role: "SUPERADMIN" })
    signInAs(admin)

    const res = await call(usersRoute.POST, {
      method: "POST",
      body: { ...newUserBody, passwordHash: "$2b$12$inyectado" },
    })
    expect(res.status).toBe(400)
    expect(await prisma.user.count()).toBe(1)
  })

  it("rechaza solicitudes de otro origen (CSRF) con 403", async () => {
    const admin = await createUser({ role: "SUPERADMIN" })
    signInAs(admin)

    const res = await call(usersRoute.POST, {
      method: "POST",
      body: newUserBody,
      headers: { origin: "https://evil.example" },
    })
    expect(res.status).toBe(403)
    expect(await prisma.user.count()).toBe(1)
  })
})

describe("GET /api/users y /api/users/:id", () => {
  it("lista con búsqueda y filtros, sin exponer passwordHash", async () => {
    const admin = await createUser({ role: "SUPERADMIN", name: "Admin" })
    await createUser({ role: "PARTNER", name: "Socio Uno" })
    await createUser({ role: "PARTNER", name: "Socio Dos", isActive: false })
    await createUser({ role: "CASHIER", name: "Cajero" })
    signInAs(admin)

    const all = await call(usersRoute.GET, { path: "/api/users" })
    expect(all.status).toBe(200)
    expect(all.json.data).toHaveLength(4)
    expect(all.text).not.toMatch(/passwordHash|sessionVersion|\$2[aby]\$/)

    const partners = await call(usersRoute.GET, {
      path: "/api/users?role=PARTNER&status=active",
    })
    expect(partners.json.data).toEqual([
      expect.objectContaining({ name: "Socio Uno" }),
    ])

    const search = await call(usersRoute.GET, { path: "/api/users?q=cAjEr" })
    expect(search.json.data).toEqual([
      expect.objectContaining({ name: "Cajero" }),
    ])

    const invalid = await call(usersRoute.GET, { path: "/api/users?role=ROOT" })
    expect(invalid.status).toBe(400)
  })

  it("el detalle tampoco expone passwordHash; PARTNER recibe 403", async () => {
    const admin = await createUser({ role: "SUPERADMIN" })
    const partner = await createUser({ role: "PARTNER" })
    signInAs(admin)

    const detail = await call(userByIdRoute.GET, {
      params: { id: partner.id },
    })
    expect(detail.status).toBe(200)
    expect(detail.text).not.toMatch(/passwordHash|\$2[aby]\$/)

    signInAs(partner)
    const denied = await call(userByIdRoute.GET, { params: { id: admin.id } })
    expect(denied.status).toBe(403)
  })

  it("404 para un id inexistente", async () => {
    const admin = await createUser({ role: "SUPERADMIN" })
    signInAs(admin)
    const res = await call(userByIdRoute.GET, { params: { id: "noexiste" } })
    expect(res.status).toBe(404)
  })
})

describe("PATCH /api/users/:id — roles y escalada de privilegios", () => {
  it("SUPERADMIN cambia el rol de otro usuario: se audita e invalida sus sesiones", async () => {
    const admin = await createUser({ role: "SUPERADMIN" })
    const cashier = await createUser({ role: "CASHIER" })
    signInAs(admin)

    const res = await call(userByIdRoute.PATCH, {
      method: "PATCH",
      params: { id: cashier.id },
      body: { role: "PARTNER", name: "Cajero Ascendido" },
    })
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({
      role: "PARTNER",
      name: "Cajero Ascendido",
    })

    const [roleAudit] = await auditRows("USER_ROLE_CHANGED")
    expect(roleAudit.metadata).toMatchObject({ from: "CASHIER", to: "PARTNER" })
    expect(await auditRows("USER_UPDATED")).toHaveLength(1)

    // La cookie emitida antes del cambio ya no sirve.
    signInAs(cashier)
    const me = await call(meRoute.GET)
    expect(me.status).toBe(401)
  })

  it("nadie puede cambiar su propio rol (ni siquiera SUPERADMIN)", async () => {
    const admin = await createUser({ role: "SUPERADMIN" })
    await createUser({ role: "SUPERADMIN" })
    signInAs(admin)

    const res = await call(userByIdRoute.PATCH, {
      method: "PATCH",
      params: { id: admin.id },
      body: { role: "CASHIER" },
    })
    expect(res.status).toBe(403)
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).role
    ).toBe("SUPERADMIN")
  })

  it("PARTNER no puede autoasignarse SUPERADMIN manipulando el body", async () => {
    const partner = await createUser({ role: "PARTNER" })
    signInAs(partner)

    const res = await call(userByIdRoute.PATCH, {
      method: "PATCH",
      params: { id: partner.id },
      body: { role: "SUPERADMIN" },
    })
    expect(res.status).toBe(403)
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: partner.id } })).role
    ).toBe("PARTNER")
  })

  it("CASHIER no puede elevar su rol vía /api/auth/profile (campo no permitido → 400)", async () => {
    const cashier = await createUser({ role: "CASHIER" })
    signInAs(cashier)

    const res = await call(profileRoute.PATCH, {
      method: "PATCH",
      body: { name: "Cajero", role: "SUPERADMIN", isActive: true },
    })
    expect(res.status).toBe(400)
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: cashier.id } })).role
    ).toBe("CASHIER")
  })

  it("una cookie que dice SUPERADMIN no sirve si en la base el usuario es CASHIER", async () => {
    const cashier = await createUser({ role: "CASHIER" })
    signInAs({ ...cashier, role: "SUPERADMIN" })

    const res = await call(usersRoute.GET, { path: "/api/users" })
    expect(res.status).toBe(403)
  })

  it("PATCH no permite cambiar isActive ni campos internos", async () => {
    const admin = await createUser({ role: "SUPERADMIN" })
    const cashier = await createUser({ role: "CASHIER" })
    signInAs(admin)

    for (const body of [
      { isActive: false },
      { sessionVersion: 99 },
      { lastLoginAt: null },
    ]) {
      const res = await call(userByIdRoute.PATCH, {
        method: "PATCH",
        params: { id: cashier.id },
        body,
      })
      expect(res.status).toBe(400)
    }
  })
})

describe("PATCH /api/users/:id/status — activación y último SUPERADMIN", () => {
  it("desactivar bloquea el acceso: invalida la sesión abierta y el login", async () => {
    const admin = await createUser({ role: "SUPERADMIN" })
    const cashier = await createUser({
      role: "CASHIER",
      email: "caja@example.test",
    })
    signInAs(admin)

    const res = await call(statusRoute.PATCH, {
      method: "PATCH",
      params: { id: cashier.id },
      body: { isActive: false },
    })
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ isActive: false })
    expect(await auditRows("USER_DEACTIVATED")).toHaveLength(1)

    signInAs(cashier)
    expect((await call(meRoute.GET)).status).toBe(401)

    const login = await authenticateWithCredentials({
      email: "caja@example.test",
      password: TEST_PASSWORD,
    })
    expect(login).toEqual({ ok: false, reason: "invalid" })

    // Reactivar no borra historial y vuelve a permitir el acceso.
    signInAs(admin)
    const reactivate = await call(statusRoute.PATCH, {
      method: "PATCH",
      params: { id: cashier.id },
      body: { isActive: true },
    })
    expect(reactivate.status).toBe(200)
    expect(await auditRows("USER_ACTIVATED")).toHaveLength(1)
  })

  it("un SUPERADMIN no puede desactivarse a sí mismo (el último queda protegido)", async () => {
    const admin = await createUser({ role: "SUPERADMIN" })
    signInAs(admin)

    const res = await call(statusRoute.PATCH, {
      method: "PATCH",
      params: { id: admin.id },
      body: { isActive: false },
    })
    expect(res.status).toBe(422)
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: admin.id } }))
        .isActive
    ).toBe(true)
  })

  it("el servicio impide desactivar o degradar al último SUPERADMIN activo", async () => {
    const onlyAdmin = await createUser({ role: "SUPERADMIN" })
    const otherActor = {
      id: "otro-actor",
      name: "Otro",
      email: "otro@example.test",
      role: "SUPERADMIN" as const,
      isActive: true,
      mustChangePassword: false,
      sessionVersion: 0,
    }

    await expect(
      setUserStatus(otherActor, onlyAdmin.id, false)
    ).rejects.toBeInstanceOf(BusinessRuleError)
    await expect(
      updateUser(otherActor, onlyAdmin.id, { role: "PARTNER" })
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it("dos SUPERADMIN desactivándose mutuamente a la vez nunca dejan el sistema sin SUPERADMIN", async () => {
    const a = await createUser({ role: "SUPERADMIN" })
    const b = await createUser({ role: "SUPERADMIN" })
    const asActor = (u: typeof a) => ({ ...u, role: "SUPERADMIN" as const })

    const results = await Promise.allSettled([
      setUserStatus(asActor(a), b.id, false),
      setUserStatus(asActor(b), a.id, false),
    ])

    expect(results.some((r) => r.status === "rejected")).toBe(true)
    expect(
      await prisma.user.count({ where: { role: "SUPERADMIN", isActive: true } })
    ).toBeGreaterThanOrEqual(1)
  })

  it("PARTNER y CASHIER no pueden desactivar cuentas", async () => {
    const admin = await createUser({ role: "SUPERADMIN" })
    for (const role of ["PARTNER", "CASHIER"] as const) {
      const actor = await createUser({ role })
      signInAs(actor)
      const res = await call(statusRoute.PATCH, {
        method: "PATCH",
        params: { id: admin.id },
        body: { isActive: false },
      })
      expect(res.status).toBe(403)
    }
  })

  it("no existe endpoint de borrado físico de usuarios", () => {
    expect("DELETE" in userByIdRoute).toBe(false)
    expect("DELETE" in usersRoute).toBe(false)
  })
})

describe("POST /api/users/:id/reset-password", () => {
  it("genera credencial temporal, invalida sesiones y obliga a cambiarla", async () => {
    const admin = await createUser({ role: "SUPERADMIN" })
    const partner = await createUser({
      role: "PARTNER",
      email: "socio@example.test",
    })
    signInAs(admin)

    const res = await call(resetPasswordRoute.POST, {
      method: "POST",
      params: { id: partner.id },
    })
    expect(res.status).toBe(200)
    const { temporaryPassword } = res.json.data as { temporaryPassword: string }
    expect(res.text).not.toMatch(/passwordHash|\$2[aby]\$/)

    const [audit] = await auditRows("USER_PASSWORD_RESET")
    expect(JSON.stringify(audit.metadata)).not.toContain(temporaryPassword)

    // Sesión previa del socio: revocada.
    signInAs(partner)
    expect((await call(meRoute.GET)).status).toBe(401)

    // La contraseña anterior ya no funciona; la temporal sí.
    expect(
      await authenticateWithCredentials({
        email: "socio@example.test",
        password: TEST_PASSWORD,
      })
    ).toMatchObject({ ok: false })
    const login = await authenticateWithCredentials({
      email: "socio@example.test",
      password: temporaryPassword,
    })
    expect(login.ok).toBe(true)

    // Con credencial temporal solo puede ver su perfil, no operar.
    const fresh = await prisma.user.findUniqueOrThrow({
      where: { id: partner.id },
    })
    signInAs(fresh)
    expect((await call(meRoute.GET)).status).toBe(200)
    expect((await call(meRoute.GET)).json.data).toMatchObject({
      permissions: [],
    })
  })

  it("SUPERADMIN no puede restablecer su propia contraseña por esta vía", async () => {
    const admin = await createUser({ role: "SUPERADMIN" })
    signInAs(admin)
    const res = await call(resetPasswordRoute.POST, {
      method: "POST",
      params: { id: admin.id },
    })
    expect(res.status).toBe(422)
  })

  it("PARTNER no puede restablecer contraseñas de otros", async () => {
    const partner = await createUser({ role: "PARTNER" })
    const cashier = await createUser({ role: "CASHIER" })
    signInAs(partner)
    const res = await call(resetPasswordRoute.POST, {
      method: "POST",
      params: { id: cashier.id },
    })
    expect(res.status).toBe(403)
  })
})

describe("auditoría inmutable", () => {
  it("la base rechaza modificar o borrar registros de audit_logs", async () => {
    const admin = await createUser({ role: "SUPERADMIN" })
    signInAs(admin)
    await call(usersRoute.POST, { method: "POST", body: newUserBody })
    const [row] = await auditRows("USER_CREATED")

    await expect(
      prisma.auditLog.update({ where: { id: row.id }, data: { action: "X" } })
    ).rejects.toThrow()
    await expect(
      prisma.auditLog.delete({ where: { id: row.id } })
    ).rejects.toThrow()
  })
})
