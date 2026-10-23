import { randomUUID } from "node:crypto"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import * as countByIdRoute from "@/app/api/chip-inventory/counts/[id]/route"
import * as cashReconciliationsRoute from "@/app/api/cash-box/reconciliations/route"
import * as cancelRoute from "@/app/api/sessions/[id]/cancel/route"
import * as openRoute from "@/app/api/sessions/[id]/open/route"
import * as checklistRoute from "@/app/api/sessions/[id]/opening-checklist/route"
import * as prepareRoute from "@/app/api/sessions/[id]/prepare/route"
import * as sessionByIdRoute from "@/app/api/sessions/[id]/route"
import * as sessionsRoute from "@/app/api/sessions/route"
import { Prisma } from "@/generated/prisma/client"
import { businessDateOf } from "@/lib/format"
import { prisma } from "@/lib/prisma"
import { formatSessionFolio } from "@/modules/sessions/session-folio"
import { registerStockEntry } from "@/modules/inventory/inventory.service"
import {
  confirmNominalChipDelivery,
  confirmNominalChipReturn,
  reserveNominalAmount,
} from "@/modules/inventory/reservation.service"
import {
  confirmStockCount,
  getStockCount,
  initializeStock,
  reconcileStockCount,
  updateStockCount,
} from "@/modules/inventory/stock-count.service"
import {
  confirmOpeningCashCount,
  createOpeningChipCount,
  getOpeningChecklist,
  openSession,
} from "@/modules/sessions/opening.service"
import {
  cancelSession,
  createSession,
  getActiveSession,
  getStatusHistory,
  prepareSession,
} from "@/modules/sessions/session.service"

import {
  auditRows,
  call,
  createUser,
  resetDatabase,
  signInAs,
  signOut,
} from "./helpers"

type Role = "SUPERADMIN" | "PARTNER" | "CASHIER"
type Actor = Awaited<ReturnType<typeof actorFor>>

async function actorFor(
  role: Role = "CASHIER",
  extra: { mustChangePassword?: boolean } = {}
) {
  const u = await createUser({ role, ...extra })
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role,
    isActive: true,
    mustChangePassword: false,
    sessionVersion: 0,
    _user: u,
  }
}

const key = () => randomUUID()
let shared: { id: string }
let den: Record<string, string>
let cashier: Actor

beforeEach(async () => {
  await resetDatabase()
  shared = await prisma.chipSet.findUniqueOrThrow({
    where: { code: "CHIPSET_MAIN" },
  })
  den = {}
  for (const value of ["25", "100", "500"]) {
    den[value] = (
      await prisma.chipDenomination.create({
        data: { chipSetId: shared.id, value },
      })
    ).id
  }
  cashier = await actorFor("CASHIER")
  // $2,500 + $5,000 + $5,000 = $12,500 de inventario inicial.
  await initializeStock(cashier, {
    chipSetId: shared.id,
    lines: [
      { denominationId: den["25"], quantity: 100 },
      { denominationId: den["100"], quantity: 50 },
      { denominationId: den["500"], quantity: 10 },
    ],
    idempotencyKey: key(),
  })
})

afterEach(() => {
  vi.useRealTimers()
})

const newSession = (actor: Actor = cashier) =>
  createSession(actor, { idempotencyKey: key() })

/** Captura el conteo (por defecto igual a la composición esperada) y confirma. */
async function countChips(
  actor: Actor,
  sessionId: string,
  counted?: Record<string, number>
) {
  const { count } = await createOpeningChipCount(actor, sessionId)
  await updateStockCount(actor, count.id, {
    lines: count.details.map((d) => ({
      denominationId: d.denominationId,
      countedQuantity:
        counted?.[Number(d.unitValue).toString()] ?? d.expectedQuantity,
    })),
  })
  return confirmStockCount(actor, count.id, key())
}

const zeroCash = (actor: Actor, sessionId: string) =>
  confirmOpeningCashCount(actor, sessionId, {
    countedAmount: "0",
    physicallyVerified: true,
  })

async function readyToOpen(actor: Actor = cashier) {
  const s = await newSession(actor)
  await prepareSession(actor, s.id)
  await countChips(actor, s.id)
  await zeroCash(actor, s.id)
  return s
}

