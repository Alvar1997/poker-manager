import { randomUUID } from "node:crypto"

import ExcelJS from "exceljs"
import { beforeEach, describe, expect, it } from "vitest"

import { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { cashBalanceOf } from "@/modules/cash/ledger"
import { buildClosurePreview } from "@/modules/closure/closure.data"
import {
  confirmClosingChipCount,
  confirmClosure,
  recordClosingCashCount,
  registerFinalWithdrawal,
  startClosing,
  startClosingChipCount,
} from "@/modules/closure/closure.service"
import { receivablesOf } from "@/modules/credits/receivable.service"
import {
  confirmStockCount,
  initializeStock,
  updateStockCount,
} from "@/modules/inventory/stock-count.service"
import {
  confirmDelivery,
  createPurchase,
  getPurchase,
  recordCreditAuthorization,
  recordPayment,
} from "@/modules/purchases/purchase.service"
import { confirmRakeCount, recordRakeEntry } from "@/modules/rake/rake.service"
import { parseReportFilters } from "@/modules/reports/report.filters"
import { listSessionReports } from "@/modules/reports/session-report.service"
import { buildReportXlsx } from "@/modules/reports/xlsx-export.service"
import { addPlayerToTable } from "@/modules/session-tables/participation.service"
import {
  closeSessionTable,
  openSessionTable,
} from "@/modules/session-tables/session-table.service"
import {
  confirmOpeningCashCount,
  createOpeningChipCount,
  openSession,
} from "@/modules/sessions/opening.service"
import {
  getOpeningWizard,
  planOpeningTable,
  saveOpeningWizardProgress,
} from "@/modules/sessions/opening-wizard.service"
import {
  cancelSession,
  createSession,
  getSession,
  prepareSession,
} from "@/modules/sessions/session.service"
import {
  captureSettlementSignature,
  prepareSettlementSignatureSummary,
} from "@/modules/settlements/settlement-signature.service"
import {
  confirmReturn,
  createSettlement,
  getSettlement,
} from "@/modules/settlements/settlement.service"
import {
  captureSignature,
  prepareSignatureSummary,
} from "@/modules/signatures/signature.service"
import { createStaff, listPositions } from "@/modules/staff-tips/staff.service"
import {
  addStaffToSession,
  confirmTipCount,
  reviewSessionTips,
  saveTipCountDraft,
} from "@/modules/staff-tips/tips.service"

import {
  auditRows,
  countPendingRakeAsZero,
  createTestPlayer,
  createUser,
  resetDatabase,
} from "./helpers"

/**
 * Jornada HISTÓRICA completa (SUPERADMIN) con la base de PRUEBAS y los
 * servicios reales de cada módulo: se captura el 24/10/2026 (20:00) después
 * de una jornada posterior ya cerrada; mesas, compras, recompra, crédito con
 * socio y firma, liquidaciones, OUT, rake, propinas, conciliación global,
 * cierre que cruza la medianoche con diferencia y motivo, reportes y XLSX.
 * La jornada posterior no cambia; la caja histórica va de $0 a $0.
 */

type Role = "SUPERADMIN" | "PARTNER" | "CASHIER"
async function actorFor(role: Role) {
  const u = await createUser({ role })
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role,
    isActive: true,
    mustChangePassword: false,
    sessionVersion: 0,
  }
}
type Actor = Awaited<ReturnType<typeof actorFor>>

const key = () => randomUUID()
const D = (v: Prisma.Decimal | string | number) => new Prisma.Decimal(v)
const STROKES: [number, number][][] = [
  Array.from({ length: 40 }, (_, i): [number, number] => [
    100 + i * 20,
    Math.round(200 + 120 * Math.sin(i / 3)),
  ]),
  Array.from({ length: 15 }, (_, i): [number, number] => [150 + i * 50, 360]),
]

let admin: Actor
let cashier: Actor
let partner: Actor
let t25: string
let t10: string
let denominationId: string

