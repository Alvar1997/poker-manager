import { beforeEach, describe, expect, it } from "vitest"

import * as auditRoute from "@/app/api/players/[id]/audit/route"
import * as consentRoute from "@/app/api/players/[id]/notification-consent/route"
import * as phoneHistoryRoute from "@/app/api/players/[id]/phone-history/route"
import * as playerByIdRoute from "@/app/api/players/[id]/route"
import * as statusRoute from "@/app/api/players/[id]/status/route"
import * as playersRoute from "@/app/api/players/route"
import { prisma } from "@/lib/prisma"
import { WHATSAPP_CONSENT_NOTICE_VERSION } from "@/modules/players/consent-notice"

import {
  auditRows,
  call,
  createTestPlayer,
  createUser,
  resetDatabase,
  signInAs,
  signOut,
} from "./helpers"

beforeEach(resetDatabase)

async function asRole(role: "SUPERADMIN" | "PARTNER" | "CASHIER") {
  const user = await createUser({ role })
  signInAs(user)
  return user
}

type PlayerData = {
  id: string
  phone: string
  isActive: boolean
  whatsappConsent: { granted: boolean; staleBecausePhoneChanged: boolean }
}

const grant = {
  action: "GRANTED",
  noticeVersion: WHATSAPP_CONSENT_NOTICE_VERSION,
  source: "IN_PERSON",
  confirmedByPlayer: true,
}

async function create(body: Record<string, unknown>) {
  return call(playersRoute.POST, { method: "POST", body })
}