describe("creación y sesión vigente única", () => {
  it("crea una sesión DRAFT con folio del sistema y creador del servidor", async () => {
    const s = await newSession()
    expect(s).toMatchObject({
      status: "DRAFT",
      folio: formatSessionFolio(1, businessDateOf(new Date())),
      sequenceNumber: 1,
      businessDate: businessDateOf(new Date()),
      isHistorical: false,
      createdBy: { id: cashier.id },
      openedAt: null,
    })
    expect(await auditRows("SESSION_CREATED")).toHaveLength(1)
    expect(await getStatusHistory(s.id)).toMatchObject([
      { fromStatus: null, toStatus: "DRAFT" },
    ])
  })

  it("dos (o más) creaciones concurrentes producen UNA sola sesión vigente", async () => {
    const actors = await Promise.all([
      actorFor("CASHIER"),
      actorFor("PARTNER"),
      actorFor("SUPERADMIN"),
      actorFor("CASHIER"),
    ])
    const results = await Promise.allSettled(actors.map((a) => newSession(a)))
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const rejected = results.filter(
      (r) => r.status === "rejected"
    ) as PromiseRejectedResult[]
    expect(
      rejected.every((r) => /sesión vigente/.test((r.reason as Error).message))
    ).toBe(true)
    expect(await prisma.pokerSession.count()).toBe(1)
  })

  it("reintentar la creación con la misma clave no duplica", async () => {
    const k = key()
    const [a, b] = await Promise.all([
      createSession(cashier, { idempotencyKey: k }),
      createSession(cashier, { idempotencyKey: k }),
    ])
    expect(a.id).toBe(b.id)
    expect(await prisma.pokerSession.count()).toBe(1)
  })

  it("no se puede crear otra sesión mientras exista una vigente (409 por la API)", async () => {
    await readyToOpen()
    signInAs(cashier._user)
    const res = await call(sessionsRoute.POST, {
      method: "POST",
      body: { idempotencyKey: key() },
    })
    expect(res.status).toBe(409)
    expect(res.json.error?.message).toContain("Ya existe una sesión vigente")
  })

  it("el cliente no puede enviar creador, folio, estado ni fechas", async () => {
    signInAs(cashier._user)
    const other = await actorFor("PARTNER")
    for (const extra of [
      { createdById: other.id },
      { folio: "X" },
      { status: "OPEN" },
      { openedAt: new Date().toISOString() },
    ]) {
      const res = await call(sessionsRoute.POST, {
        method: "POST",
        body: { idempotencyKey: key(), ...extra },
      })
      expect(res.status).toBe(400)
    }
    expect(await prisma.pokerSession.count()).toBe(0)
  })
})

