import { randomUUID } from "node:crypto"

import { beforeEach, describe, expect, it } from "vitest"

import * as openingTablesRoute from "@/app/api/sessions/[id]/opening/tables/route"
import * as wizardRoute from "@/app/api/sessions/[id]/opening/wizard/route"
import { prisma } from "@/lib/prisma"
import { cashBalanceOf } from "@/modules/cash/ledger"
import {
  confirmStockCount,
  initializeStock,
  updateStockCount,
} from "@/modules/inventory/stock-count.service"
import {
  confirmOpeningCashCount,
  createOpeningChipCount,
  openSession,
} from "@/modules/sessions/opening.service"
import {
  getOpeningWizard,
  planOpeningTable,
  saveOpeningWizardProgress,
  unplanOpeningTable,
} from "@/modules/sessions/opening-wizard.service"
import {
  createSession,
  prepareSession,
} from "@/modules/sessions/session.service"
import {
  getSessionTables,
  openSessionTable,
} from "@/modules/session-tables/session-table.service"

import { auditRows, call, createUser, resetDatabase, signInAs } from "./helpers"

type Role = "SUPERADMIN" | "PARTNER" | "CASHIER"
type Actor = Awaited<ReturnType<typeof actorFor>>

async function actorFor(role: Role = "CASHIER") {
  const u = await createUser({ role })
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
let cashier: Actor
let t25: string
let t10: string

beforeEach(async () => {
  await resetDatabase()
  const shared = await prisma.chipSet.findUniqueOrThrow({
    where: { code: "CHIPSET_MAIN" },
  })
  const d100 = await prisma.chipDenomination.create({
    data: { chipSetId: shared.id, value: "100" },
  })
  const d500 = await prisma.chipDenomination.create({
    data: { chipSetId: shared.id, value: "500" },
  })
  cashier = await actorFor("CASHIER")
  // $5,000 + $5,000 = $10,000 de inventario compartido.
  await initializeStock(cashier, {
    chipSetId: shared.id,
    lines: [
      { denominationId: d100.id, quantity: 50 },
      { denominationId: d500.id, quantity: 10 },
    ],
    idempotencyKey: key(),
  })
  t25 = (
    await prisma.pokerTable.findUniqueOrThrow({
      where: { code: "TABLE_25_25" },
    })
  ).id
  t10 = (
    await prisma.pokerTable.findUniqueOrThrow({
      where: { code: "TABLE_10_10" },
    })
  ).id
})

async function prepared(actor: Actor = cashier) {
  const s = await createSession(actor, { idempotencyKey: key() })
  await prepareSession(actor, s.id)
  return s
}

async function countChips(actor: Actor, sessionId: string) {
  const { count } = await createOpeningChipCount(actor, sessionId)
  await updateStockCount(actor, count.id, {
    lines: count.details.map((d) => ({
      denominationId: d.denominationId,
      countedQuantity: d.expectedQuantity,
    })),
  })
  return confirmStockCount(actor, count.id, key())
}

const zeroCash = (actor: Actor, sessionId: string) =>
  confirmOpeningCashCount(actor, sessionId, {
    countedAmount: "0",
    physicallyVerified: true,
  })

const statuses = async (sessionId: string, actor: Actor = cashier) =>
  (await getOpeningWizard(sessionId, actor)).steps.map((s) => s.status)

const codes = async (sessionId: string, step: number, actor = cashier) =>
  (await getOpeningWizard(sessionId, actor)).steps[step - 1].tasks.map(
    (t) => t.code
  )

describe("asistente de apertura (4 pasos)", () => {
  it("A: apertura normal con mesas 10/10 y 25/25: OPEN, inventario único y caja $0", async () => {
    const s = await createSession(cashier, { idempotencyKey: key() })
    // Borrador: el paso 1 pide guardar la jornada en preparación.
    expect(await codes(s.id, 1)).toEqual(["PREPARATION_NOT_STARTED"])
    await prepareSession(cashier, s.id)
    expect((await statuses(s.id))[0]).toBe("COMPLETED")

    await countChips(cashier, s.id)
    expect((await statuses(s.id))[1]).toBe("COMPLETED")
    const nominal = await prisma.chipSetInventoryState.findFirstOrThrow({
      select: { custodyNominal: true },
    })

    await planOpeningTable(cashier, s.id, t10)
    await planOpeningTable(cashier, s.id, t25)
    // Doble clic: no se duplica.
    const again = await planOpeningTable(cashier, s.id, t25)
    expect(again.replayed).toBe(true)
    await zeroCash(cashier, s.id)

    const w = await getOpeningWizard(s.id, cashier)
    expect(w.steps.map((x) => x.status)).toEqual([
      "COMPLETED",
      "COMPLETED",
      "COMPLETED",
      "PENDING",
    ])
    // Nunca 100% antes de abrir.
    expect(w.progress).toEqual({ done: 3, total: 4 })
    expect(w.canOpen).toBe(true)
    expect(w.tables.planned.map((t) => t.code).sort()).toEqual([
      "TABLE_10_10",
      "TABLE_25_25",
    ])

    const { session } = await openSession(cashier, s.id, {
      idempotencyKey: key(),
      previewHash: w.previewHash,
    })
    expect(session.status).toBe("OPEN")
    const tables = await getSessionTables(s.id)
    expect(tables.filter((t) => t.status === "OPEN")).toHaveLength(2)
    expect(await prisma.sessionTableCycle.count()).toBe(2)
    expect(await prisma.chipSet.count({ where: { isActive: true } })).toBe(1)
    expect(await prisma.cashBox.count()).toBe(1)
    expect((await cashBalanceOf(prisma, s.id)).balance.toFixed(2)).toBe("0.00")
    expect(await prisma.cashTransaction.count()).toBe(0)
    // Abrir mesas no mueve fichas (CASO I).
    const after = await prisma.chipSetInventoryState.findFirstOrThrow({
      select: { custodyNominal: true },
    })
    expect(after.custodyNominal.toFixed(2)).toBe(
      nominal.custodyNominal.toFixed(2)
    )
    const [opened] = await auditRows("SESSION_OPENED")
    expect(opened.metadata).toMatchObject({ openTables: 2 })
    expect(await auditRows("SESSION_OPENING_TABLE_PLANNED")).toHaveLength(2)
    // El 4.º paso solo se completa al abrir.
    expect(await statuses(s.id)).toEqual([
      "COMPLETED",
      "COMPLETED",
      "COMPLETED",
      "COMPLETED",
    ])
  })

  it("B: apertura sin mesas («continuar sin mesas» es informativo)", async () => {
    const s = await prepared()
    await countChips(cashier, s.id)
    await zeroCash(cashier, s.id)
    let w = await getOpeningWizard(s.id, cashier)
    expect(w.steps[2].status).toBe("PENDING")
    expect(w.steps[2].tasks).toMatchObject([
      { code: "NO_TABLES", severity: "INFO" },
    ])
    // Cero mesas no bloquea: ya se puede abrir.
    expect(w.canOpen).toBe(true)
    await saveOpeningWizardProgress(cashier, s.id, { noTables: true })
    w = await getOpeningWizard(s.id, cashier)
    expect(w.steps[2].status).toBe("COMPLETED")
    expect(w.tables.noTablesConfirmed).toBe(true)
    await openSession(cashier, s.id, {
      idempotencyKey: key(),
      previewHash: w.previewHash,
    })
    expect(await prisma.sessionTableCycle.count()).toBe(0)
    expect(
      (await prisma.pokerSession.findUniqueOrThrow({ where: { id: s.id } }))
        .status
    ).toBe("OPEN")
  })

  it("C: sin conteo confirmado bloquea con mensaje claro y RESOLVER al arqueo", async () => {
    const s = await prepared()
    await zeroCash(cashier, s.id)
    let w = await getOpeningWizard(s.id, cashier)
    expect(w.steps[1].status).toBe("BLOCKED")
    expect(w.steps[1].tasks[0]).toMatchObject({
      code: "CHIP_COUNT_MISSING",
      severity: "BLOCKING",
      title:
        "Falta contar el inventario físico de fichas para abrir esta jornada.",
      href: `/dashboard/sesiones/${s.id}/arqueo-fichas`,
      actionLabel: "CONTAR FICHAS",
    })
    expect(w.canOpen).toBe(false)
    expect(w.blockers.map((b) => b.step)).toEqual([2])

    // Conteo capturado pero sin confirmar: CONFIRMAR CONTEO.
    const { count } = await createOpeningChipCount(cashier, s.id)
    await updateStockCount(cashier, count.id, {
      lines: count.details.map((d) => ({
        denominationId: d.denominationId,
        countedQuantity: d.expectedQuantity,
      })),
    })
    w = await getOpeningWizard(s.id, cashier)
    expect(w.steps[1].tasks[0]).toMatchObject({
      code: "CHIP_COUNT_UNCONFIRMED",
      title:
        "Falta confirmar el conteo físico inicial de fichas para abrir esta jornada.",
      actionLabel: "CONFIRMAR CONTEO",
    })
    await expect(
      openSession(cashier, s.id, { idempotencyKey: key() })
    ).rejects.toThrow(/arqueo de fichas/)
  })

  it("D: guarda y recupera paso, observación, conteo en borrador y mesas sin duplicar", async () => {
    const s = await prepared()
    await saveOpeningWizardProgress(cashier, s.id, {
      currentStep: 3,
      notes: "Torneo de aniversario",
    })
    await planOpeningTable(cashier, s.id, t25)
    // Conteo parcial (borrador).
    const { count } = await createOpeningChipCount(cashier, s.id)
    await updateStockCount(cashier, count.id, {
      lines: [
        {
          denominationId: count.details[0].denominationId,
          countedQuantity: count.details[0].expectedQuantity,
        },
      ],
    })
    // «Regresa»: todo se recalcula desde la base.
    const w = await getOpeningWizard(s.id, cashier)
    expect(w.currentStep).toBe(3)
    expect(w.session.notes).toBe("Torneo de aniversario")
    expect(w.tables.planned.map((t) => t.code)).toEqual(["TABLE_25_25"])
    expect(w.steps[1].tasks[0].code).toBe("CHIP_COUNT_INCOMPLETE")
    // Retomar el conteo no crea otro.
    const resumed = await createOpeningChipCount(cashier, s.id)
    expect(resumed.resumed).toBe(true)
    expect(resumed.count.id).toBe(count.id)
    expect(
      await prisma.chipStockCount.count({ where: { sessionId: s.id } })
    ).toBe(1)
    // Quitar y volver a agregar deja historial, no duplica la vigente.
    await unplanOpeningTable(cashier, s.id, t25)
    await planOpeningTable(cashier, s.id, t25)
    expect(
      await prisma.sessionOpeningTable.count({
        where: { sessionId: s.id, removedAt: null },
      })
    ).toBe(1)
    expect(
      await prisma.sessionOpeningTable.count({ where: { sessionId: s.id } })
    ).toBe(2)
    await expect(
      prisma.sessionOpeningTable.deleteMany({ where: { sessionId: s.id } })
    ).rejects.toThrow(/no se borra/)
  })

  it("E: un PARTNER no continúa la preparación de otro; SUPERADMIN sí (auditado)", async () => {
    const partnerA = await actorFor("PARTNER")
    const partnerB = await actorFor("PARTNER")
    const admin = await actorFor("SUPERADMIN")
    const s = await prepared(partnerA)
    await expect(planOpeningTable(partnerB, s.id, t10)).rejects.toThrow(
      /solo quien la creó/
    )
    await expect(
      saveOpeningWizardProgress(partnerB, s.id, { currentStep: 2 })
    ).rejects.toThrow(/solo quien la creó/)
    // Por la API: 403.
    signInAs(partnerB._user)
    const res = await call(openingTablesRoute.POST, {
      method: "POST",
      params: { id: s.id },
      body: { tableId: t10 },
    })
    expect(res.status).toBe(403)
    const patch = await call(wizardRoute.PATCH, {
      method: "PATCH",
      params: { id: s.id },
      body: { currentStep: 2 },
    })
    expect(patch.status).toBe(403)
    // El asistente se puede consultar, pero no abrir.
    const w = await getOpeningWizard(s.id, partnerB)
    expect(w.session.canManagePreparation).toBe(false)
    expect(w.steps[3].tasks.map((t) => t.code)).toContain(
      "OPENING_NOT_AUTHORIZED"
    )
    expect(w.canOpen).toBe(false)

    await planOpeningTable(admin, s.id, t10)
    const [row] = await auditRows("SESSION_OPENING_TABLE_PLANNED")
    expect(row.metadata).toMatchObject({ intervention: true })
    await countChips(admin, s.id)
    await zeroCash(admin, s.id)
    const ready = await getOpeningWizard(s.id, admin)
    expect(ready.canOpen).toBe(true)
    await openSession(admin, s.id, {
      idempotencyKey: key(),
      previewHash: ready.previewHash,
    })
  })

  it("F: la caja central inicia en $0 sin arrastre de la jornada anterior", async () => {
    const s = await prepared()
    await countChips(cashier, s.id)
    // Hay efectivo físico: no se convierte en fondo y bloquea.
    await confirmOpeningCashCount(cashier, s.id, {
      countedAmount: "1500",
      physicallyVerified: true,
      explanation: "Sobrante del día anterior",
    })
    let w = await getOpeningWizard(s.id, cashier)
    expect(w.steps[3].tasks[0]).toMatchObject({
      code: "CASH_NOT_ZERO",
      severity: "BLOCKING",
    })
    expect(w.canOpen).toBe(false)
    await zeroCash(cashier, s.id)
    w = await getOpeningWizard(s.id, cashier)
    expect(w.canOpen).toBe(true)
    expect(w.cash.openingAmount).toBe("0.00")
    await openSession(cashier, s.id, {
      idempotencyKey: key(),
      previewHash: w.previewHash,
    })
    expect((await cashBalanceOf(prisma, s.id)).balance.toFixed(2)).toBe("0.00")
    const opening = await prisma.sessionOpening.findUniqueOrThrow({
      where: { sessionId: s.id },
    })
    expect(opening.openingCashAmount.toFixed(2)).toBe("0.00")
  })

  it("G: dos confirmaciones simultáneas → una sola apertura y un ciclo por mesa", async () => {
    const s = await prepared()
    await countChips(cashier, s.id)
    await planOpeningTable(cashier, s.id, t10)
    await zeroCash(cashier, s.id)
    const w = await getOpeningWizard(s.id, cashier)
    const k = key()
    const results = await Promise.allSettled([
      openSession(cashier, s.id, {
        idempotencyKey: k,
        previewHash: w.previewHash,
      }),
      openSession(cashier, s.id, {
        idempotencyKey: k,
        previewHash: w.previewHash,
      }),
      openSession(cashier, s.id, {
        idempotencyKey: k,
        previewHash: w.previewHash,
      }),
    ])
    expect(results.every((r) => r.status === "fulfilled")).toBe(true)
    expect(
      results.filter((r) => r.status === "fulfilled" && !r.value.replayed)
    ).toHaveLength(1)
    expect(await prisma.sessionOpening.count()).toBe(1)
    expect(await prisma.sessionTableCycle.count()).toBe(1)
    expect(await auditRows("SESSION_OPENED")).toHaveLength(1)
    // Otra solicitud (otra clave) ya no abre de nuevo.
    await expect(
      openSession(cashier, s.id, { idempotencyKey: key() })
    ).rejects.toThrow(/ya está abierta/)
  })

  it("estado obsoleto: si cambian las mesas tras revisar, la apertura responde 409", async () => {
    const s = await prepared()
    await countChips(cashier, s.id)
    await planOpeningTable(cashier, s.id, t10)
    await zeroCash(cashier, s.id)
    const w = await getOpeningWizard(s.id, cashier)
    await unplanOpeningTable(cashier, s.id, t10)
    await expect(
      openSession(cashier, s.id, {
        idempotencyKey: key(),
        previewHash: w.previewHash,
      })
    ).rejects.toMatchObject({ status: 409 })
    // Una mesa con configuración incompleta impide abrir.
    await planOpeningTable(cashier, s.id, t25)
    await prisma.pokerTable.update({
      where: { id: t25 },
      data: { isActive: false },
    })
    const blocked = await getOpeningWizard(s.id, cashier)
    expect(blocked.steps[2]).toMatchObject({ status: "BLOCKED" })
    expect(blocked.steps[2].tasks[0]).toMatchObject({
      code: "TABLE_CONFIG_INCOMPLETE",
      actionLabel: "CONFIGURAR MESA",
    })
    await expect(
      openSession(cashier, s.id, { idempotencyKey: key() })
    ).rejects.toThrow(/desactivada/)
    // Quitarla de la preparación lo resuelve.
    await unplanOpeningTable(cashier, s.id, t25)
    expect((await getOpeningWizard(s.id, cashier)).canOpen).toBe(true)
  })

  it("H: sesión abierta sin mesas admite agregar la 25/25 después conservando su apertura", async () => {
    const s = await prepared()
    await countChips(cashier, s.id)
    await zeroCash(cashier, s.id)
    const { session } = await openSession(cashier, s.id, {
      idempotencyKey: key(),
    })
    await openSessionTable(cashier, s.id, t25, { idempotencyKey: key() })
    const after = await prisma.pokerSession.findUniqueOrThrow({
      where: { id: s.id },
    })
    expect(after.openedAt?.toISOString()).toBe(session.openedAt)
    expect(
      (await getSessionTables(s.id)).find((t) => t.tableId === t25)?.status
    ).toBe("OPEN")
    // El plan ya no se edita con la jornada abierta (servicio y base).
    await expect(planOpeningTable(cashier, s.id, t10)).rejects.toThrow(
      /ya no está en preparación/
    )
    await expect(
      prisma.sessionOpeningTable.create({
        data: { sessionId: s.id, tableId: t10, addedById: cashier.id },
      })
    ).rejects.toThrow(/en preparación/)
  })

  it("I: preparar mesas no duplica ni descuenta fichas, ni toca la caja", async () => {
    const s = await prepared()
    await countChips(cashier, s.id)
    const before = {
      moves: await prisma.chipInventoryMovement.count(),
      nominal: await prisma.chipNominalMovement.count(),
      cash: await prisma.cashTransaction.count(),
    }
    await planOpeningTable(cashier, s.id, t10)
    await planOpeningTable(cashier, s.id, t25)
    await unplanOpeningTable(cashier, s.id, t10)
    expect(await prisma.chipInventoryMovement.count()).toBe(before.moves)
    expect(await prisma.chipNominalMovement.count()).toBe(before.nominal)
    expect(await prisma.cashTransaction.count()).toBe(before.cash)
    expect(await prisma.sessionTable.count()).toBe(0)
    // El conteo sigue vigente: agregar mesas no lo invalida.
    expect((await getOpeningWizard(s.id, cashier)).steps[1].status).toBe(
      "COMPLETED"
    )
  })
})