describe("alta de jugadores", () => {
  it.each(["SUPERADMIN", "PARTNER", "CASHIER"] as const)(
    "%s puede registrar jugadores (teléfono normalizado E.164, activo, sin consentimiento)",
    async (role) => {
      const actor = await asRole(role)
      const res = await create({
        name: "  Juan   Pérez ",
        phone: "871 000 5001",
      })

      expect(res.status).toBe(201)
      expect(res.json.data).toMatchObject({
        name: "Juan Pérez",
        nickname: null,
        phone: "+528710005001",
        phoneDisplay: "+52 871 000 5001",
        countryCode: "MX",
        isActive: true,
        whatsappConsent: { granted: false, lastAction: null },
        createdBy: { id: actor.id },
      })
      const [audit] = await auditRows("PLAYER_CREATED")
      expect(audit).toMatchObject({ actorUserId: actor.id, result: "SUCCESS" })
      expect(JSON.stringify(audit.metadata)).not.toContain("8710005001")
      expect(await prisma.playerNotificationConsent.count()).toBe(0)
    }
  )

  it("no antepone +52 cuando ya hay prefijo internacional, y acepta números extranjeros", async () => {
    await asRole("CASHIER")
    const mx = await create({ name: "Con prefijo", phone: "+52 871 000 5002" })
    expect((mx.json.data as PlayerData).phone).toBe("+528710005002")

    const us = await create({ name: "Visitante", phone: "+1 202 555 0123" })
    expect(us.json.data).toMatchObject({
      phone: "+12025550123",
      countryCode: "US",
    })

    const es = await create({
      name: "España",
      phone: "612 345 678",
      phoneCountry: "ES",
    })
    expect(es.json.data).toMatchObject({
      phone: "+34612345678",
      countryCode: "ES",
    })
  })

  it.each([
    [{ name: "Sin teléfono" }, "phone"],
    [{ name: "Vacío", phone: "  " }, "phone"],
    [{ name: "Inválido", phone: "12345" }, "phone"],
    [{ phone: "871 000 5003" }, "name"],
    [{ name: " ", phone: "871 000 5003" }, "name"],
  ])("rechaza %o (campo %s)", async (body, field) => {
    await asRole("CASHIER")
    const res = await create(body)
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.json.error)).toContain(field)
    expect(await prisma.player.count()).toBe(0)
  })

  it("rechaza campos financieros o internos (deuda, límite, estado, id)", async () => {
    await asRole("SUPERADMIN")
    for (const extra of [
      { creditLimit: "1000" },
      { currentDebt: "0" },
      { isActive: false },
      { id: "x" },
      { createdById: "x" },
    ]) {
      const res = await create({
        name: "Campos",
        phone: "871 000 5004",
        ...extra,
      })
      expect(res.status).toBe(400)
    }
  })

  it("la base de datos impide duplicados aunque el formato sea distinto (409 con referencia)", async () => {
    await asRole("CASHIER")
    const first = await create({ name: "Original", phone: "871 000 5005" })
    const dup = await create({ name: "Copia", phone: "+52 (871) 000-5005" })

    expect(dup.status).toBe(409)
    expect(dup.json.error).toMatchObject({
      code: "CONFLICT",
      details: {
        field: "phone",
        existingPlayer: {
          id: (first.json.data as PlayerData).id,
          name: "Original",
        },
      },
    })
    await expect(
      prisma.player.create({
        data: { name: "Directo", phone: "+528710005005", countryCode: "MX" },
      })
    ).rejects.toThrow()
    expect(await prisma.player.count()).toBe(1)
  })

  it("la creación simultánea con el mismo teléfono produce un único registro", async () => {
    await asRole("CASHIER")
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        create({ name: `Simultáneo ${i}`, phone: "871 000 5006" })
      )
    )
    expect(results.filter((r) => r.status === 201)).toHaveLength(1)
    expect(results.filter((r) => r.status === 409)).toHaveLength(5)
    expect(
      await prisma.player.count({ where: { phone: "+528710005006" } })
    ).toBe(1)
  })

  it("el nombre y el apodo pueden repetirse (no se fusiona por nombre)", async () => {
    await asRole("CASHIER")
    expect(
      (await create({ name: "Pedro", nickname: "Pepe", phone: "871 000 5007" }))
        .status
    ).toBe(201)
    expect(
      (await create({ name: "Pedro", nickname: "Pepe", phone: "871 000 5008" }))
        .status
    ).toBe(201)
  })

  it("registra el consentimiento solo si se marca explícitamente al crear", async () => {
    const actor = await asRole("CASHIER")
    const res = await create({
      name: "Acepta",
      phone: "871 000 5009",
      whatsappConsent: {
        noticeVersion: WHATSAPP_CONSENT_NOTICE_VERSION,
        source: "IN_PERSON",
        confirmedByPlayer: true,
      },
    })
    expect(res.json.data).toMatchObject({
      whatsappConsent: { granted: true, lastAction: "GRANTED" },
    })
    const [record] = await prisma.playerNotificationConsent.findMany()
    expect(record).toMatchObject({
      action: "GRANTED",
      channel: "WHATSAPP",
      consentType: "TRANSACTIONAL",
      phone: "+528710005009",
      noticeVersion: WHATSAPP_CONSENT_NOTICE_VERSION,
      recordedById: actor.id,
    })

    const noConfirm = await create({
      name: "Sin confirmar",
      phone: "871 000 5010",
      whatsappConsent: {
        noticeVersion: WHATSAPP_CONSENT_NOTICE_VERSION,
        source: "IN_PERSON",
        confirmedByPlayer: false,
      },
    })
    expect(noConfirm.status).toBe(400)
  })
})

describe("autenticación y permisos", () => {
  it("sin sesión → 401 en todos los endpoints", async () => {
    const player = await createTestPlayer()
    signOut()
    const params = { id: player.id }
    for (const res of [
      await call(playersRoute.GET),
      await create({ name: "X", phone: "871 000 5011" }),
      await call(playerByIdRoute.GET, { params }),
      await call(playerByIdRoute.PATCH, {
        method: "PATCH",
        params,
        body: { name: "Y" },
      }),
      await call(statusRoute.PATCH, {
        method: "PATCH",
        params,
        body: { isActive: false },
      }),
      await call(consentRoute.POST, { method: "POST", params, body: grant }),
      await call(auditRoute.GET, { params }),
    ]) {
      expect(res.status).toBe(401)
    }
  })

  it("CASHIER no consulta el historial telefónico (403); sí la auditoría del jugador (Módulo 15, DEC-03)", async () => {
    const player = await createTestPlayer()
    await asRole("CASHIER")
    expect(
      (await call(phoneHistoryRoute.GET, { params: { id: player.id } })).status
    ).toBe(403)
    expect(
      (await call(auditRoute.GET, { params: { id: player.id } })).status
    ).toBe(200)
    expect((await auditRows("AUTH_ACCESS_DENIED")).length).toBe(1)
  })

  it("con credencial temporal pendiente, ningún rol opera jugadores (403)", async () => {
    const user = await createUser({
      role: "SUPERADMIN",
      mustChangePassword: true,
    })
    signInAs(user)
    expect((await create({ name: "X", phone: "871 000 5012" })).status).toBe(
      403
    )
  })
})