describe("regla del creador", () => {
  it("el creador prepara; otro CASHIER y otro PARTNER reciben 403; SUPERADMIN interviene y se audita", async () => {
    const s = await newSession()
    for (const role of ["CASHIER", "PARTNER"] as const) {
      signInAs((await actorFor(role))._user)
      const res = await call(prepareRoute.POST, {
        method: "POST",
        params: { id: s.id },
      })
      expect(res.status).toBe(403)
      expect(res.json.error?.message).toContain(
        "No tienes permiso para modificar la preparación"
      )
    }
    const admin = await actorFor("SUPERADMIN")
    signInAs(admin._user)
    const ok = await call(prepareRoute.POST, {
      method: "POST",
      params: { id: s.id },
    })
    expect(ok.status).toBe(200)
    expect(ok.json.data).toMatchObject({
      status: "PREPARATION",
      createdBy: { id: cashier.id },
    })
    expect(await auditRows("SESSION_SUPERADMIN_INTERVENTION")).toHaveLength(1)
  })

  it("un PARTNER creador prepara su sesión; otro PARTNER y un CASHIER no", async () => {
    const partner = await actorFor("PARTNER")
    const s = await newSession(partner)
    await prepareSession(partner, s.id)
    await expect(
      createOpeningChipCount(await actorFor("PARTNER"), s.id)
    ).rejects.toThrow(/No tienes permiso/)
    await expect(createOpeningChipCount(cashier, s.id)).rejects.toThrow(
      /No tienes permiso/
    )
    await expect(createOpeningChipCount(partner, s.id)).resolves.toBeTruthy()
  })

  it("no se burla la regla por los endpoints genéricos de arqueos (fichas y efectivo)", async () => {
    const s = await newSession()
    await prepareSession(cashier, s.id)
    const { count } = await createOpeningChipCount(cashier, s.id)
    const intruder = await actorFor("CASHIER")
    signInAs(intruder._user)
    const patch = await call(countByIdRoute.PATCH, {
      method: "PATCH",
      params: { id: count.id },
      body: { lines: [{ denominationId: den["25"], countedQuantity: 1 }] },
    })
    expect(patch.status).toBe(403)
    const cash = await call(cashReconciliationsRoute.POST, {
      method: "POST",
      body: {
        sessionId: s.id,
        reconciliationType: "OPENING",
        countedAmount: "0",
      },
    })
    expect(cash.status).toBe(403)
    // Consultar sí puede (CRE-09).
    const view = await call(sessionByIdRoute.GET, { params: { id: s.id } })
    expect(view.json.data).toMatchObject({ canManagePreparation: false })
  })

  it("si el creador está desactivado, solo SUPERADMIN puede recuperar la preparación", async () => {
    const s = await newSession()
    await prisma.user.update({
      where: { id: cashier.id },
      data: { isActive: false },
    })
    const partner = await actorFor("PARTNER")
    const c = await getOpeningChecklist(s.id, partner)
    expect(c.steps.find((x) => x.id === "USER_AUTHORIZED")?.message).toContain(
      "solo un superadministrador"
    )
    await expect(
      prepareSession(await actorFor("SUPERADMIN"), s.id)
    ).resolves.toMatchObject({ status: "PREPARATION" })
  })
})