beforeEach(async () => {
  await resetDatabase()
  const shared = await prisma.chipSet.findUniqueOrThrow({
    where: { code: "CHIPSET_MAIN" },
  })
  denominationId = (
    await prisma.chipDenomination.create({
      data: { chipSetId: shared.id, value: "25" },
    })
  ).id
  admin = await actorFor("SUPERADMIN")
  cashier = await actorFor("CASHIER")
  partner = await actorFor("PARTNER")
  await initializeStock(cashier, {
    chipSetId: shared.id,
    lines: [{ denominationId, quantity: 6000 }],
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

async function countAndZeroCash(actor: Actor, sessionId: string) {
  const { count } = await createOpeningChipCount(actor, sessionId)
  await updateStockCount(actor, count.id, {
    lines: count.details.map((x) => ({
      denominationId: x.denominationId,
      countedQuantity: x.expectedQuantity,
    })),
  })
  await confirmStockCount(actor, count.id, key())
  await confirmOpeningCashCount(actor, sessionId, {
    countedAmount: "0",
    physicallyVerified: true,
  })
}

async function seat(sessionId: string, tableId: string) {
  const p = await createTestPlayer()
  const { participationId } = await addPlayerToTable(
    cashier,
    sessionId,
    tableId,
    { playerId: p.id, idempotencyKey: key() }
  )
  return { participationId, playerId: p.id }
}

async function cashBuy(participationId: string, amount: string) {
  const { purchaseId } = await createPurchase(cashier, {
    participationId,
    nominalAmount: amount,
    idempotencyKey: key(),
  })
  await recordPayment(cashier, purchaseId, {
    method: "CASH",
    amount,
    cashReceived: true,
    idempotencyKey: key(),
  })
  const v = await getPurchase(purchaseId)
  await confirmDelivery(cashier, purchaseId, {
    expectedVersion: v.version,
    physicalDeliveryConfirmed: true,
    idempotencyKey: key(),
  })
  return purchaseId
}

async function creditBuy(participationId: string, amount: string) {
  const { purchaseId } = await createPurchase(cashier, {
    participationId,
    nominalAmount: amount,
    idempotencyKey: key(),
  })
  await recordCreditAuthorization(cashier, purchaseId, {
    partnerId: partner.id,
    channel: "VERBAL",
    idempotencyKey: key(),
  })
  const prepared = await prepareSignatureSummary(cashier, purchaseId)
  await captureSignature(cashier, purchaseId, {
    snapshotId: prepared.summary.snapshotId,
    payloadHash: prepared.summary.payloadHash,
    strokes: STROKES,
    idempotencyKey: key(),
  })
  const v = await getPurchase(purchaseId)
  await confirmDelivery(cashier, purchaseId, {
    expectedVersion: v.version,
    physicalDeliveryConfirmed: true,
    idempotencyKey: key(),
  })
  return purchaseId
}

/** Liquidación firmada (OUT si `out`); la cuenta por pagar sobrevive. */
async function settle(participationId: string, returned: string, out = false) {
  const { settlementId } = await createSettlement(cashier, {
    participationId,
    returnedNominalAmount: returned,
    offsetDecision: "NO_COMPENSATE",
    ...(out ? { exitKind: "OUT" as const } : {}),
    idempotencyKey: key(),
  })
  const prepared = await prepareSettlementSignatureSummary(
    cashier,
    settlementId
  )
  await captureSettlementSignature(cashier, settlementId, {
    snapshotId: prepared.summary.snapshotId,
    payloadHash: prepared.summary.payloadHash,
    strokes: STROKES,
    idempotencyKey: key(),
  })
  const s = await getSettlement(settlementId)
  await confirmReturn(cashier, settlementId, {
    expectedVersion: s.version,
    ...(Number(returned) > 0
      ? { chipsReceived: true as const }
      : { zeroReturnConfirmed: true as const }),
    idempotencyKey: key(),
  })
}

const cycleOf = (sessionId: string, tableId: string) =>
  prisma.sessionTableCycle.findFirstOrThrow({
    where: { sessionTable: { sessionId, tableId } },
    orderBy: { cycleNumber: "desc" },
  })

/** Arqueo de cierre (contado = custodia esperada), caja y retiro total. */
async function prepareClosing(sessionId: string) {
  await reviewSessionTips(cashier, sessionId)
  await startClosing(cashier, sessionId, { idempotencyKey: key() })
  const { count } = await startClosingChipCount(cashier, sessionId)
  const state = await prisma.chipSetInventoryState.findFirstOrThrow()
  await updateStockCount(cashier, count.id, {
    lines: [
      {
        denominationId,
        countedQuantity: D(state.custodyNominal).div(25).toNumber(),
      },
    ],
  })
  await confirmClosingChipCount(cashier, sessionId, {
    countId: count.id,
    idempotencyKey: key(),
  })
  const balance = (await cashBalanceOf(prisma, sessionId)).balance.toFixed(2)
  await recordClosingCashCount(cashier, sessionId, {
    countedAmount: balance,
    physicallyCounted: true,
  })
  if (D(balance).greaterThan(0))
    await registerFinalWithdrawal(cashier, sessionId, {
      idempotencyKey: key(),
      amount: balance,
      recipientName: "Socio receptor",
      physicallyDelivered: true,
    })
}

/** Jornada NORMAL de hoy, completa y cerrada (posterior a la histórica). */
async function laterClosedSession() {
  const s = await createSession(cashier, { idempotencyKey: key() })
  await prepareSession(cashier, s.id)
  await countAndZeroCash(cashier, s.id)
  await openSession(cashier, s.id, { idempotencyKey: key() })
  await openSessionTable(cashier, s.id, t25, { idempotencyKey: key() })
  const a = await seat(s.id, t25)
  await cashBuy(a.participationId, "10000")
  await settle(a.participationId, "10000")
  await closeSessionTable(cashier, s.id, t25, { idempotencyKey: key() })
  await countPendingRakeAsZero(cashier, s.id)
  await prepareClosing(s.id)
  const p = await buildClosurePreview(prisma, s.id)
  await confirmClosure(cashier, s.id, {
    idempotencyKey: key(),
    previewHash: p.previewHash,
  })
  return s.id
}

async function snapshotOf(sessionId: string) {
  const [session, report, counts, cash] = await Promise.all([
    prisma.pokerSession.findUniqueOrThrow({ where: { id: sessionId } }),
    prisma.closureReport.findFirstOrThrow({ where: { sessionId } }),
    prisma.chipStockCount.findMany({
      where: { sessionId },
      orderBy: { id: "asc" },
    }),
    prisma.financialAccountBalance.findMany({
      where: { scopeKey: sessionId },
      orderBy: { id: "asc" },
    }),
  ])
  return { session, report, counts, cash }
}

const historical = (businessDate: string, openingTime = "20:00") =>
  createSession(admin, {
    idempotencyKey: key(),
    historical: true,
    businessDate,
    openingTime,
  })

describe("jornada histórica del 24/10/2026 (SUPERADMIN)", () => {
  it("se registra y opera COMPLETA aunque exista una jornada posterior, sin alterarla", async () => {
    const laterId = await laterClosedSession()
    const later = await snapshotOf(laterId)

    // 1-2. Creación con fecha y hora operativa (24/10 20:00 Monterrey).
    const h = await historical("2026-10-24")
    expect(h).toMatchObject({
      status: "DRAFT",
      isHistorical: true,
      businessDate: "2026-10-24",
      operatedOpenedAt: "2026-10-25T02:00:00.000Z",
    })
    expect(h.folio).toMatch(/^S-0002-20261024$/)
    // 18. Fecha real de captura ≠ fecha operativa.
    expect(h.createdAt.slice(0, 10)).not.toBe("2026-10-24")

    // 8. Asistente: aviso de jornada posterior y conteo del inventario actual.
    await prepareSession(admin, h.id)
    let wizard = await getOpeningWizard(h.id, admin)
    expect(wizard.session).toMatchObject({ isHistorical: true })
    expect(wizard.steps[0].tasks.map((t) => t.code)).toEqual(
      expect.arrayContaining(["HISTORICAL_SESSION", "LATER_SESSIONS_EXIST"])
    )
    expect(wizard.steps[1].tasks.map((t) => t.code)).toContain(
      "HISTORICAL_COUNT_IS_CURRENT"
    )
    // 26. Persistencia: corrige la hora de apertura (auditado).
    await saveOpeningWizardProgress(admin, h.id, { openingTime: "20:30" })
    expect((await getSession(h.id)).operatedOpenedAt).toBe(
      "2026-10-25T02:30:00.000Z"
    )
    await countAndZeroCash(admin, h.id)
    // 7. Abre con las dos mesas preparadas.
    await planOpeningTable(admin, h.id, t25)
    await planOpeningTable(admin, h.id, t10)
    wizard = await getOpeningWizard(h.id, admin)
    await openSession(admin, h.id, {
      idempotencyKey: key(),
      previewHash: wizard.previewHash,
    })
    expect((await getSession(h.id)).status).toBe("OPEN")

    // 9-14. Noche: compra, recompra, crédito con firma, OUT, liquidaciones,
    // rake por mesa y propinas por empleado (servicios normales).
    const a = await seat(h.id, t25)
    const b = await seat(h.id, t25)
    const c = await seat(h.id, t10)
    await cashBuy(a.participationId, "30000")
    await cashBuy(a.participationId, "10000") // recompra
    await creditBuy(b.participationId, "20000")
    await cashBuy(c.participationId, "20000")
    for (const amount of ["1000", "1500"])
      await recordRakeEntry(cashier, h.id, t10, {
        amount,
        idempotencyKey: key(),
      })
    const positions = await listPositions()
    const staff = await createStaff(cashier, {
      name: "Dealer histórico",
      positionId: positions.find((p) => p.code === "DEALER")!.id,
    })
    const ss = (await addStaffToSession(cashier, h.id, staff.id)).id
    const draft = await saveTipCountDraft(cashier, h.id, ss, { amount: "500" })
    await confirmTipCount(cashier, h.id, ss, {
      expectedVersion: draft.version,
      amount: "500",
      physicallyReceived: true,
    })
    await settle(a.participationId, "59000")
    await settle(b.participationId, "0", true) // OUT: la deuda sigue
    await settle(c.participationId, "9900")
    await closeSessionTable(cashier, h.id, t25, { idempotencyKey: key() })
    await closeSessionTable(cashier, h.id, t10, { idempotencyKey: key() })
    await confirmRakeCount(cashier, h.id, t25, {
      cycleId: (await cycleOf(h.id, t25)).id,
      countedAmount: "8000",
      physicallyCounted: true,
      idempotencyKey: key(),
    })

    // 21. Caja propia: solo el efectivo de ESTA jornada (60,000).
    expect((await cashBalanceOf(prisma, h.id)).balance.toFixed(2)).toBe(
      "60000.00"
    )
    expect(
      (await receivablesOf(prisma, b.playerId)).map((r) => r.balance.toFixed(2))
    ).toEqual(["20000.00"])

    // 15-17. Conciliación global: entregado 80,000 = devuelto 68,900 + rake
    // 10,500 + propinas 500 + diferencia 100 → cierre con motivo.
    await prepareClosing(h.id)
    const preview = await buildClosurePreview(prisma, h.id)
    // 10. Solo SUPERADMIN cierra una jornada histórica (elige la hora).
    await expect(
      confirmClosure(cashier, h.id, {
        idempotencyKey: key(),
        previewHash: preview.previewHash,
        differenceReason: "Faltan 100 sin identificar",
        operatedClosedAt: "2026-10-25T04:00",
      })
    ).rejects.toThrow(/superadministrador/)
    // 25. Hora futura y hora anterior a la apertura → rechazadas.
    await expect(
      confirmClosure(admin, h.id, {
        idempotencyKey: key(),
        previewHash: preview.previewHash,
        differenceReason: "Faltan 100 sin identificar",
        operatedClosedAt: "2999-01-01T04:00",
      })
    ).rejects.toThrow(/futuro/)
    await expect(
      confirmClosure(admin, h.id, {
        idempotencyKey: key(),
        previewHash: preview.previewHash,
        differenceReason: "Faltan 100 sin identificar",
        operatedClosedAt: "2026-10-24T19:00",
      })
    ).rejects.toThrow(/posterior a la apertura/)
    await expect(
      confirmClosure(admin, h.id, {
        idempotencyKey: key(),
        previewHash: preview.previewHash,
        differenceReason: "Faltan 100 sin identificar",
      })
    ).rejects.toThrow(/terminó la jornada/)
    // 16. Cierre que cruza la medianoche: 25/10 04:00 (UTC 10:00).
    const k = key()
    await confirmClosure(admin, h.id, {
      idempotencyKey: k,
      previewHash: preview.previewHash,
      differenceReason: "Faltan 100 sin identificar",
      operatedClosedAt: "2026-10-25T04:00",
    })
    // 27. Idempotente: el reintento no vuelve a cerrar.
    expect(
      await confirmClosure(admin, h.id, {
        idempotencyKey: k,
        previewHash: preview.previewHash,
        differenceReason: "Faltan 100 sin identificar",
        operatedClosedAt: "2026-10-25T04:00",
      })
    ).toEqual({ replayed: true })

    const closed = await getSession(h.id)
    expect(closed).toMatchObject({
      status: "CLOSED",
      businessDate: "2026-10-24",
      operatedOpenedAt: "2026-10-25T02:30:00.000Z",
      operatedClosedAt: "2026-10-25T10:00:00.000Z",
    })
    // Las fechas REALES no se falsifican: son de hoy, no del 24/10.
    expect(new Date(closed.closedAt!).getTime()).toBeGreaterThan(
      new Date(closed.operatedClosedAt!).getTime()
    )
    // Caja $0 al final; diferencia guardada con motivo, sin ajustes.
    expect((await cashBalanceOf(prisma, h.id)).balance.toFixed(2)).toBe("0.00")
    const diff = await prisma.sessionChipDifference.findFirstOrThrow({
      where: { sessionId: h.id },
    })
    expect(diff.reason).toBe("Faltan 100 sin identificar")
    const report = await prisma.closureReport.findFirstOrThrow({
      where: { sessionId: h.id },
    })
    const content = report.content as {
      session: { historical?: Record<string, string> }
    }
    expect(content.session.historical).toMatchObject({
      businessDate: "2026-10-24",
      operatedClosedAt: "2026-10-25T10:00:00.000Z",
    })

    // 22. Sin duplicados: cada movimiento nominal de la jornada aparece una
    // sola vez por (tipo, referencia); cuatro compras confirmadas.
    const moves = await prisma.chipNominalMovement.findMany({
      where: { sessionId: h.id },
      select: { movementType: true, referenceType: true, referenceId: true },
    })
    expect(moves.length).toBeGreaterThan(0)
    const keys = moves.map(
      (m) => `${m.movementType}:${m.referenceType}:${m.referenceId}`
    )
    expect(new Set(keys).size).toBe(keys.length)
    expect(
      await prisma.chipPurchase.count({
        where: { sessionId: h.id, status: "CONFIRMED" },
      })
    ).toBe(4)

    // 23. La jornada posterior no cambió (sesión, comprobante, arqueos, caja).
    const after = await snapshotOf(laterId)
    expect(after.session).toEqual(later.session)
    expect(after.report.contentHash).toBe(later.report.contentHash)
    expect(after.counts).toEqual(later.counts)
    expect(after.cash).toEqual(later.cash)

    // 24. Auditoría de captura tardía con la fecha real y la operativa.
    const created = await auditRows("HISTORICAL_SESSION_CREATED")
    expect(created[0].metadata).toMatchObject({
      businessDate: "2026-10-24",
      operatedOpenedAt: "2026-10-25T02:00:00.000Z",
    })
    const progress = await auditRows("SESSION_OPENING_PROGRESS_SAVED")
    expect(progress.at(-1)!.metadata).toMatchObject({
      operatedOpenedAt: "2026-10-25T02:30:00.000Z",
      previousOperatedOpenedAt: "2026-10-25T02:00:00.000Z",
    })
    const approved = await auditRows("SESSION_CLOSURE_APPROVED")
    expect(
      approved.find(
        (r) => (r.metadata as { folio?: string }).folio === h.folio
      )!.metadata
    ).toMatchObject({
      historical: true,
      operatedClosedAt: "2026-10-25T10:00:00.000Z",
    })

    // 19. Reportes por fecha operativa con horas operativas y de captura.
    const parsed = parseReportFilters("sessions", {
      from: "2026-10-24",
      to: "2026-10-24",
    })
    if (!parsed.ok) throw new Error("filtros inválidos")
    const rows = await listSessionReports(parsed.filters)
    expect(rows.items).toHaveLength(1)
    expect(rows.items[0]).toMatchObject({
      folio: h.folio,
      operatedDay: "2026-10-24",
      operatedOpenedAt: "2026-10-25T02:30:00.000Z",
      operatedClosedAt: "2026-10-25T10:00:00.000Z",
      isHistorical: true,
    })
    expect(rows.items[0].recordedAt).not.toBeNull()
    expect(rows.items[0].metrics).toMatchObject({
      initialCount: 3,
      rebuyCount: 1,
    })
    const { buffer } = await buildReportXlsx("sessions", parsed.filters, admin)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer as unknown as ArrayBuffer)
    const header = (wb.getWorksheet("Sesiones")!.getRow(1).values as string[])
      .filter(Boolean)
      .map(String)
    expect(header).toEqual(
      expect.arrayContaining([
        "Fecha operativa",
        "Apertura operativa",
        "Cierre operativo",
        "Jornada capturada el",
      ])
    )
  })

  it("6. abre con CERO mesas; 3-4. PARTNER y CASHIER no eligen la modalidad ni la hora", async () => {
    for (const actor of [cashier, partner])
      await expect(
        createSession(actor, {
          idempotencyKey: key(),
          historical: true,
          businessDate: "2026-10-24",
          openingTime: "20:00",
        })
      ).rejects.toThrow(/superadministrador/)
    // 5. SUPERADMIN también crea una jornada normal (sin hora operativa).
    const normal = await createSession(admin, { idempotencyKey: key() })
    expect(normal).toMatchObject({
      isHistorical: false,
      operatedOpenedAt: null,
    })
    // Una jornada normal no acepta hora operativa.
    await expect(
      saveOpeningWizardProgress(admin, normal.id, { openingTime: "20:00" })
    ).rejects.toThrow(/solo se elige en una jornada histórica/)
    await cancelSession(admin, normal.id, { reason: "Prueba de modalidad" })
    const h = await historical("2026-10-24")
    await prepareSession(admin, h.id)
    // PARTNER no cambia la hora (ni la preparación ajena).
    await expect(
      saveOpeningWizardProgress(partner, h.id, { openingTime: "21:00" })
    ).rejects.toThrow()
    await countAndZeroCash(admin, h.id)
    await saveOpeningWizardProgress(admin, h.id, { noTables: true })
    const wizard = await getOpeningWizard(h.id, admin)
    await openSession(admin, h.id, {
      idempotencyKey: key(),
      previewHash: wizard.previewHash,
    })
    expect(
      await prisma.sessionTable.count({
        where: { sessionId: h.id, status: "OPEN" },
      })
    ).toBe(0)
    // La hora de apertura ya no cambia con la jornada abierta (trigger).
    await expect(
      prisma.pokerSession.update({
        where: { id: h.id },
        data: { operatedOpenedAt: new Date("2026-10-25T03:00:00Z") },
      })
    ).rejects.toThrow(/solo cambia mientras la jornada se prepara/)
  })

  it("25. rechaza horas inválidas y avisa de otra jornada con la misma fecha (sin bloquear)", async () => {
    await expect(historical("2026-10-24", "24:00")).rejects.toThrow(
      /Hora de apertura inválida/
    )
    const first = await historical("2026-10-21")
    // Simula un registro anterior del mismo día (no vigente, no cancelado).
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica")
      await tx.pokerSession.update({
        where: { id: first.id },
        data: { status: "HISTORICAL", operatedOpenedAt: null },
      })
    })
    const second = await historical("2026-10-21")
    const tasks = (await getOpeningWizard(second.id, admin)).steps[0].tasks
    const dup = tasks.find((t) => t.code === "SAME_DAY_SESSION_EXISTS")!
    expect(dup.severity).toBe("WARNING")
    expect(dup.title).toContain(first.folio)
    // Una cancelada no cuenta como duplicado.
    await cancelSession(admin, second.id, { reason: "Duplicada" })
    const third = await historical("2026-10-22")
    expect(
      (await getOpeningWizard(third.id, admin)).steps[0].tasks.map(
        (t) => t.code
      )
    ).not.toContain("SAME_DAY_SESSION_EXISTS")
  })
})