describe("búsqueda y paginación", () => {
  beforeEach(async () => {
    await createTestPlayer({
      name: "Ana López",
      nickname: "La Reina",
      phone: "+528710007001",
    })
    await createTestPlayer({
      name: "Bruno Díaz",
      nickname: "Batman",
      phone: "+528710007002",
      isActive: false,
    })
    await createTestPlayer({ name: "Carla Ruiz", phone: "+12025550188" })
    for (let i = 0; i < 22; i++) {
      await createTestPlayer({
        name: `Zeta ${String(i).padStart(2, "0")}`,
        phone: `+52871000${8000 + i}`,
      })
    }
  })

  it("busca por nombre, apodo y teléfono en cualquier formato", async () => {
    await asRole("CASHIER")
    const byName = await call(playersRoute.GET, {
      path: "/api/players?q=lópez",
    })
    expect(
      (byName.json.data as { items: PlayerData[] }).items.map((p) => p.phone)
    ).toEqual(["+528710007001"])

    const byNick = await call(playersRoute.GET, {
      path: "/api/players?q=batman",
    })
    expect((byNick.json.data as { total: number }).total).toBe(1)

    const byPhone = await call(playersRoute.GET, {
      path: `/api/players?q=${encodeURIComponent("871-000-7002")}`,
    })
    expect(
      (byPhone.json.data as { items: { name: string }[] }).items.map(
        (p) => p.name
      )
    ).toEqual(["Bruno Díaz"])

    const byIntl = await call(playersRoute.GET, {
      path: `/api/players?q=${encodeURIComponent("(202) 555 0188")}`,
    })
    expect(
      (byIntl.json.data as { items: { name: string }[] }).items.map(
        (p) => p.name
      )
    ).toEqual(["Carla Ruiz"])
  })

  it("filtra por estado y pagina en servidor", async () => {
    await asRole("PARTNER")
    const inactive = await call(playersRoute.GET, {
      path: "/api/players?status=inactive",
    })
    expect((inactive.json.data as { total: number }).total).toBe(1)

    const page1 = await call(playersRoute.GET, {
      path: "/api/players?pageSize=10&page=1",
    })
    const page3 = await call(playersRoute.GET, {
      path: "/api/players?pageSize=10&page=3",
    })
    const d1 = page1.json.data as {
      items: PlayerData[]
      total: number
      totalPages: number
    }
    const d3 = page3.json.data as { items: PlayerData[] }
    expect(d1).toMatchObject({ total: 25, totalPages: 3 })
    expect(d1.items).toHaveLength(10)
    expect(d3.items).toHaveLength(5)
    expect(d1.items.map((p) => p.id)).not.toEqual(
      expect.arrayContaining([d3.items[0].id])
    )
  })

  it("ordena solo por campos permitidos y limita el tamaño de página", async () => {
    await asRole("CASHIER")
    const desc = await call(playersRoute.GET, {
      path: "/api/players?sort=name&order=desc&pageSize=1",
    })
    expect(
      (desc.json.data as { items: { name: string }[] }).items[0].name
    ).toBe("Zeta 21")
    expect(
      (await call(playersRoute.GET, { path: "/api/players?sort=phone" })).status
    ).toBe(400)
    expect(
      (await call(playersRoute.GET, { path: "/api/players?pageSize=500" }))
        .status
    ).toBe(400)
  })
})