describe("controles de apertura", () => {
  it("no abre sin arqueo de fichas", async () => {
    const s = await newSession()
    await prepareSession(cashier, s.id)
    await zeroCash(cashier, s.id)
    await expect(
      openSession(cashier, s.id, { idempotencyKey: key() })
    ).rejects.toThrow(/Falta contar el inventario/)
    signInAs(cashier._user)
    const res = await call(openRoute.POST, {
      method: "POST",
      params: { id: s.id },
      body: { idempotencyKey: key() },
    })
    expect(res.status).toBe(422)
  })

  it("no abre con diferencias sin conciliar; tras conciliar (con motivo) sí", async () => {
    const s = await newSession()
    await prepareSession(cashier, s.id)
    const count = await countChips(cashier, s.id, { "25": 96, "100": 51 }) // total igual, composición distinta
    expect(count).toMatchObject({
      reconciliationStatus: "PENDING",
      differenceTotal: "0.00",
    })
    await zeroCash(cashier, s.id)
    await expect(
      openSession(cashier, s.id, { idempotencyKey: key() })
    ).rejects.toThrow(/diferencias pendientes de conciliar/)
    await reconcileStockCount(cashier, count.id, {
      reason: "Recuento confirmado",
      idempotencyKey: key(),
    })
    const c = await getOpeningChecklist(s.id, cashier)
    expect(c.steps.find((x) => x.id === "INVENTORY_CURRENT")).toMatchObject({
      status: "DONE",
    })
    await expect(
      openSession(cashier, s.id, { idempotencyKey: key() })
    ).resolves.toMatchObject({ session: { status: "OPEN" } })
  })

  it("no abre con caja distinta de $0; el dinero no se convierte en fondo", async () => {
    const s = await newSession()
    await prepareSession(cashier, s.id)
    await countChips(cashier, s.id)
    await expect(
      confirmOpeningCashCount(cashier, s.id, {
        countedAmount: "200",
        physicallyVerified: true,
        explanation: "Billetes olvidados",
      })
    ).resolves.toMatchObject({
      countedAmount: "200.00",
      expectedAmount: "0.00",
    })
    await expect(
      openSession(cashier, s.id, { idempotencyKey: key() })
    ).rejects.toThrow(/Se contaron \$200.00/)
    expect(await prisma.cashTransaction.count()).toBe(0) // ni aportación ni ajuste
    await zeroCash(cashier, s.id)
    await expect(
      openSession(cashier, s.id, { idempotencyKey: key() })
    ).resolves.toBeTruthy()
  })

  it("abre con arqueo válido y caja en cero, con 0 mesas, hora del servidor y sin efectos financieros ni físicos", async () => {
    const s = await readyToOpen()
    const movesBefore = await prisma.chipInventoryMovement.count()
    const nominalBefore = await prisma.chipNominalMovement.count()
    const before = Date.now()
    const { session, replayed } = await openSession(cashier, s.id, {
      idempotencyKey: key(),
    })
    const after = Date.now()
    expect(replayed).toBe(false)
    expect(session).toMatchObject({
      status: "OPEN",
      openedBy: { id: cashier.id },
    })
    const openedAt = new Date(session.openedAt!).getTime()
    expect(openedAt).toBeGreaterThanOrEqual(before - 5)
    expect(openedAt).toBeLessThanOrEqual(after + 5)
    const opening = await prisma.sessionOpening.findUniqueOrThrow({
      where: { sessionId: s.id },
    })
    expect(opening.openingCashAmount.toFixed(2)).toBe("0.00")
    // Sin mesas ni inventarios/cajas por mesa.
    expect(await prisma.chipSet.count({ where: { isActive: true } })).toBe(1)
    expect(await prisma.cashBox.count()).toBe(1)
    // Sin movimientos de fichas ni de dinero, banco intacto.
    expect(await prisma.chipInventoryMovement.count()).toBe(movesBefore)
    expect(await prisma.chipNominalMovement.count()).toBe(nominalBefore)
    expect(await prisma.cashTransaction.count()).toBe(0)
    expect(
      await prisma.financialAccountBalance.count({
        where: { account: { kind: "BANK" } },
      })
    ).toBe(0)
    expect(await auditRows("SESSION_OPENED")).toHaveLength(1)
    expect((await getStatusHistory(s.id)).map((h) => h.toStatus)).toEqual([
      "DRAFT",
      "PREPARATION",
      "OPEN",
    ])
  })

  it("el frontend no puede fijar openedAt; la fecha es inmutable", async () => {
    const s = await readyToOpen()
    signInAs(cashier._user)
    const res = await call(openRoute.POST, {
      method: "POST",
      params: { id: s.id },
      body: { idempotencyKey: key(), openedAt: "2020-01-01T00:00:00.000Z" },
    })
    expect(res.status).toBe(400)
    await openSession(cashier, s.id, { idempotencyKey: key() })
    await expect(
      prisma.pokerSession.update({
        where: { id: s.id },
        data: { openedAt: new Date("2020-01-01") },
      })
    ).rejects.toThrow()
  })

  it("reintentos y confirmaciones concurrentes no duplican la apertura", async () => {
    const s = await readyToOpen()
    const k = key()
    const results = await Promise.all([
      openSession(cashier, s.id, { idempotencyKey: k }),
      openSession(cashier, s.id, { idempotencyKey: k }),
      openSession(cashier, s.id, { idempotencyKey: k }),
    ])
    expect(results.filter((r) => !r.replayed)).toHaveLength(1)
    expect(await prisma.sessionOpening.count()).toBe(1)
    expect(
      (await getStatusHistory(s.id)).filter((h) => h.toStatus === "OPEN")
    ).toHaveLength(1)
    await expect(
      openSession(cashier, s.id, { idempotencyKey: key() })
    ).rejects.toThrow(/ya está abierta/)
  })

  it("no se reabre ni se regresa a preparación", async () => {
    const s = await readyToOpen()
    await openSession(cashier, s.id, { idempotencyKey: key() })
    await expect(prepareSession(cashier, s.id)).rejects.toThrow(
      /no puede pasar/
    )
    await expect(
      prisma.pokerSession.update({
        where: { id: s.id },
        data: { status: "PREPARATION" },
      })
    ).rejects.toThrow()
  })

  it("no usa arqueos obsoletos: un movimiento posterior exige volver a contar", async () => {
    const s = await newSession()
    await prepareSession(cashier, s.id)
    await countChips(cashier, s.id)
    await zeroCash(cashier, s.id)
    await registerStockEntry(cashier, {
      chipSetId: shared.id,
      lines: [{ denominationId: den["25"], quantity: 4 }],
      reason: "Reposición",
      idempotencyKey: key(),
    })
    await expect(
      openSession(cashier, s.id, { idempotencyKey: key() })
    ).rejects.toThrow(/vuelve a contar/)
    const recount = await createOpeningChipCount(cashier, s.id)
    expect(recount.resumed).toBe(false)
    await countChips(cashier, s.id)
    await expect(
      openSession(cashier, s.id, { idempotencyKey: key() })
    ).resolves.toBeTruthy()
  })

  it("un arqueo vigente se reutiliza (no se recuenta) y el arqueo de otra sesión no sirve", async () => {
    const a = await newSession()
    await prepareSession(cashier, a.id)
    const countA = await countChips(cashier, a.id)
    expect((await createOpeningChipCount(cashier, a.id)).count.id).toBe(
      countA.id
    )
    await cancelSession(cashier, a.id, { reason: "Se pospone la sesión" })
    const b = await newSession()
    await prepareSession(cashier, b.id)
    await zeroCash(cashier, b.id)
    const c = await getOpeningChecklist(b.id, cashier)
    expect(c.steps.find((x) => x.id === "CHIPS_COUNTED")).toMatchObject({
      status: "PENDING",
    })
    await expect(
      openSession(cashier, b.id, { idempotencyKey: key() })
    ).rejects.toThrow()
  })

  // Módulo 12 (DEC-20/21/22): las fichas no retornadas de sesiones cerradas
  // quedan EN CIRCULACIÓN de forma global y continua; se informan al abrir
  // pero ya no bloquean (antes del Módulo 12 bloqueaban la apertura).
  it("identifica fichas en circulación de sesiones anteriores sin bloquear ni generar ajustes ficticios", async () => {
    const reservation = await reserveNominalAmount(cashier, {
      amount: "500",
      referenceType: "TEST_PURCHASE",
      referenceId: "anterior",
      expiresAt: new Date(Date.now() + 60_000),
      idempotencyKey: key(),
    })
    await confirmNominalChipDelivery(cashier, reservation.id, key())
    const s = await newSession()
    await prepareSession(cashier, s.id)
    await countChips(cashier, s.id, { "500": 9 }) // físicamente falta la ficha entregada
    await zeroCash(cashier, s.id)
    let c = await getOpeningChecklist(s.id, cashier)
    const step = c.steps.find((x) => x.id === "NO_PENDING_CIRCULATION")
    // El arqueo cuenta solo lo que está bajo custodia: 9 fichas = esperado.
    expect(step).toMatchObject({ status: "DONE" })
    expect(step?.message).toMatch(/en circulación/)
    expect(c.ready).toBe(true)
    const adjustmentsBefore = await prisma.chipInventoryOperation.count({
      where: { type: "INVENTORY_ADJUSTMENT" },
    })
    await confirmNominalChipReturn(cashier, {
      amount: "500",
      referenceType: "TEST_SETTLEMENT",
      referenceId: "anterior",
      idempotencyKey: key(),
    })
    // La devolución movió el inventario: se recuenta (la ficha de $500 regresó).
    await countChips(cashier, s.id, { "500": 10 })
    c = await getOpeningChecklist(s.id, cashier)
    expect(c.ready).toBe(true)
    expect(
      await prisma.chipInventoryOperation.count({
        where: { type: "INVENTORY_ADJUSTMENT" },
      })
    ).toBe(adjustmentsBefore)
  })

  it("la sesión puede cruzar medianoche: misma sesión, fechas en UTC y en hora de Monterrey", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-18T03:00:00.000Z")) // sábado 21:00 en Monterrey
    const s = await readyToOpen()
    vi.setSystemTime(new Date("2026-10-18T07:30:00.000Z")) // domingo 01:30 en Monterrey
    const { session } = await openSession(cashier, s.id, {
      idempotencyKey: key(),
    })
    expect(session.id).toBe(s.id)
    expect(session.openedAt).toBe("2026-10-18T07:30:00.000Z")
    expect(businessDateOf(session.openedAt!)).toBe("2026-10-18")
    expect(await prisma.pokerSession.count()).toBe(1)
    expect((await getActiveSession())?.id).toBe(s.id)
  })
})

describe("cancelación", () => {
  it("cancela con motivo, conserva folio, arqueos y movimientos; el folio no se reutiliza", async () => {
    const s = await newSession()
    await prepareSession(cashier, s.id)
    const count = await countChips(cashier, s.id, { "25": 90 }) // faltante real de $250
    await reconcileStockCount(cashier, count.id, {
      reason: "Faltante real",
      idempotencyKey: key(),
    })
    const adjustments = await prisma.chipNominalMovement.count({
      where: { movementType: "INVENTORY_ADJUSTMENT" },
    })
    signInAs(cashier._user)
    const noReason = await call(cancelRoute.POST, {
      method: "POST",
      params: { id: s.id },
      body: {},
    })
    expect(noReason.status).toBe(400)
    const res = await call(cancelRoute.POST, {
      method: "POST",
      params: { id: s.id },
      body: { reason: "Se suspende la noche" },
    })
    expect(res.json.data).toMatchObject({
      status: "CANCELLED",
      folio: s.folio,
      cancellationReason: "Se suspende la noche",
    })
    expect((await getStockCount(count.id)).status).toBe("CONFIRMED")
    expect(
      await prisma.chipNominalMovement.count({
        where: { movementType: "INVENTORY_ADJUSTMENT" },
      })
    ).toBe(adjustments)
    expect(await auditRows("SESSION_CANCELLED")).toHaveLength(1)
    const next = await newSession()
    expect(next.folio).toMatch(/^S-0002-\d{8}$/)
  })

  it("no cancela con diferencias pendientes, ni sesiones abiertas, ni la de otro usuario", async () => {
    const s = await newSession()
    await prepareSession(cashier, s.id)
    await countChips(cashier, s.id, { "25": 90 })
    await expect(
      cancelSession(cashier, s.id, { reason: "Intento" })
    ).rejects.toThrow(/diferencias sin conciliar/)
    await expect(
      cancelSession(await actorFor("PARTNER"), s.id, { reason: "Ajeno" })
    ).rejects.toThrow(/Solo quien creó/)
    const count = (await getOpeningChecklist(s.id, cashier)).chipCountId!
    await reconcileStockCount(cashier, count, {
      reason: "Ok",
      idempotencyKey: key(),
    })
    await zeroCash(cashier, s.id)
    await openSession(cashier, s.id, { idempotencyKey: key() })
    await expect(
      cancelSession(cashier, s.id, { reason: "Ya abierta" })
    ).rejects.toThrow(/no se cancela/)
  })
})