describe("edición e historial telefónico", () => {
  it("el cambio de teléfono registra historial, auditoría enmascarada y responsable", async () => {
    const player = await createTestPlayer({ phone: "+528710006001" })
    const actor = await asRole("CASHIER")

    const res = await call(playerByIdRoute.PATCH, {
      method: "PATCH",
      params: { id: player.id },
      body: {
        phone: "871 000 6002",
        phoneChangeReason: "Cambió de número",
        nickname: "Nuevo",
      },
    })
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({
      phone: "+528710006002",
      nickname: "Nuevo",
      updatedBy: { id: actor.id },
    })

    const [history] = await prisma.playerPhoneHistory.findMany()
    expect(history).toMatchObject({
      previousPhone: "+528710006001",
      newPhone: "+528710006002",
      reason: "Cambió de número",
      changedById: actor.id,
    })
    const [audit] = await auditRows("PLAYER_PHONE_CHANGED")
    expect(audit.actorUserId).toBe(actor.id)
    expect(JSON.stringify(audit.metadata)).not.toMatch(/8710006001|8710006002/)
    expect(await auditRows("PLAYER_UPDATED")).toHaveLength(1)

    // El historial completo solo lo consulta quien tiene auditoría.
    await asRole("PARTNER")
    const hist = await call(phoneHistoryRoute.GET, {
      params: { id: player.id },
    })
    expect(hist.status).toBe(200)
    expect(hist.json.data).toEqual([
      expect.objectContaining({ previousPhone: "+528710006001" }),
    ])
  })

  it("no permite tomar el teléfono de otro jugador y no deja registros a medias", async () => {
    const a = await createTestPlayer({ phone: "+528710006003" })
    const b = await createTestPlayer({ phone: "+528710006004" })
    await asRole("SUPERADMIN")
    const res = await call(playerByIdRoute.PATCH, {
      method: "PATCH",
      params: { id: b.id },
      body: { phone: "871 000 6003" },
    })
    expect(res.status).toBe(409)
    expect(
      (await prisma.player.findUniqueOrThrow({ where: { id: b.id } })).phone
    ).toBe("+528710006004")
    expect(await prisma.playerPhoneHistory.count()).toBe(0)
    void a
  })

  it("no permite editar estado, deudas, fechas ni id por PATCH", async () => {
    const player = await createTestPlayer()
    await asRole("SUPERADMIN")
    for (const body of [
      { isActive: false },
      { currentDebt: "0" },
      { createdAt: "2020-01-01" },
      { id: "x" },
      { creditLimit: null },
    ]) {
      const res = await call(playerByIdRoute.PATCH, {
        method: "PATCH",
        params: { id: player.id },
        body,
      })
      expect(res.status).toBe(400)
    }
  })

  it("las notas se guardan como texto plano y no se registran en la auditoría", async () => {
    const player = await createTestPlayer()
    await asRole("CASHIER")
    const notes = "Prefiere mesa 10/10 <script>alert(1)</script>"
    const res = await call(playerByIdRoute.PATCH, {
      method: "PATCH",
      params: { id: player.id },
      body: { notes },
    })
    expect((res.json.data as { notes: string }).notes).toBe(notes)
    const [audit] = await auditRows("PLAYER_UPDATED")
    expect(audit.metadata).toMatchObject({ notesChanged: true })
    expect(JSON.stringify(audit.metadata)).not.toContain("Prefiere")
  })
})

describe("estado", () => {
  it("desactivar conserva el registro, se audita y permite reactivar", async () => {
    const player = await createTestPlayer()
    const actor = await asRole("CASHIER")

    const off = await call(statusRoute.PATCH, {
      method: "PATCH",
      params: { id: player.id },
      body: { isActive: false, reason: "Ya no asiste" },
    })
    expect(off.json.data).toMatchObject({ isActive: false })
    expect(await prisma.player.count()).toBe(1)

    const on = await call(statusRoute.PATCH, {
      method: "PATCH",
      params: { id: player.id },
      body: { isActive: true },
    })
    expect(on.json.data).toMatchObject({ isActive: true })

    const audits = await auditRows("PLAYER_STATUS_CHANGED")
    expect(audits).toHaveLength(2)
    expect(audits[0]).toMatchObject({ actorUserId: actor.id })
    expect(audits[0].metadata).toMatchObject({
      from: "ACTIVE",
      to: "INACTIVE",
      reason: "Ya no asiste",
    })
  })

  it("no existe borrado físico", () => {
    expect("DELETE" in playerByIdRoute).toBe(false)
    expect("DELETE" in playersRoute).toBe(false)
  })
})