describe("permisos y consultas", () => {
  it("401 sin sesión y 403 con credencial temporal pendiente", async () => {
    signOut()
    expect((await call(sessionsRoute.GET)).status).toBe(401)
    expect(
      (
        await call(sessionsRoute.POST, {
          method: "POST",
          body: { idempotencyKey: key() },
        })
      ).status
    ).toBe(401)
    signInAs((await actorFor("CASHIER", { mustChangePassword: true }))._user)
    expect((await call(sessionsRoute.GET)).status).toBe(403)
  })

  it("los tres roles crean y consultan; el checklist lo calcula el servidor", async () => {
    const s = await newSession()
    for (const role of ["SUPERADMIN", "PARTNER", "CASHIER"] as const) {
      signInAs((await actorFor(role))._user)
      expect((await call(sessionsRoute.GET)).status).toBe(200)
      const c = await call(checklistRoute.GET, { params: { id: s.id } })
      expect((c.json.data as { steps: unknown[] }).steps).toHaveLength(10)
    }
    const list = await call(sessionsRoute.GET, {
      path: "/api/sessions?q=S-0001",
    })
    expect((list.json.data as { total: number }).total).toBe(1)
  })

  it("la caja inicial confirmada no crea movimientos de $0 ni reinicia saldos", async () => {
    const s = await readyToOpen()
    expect(await prisma.cashTransaction.count()).toBe(0)
    const rec = await prisma.cashReconciliation.findFirstOrThrow({
      where: { sessionId: s.id },
    })
    expect(rec.expectedAmount.equals(new Prisma.Decimal(0))).toBe(true)
    expect(rec.reconciliationType).toBe("OPENING")
  })
})