describe("consentimiento WhatsApp", () => {
  it("se registra y se revoca, conservando el historial (solo inserción)", async () => {
    const player = await createTestPlayer()
    const actor = await asRole("CASHIER")

    const granted = await call(consentRoute.POST, {
      method: "POST",
      params: { id: player.id },
      body: grant,
    })
    expect(granted.status).toBe(201)
    expect(granted.json.data).toMatchObject({
      granted: true,
      noticeVersion: WHATSAPP_CONSENT_NOTICE_VERSION,
    })

    const again = await call(consentRoute.POST, {
      method: "POST",
      params: { id: player.id },
      body: grant,
    })
    expect(again.status).toBe(422)

    const revoked = await call(consentRoute.POST, {
      method: "POST",
      params: { id: player.id },
      body: {
        action: "REVOKED",
        source: "IN_PERSON",
        notes: "Lo pidió en caja",
      },
    })
    expect(revoked.json.data).toMatchObject({
      granted: false,
      lastAction: "REVOKED",
    })

    const view = await call(consentRoute.GET, { params: { id: player.id } })
    const data = view.json.data as {
      history: { action: string; recordedBy: { id: string } }[]
      notice: { version: string }
    }
    expect(data.history.map((h) => h.action)).toEqual(["REVOKED", "GRANTED"])
    expect(data.history[0].recordedBy.id).toBe(actor.id)
    expect(data.notice.version).toBe(WHATSAPP_CONSENT_NOTICE_VERSION)
    expect(view.text).not.toContain("8710")

    expect(await auditRows("PLAYER_WHATSAPP_CONSENT_GRANTED")).toHaveLength(1)
    expect(await auditRows("PLAYER_WHATSAPP_CONSENT_REVOKED")).toHaveLength(1)

    const [first] = await prisma.playerNotificationConsent.findMany({ take: 1 })
    await expect(
      prisma.playerNotificationConsent.update({
        where: { id: first.id },
        data: { action: "GRANTED" },
      })
    ).rejects.toThrow()
  })

  it("exige confirmación del jugador y la versión vigente del aviso", async () => {
    const player = await createTestPlayer()
    await asRole("CASHIER")
    for (const body of [
      { ...grant, confirmedByPlayer: false },
      { ...grant, noticeVersion: "2020-01-v0" },
      { action: "GRANTED", source: "IN_PERSON" },
    ]) {
      expect(
        (
          await call(consentRoute.POST, {
            method: "POST",
            params: { id: player.id },
            body,
          })
        ).status
      ).toBe(400)
    }
    expect(await prisma.playerNotificationConsent.count()).toBe(0)
  })

  it("no se puede revocar lo que no está vigente", async () => {
    const player = await createTestPlayer()
    await asRole("CASHIER")
    const res = await call(consentRoute.POST, {
      method: "POST",
      params: { id: player.id },
      body: { action: "REVOKED", source: "IN_PERSON" },
    })
    expect(res.status).toBe(422)
  })

  it("al cambiar de teléfono, el consentimiento anterior deja de estar vigente", async () => {
    const player = await createTestPlayer({ phone: "+528710006101" })
    await asRole("CASHIER")
    await call(consentRoute.POST, {
      method: "POST",
      params: { id: player.id },
      body: grant,
    })
    const res = await call(playerByIdRoute.PATCH, {
      method: "PATCH",
      params: { id: player.id },
      body: { phone: "871 000 6102" },
    })
    expect(res.json.data).toMatchObject({
      whatsappConsent: { granted: false, staleBecausePhoneChanged: true },
    })
  })
})

describe("privacidad y política de crédito", () => {
  it("la auditoría del jugador está sanitizada y es solo para quien tiene auditoría", async () => {
    await asRole("CASHIER")
    const created = await create({ name: "Auditado", phone: "871 000 6201" })
    const id = (created.json.data as PlayerData).id

    await asRole("SUPERADMIN")
    const res = await call(auditRoute.GET, { params: { id } })
    expect(res.status).toBe(200)
    expect(
      (res.json.data as { action: string }[]).map((e) => e.action)
    ).toContain("PLAYER_CREATED")
    expect(res.text).not.toContain("8710006201")
  })

  it("el jugador no tiene columnas de deuda, saldo, compras ni límite de crédito", async () => {
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'players'
    `
    const names = columns.map((c) => c.column_name)
    for (const forbidden of [
      "currentDebt",
      "totalCredit",
      "creditLimit",
      "totalPurchases",
      "currentBalance",
      "email",
      "passwordHash",
      "role",
    ]) {
      expect(names).not.toContain(forbidden)
    }
  })

  it("las respuestas no exponen datos internos de usuarios", async () => {
    await asRole("CASHIER")
    const res = await create({ name: "Limpio", phone: "871 000 6301" })
    expect(res.text).not.toMatch(/passwordHash|sessionVersion|email/)
  })
})
