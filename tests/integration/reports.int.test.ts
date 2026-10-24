import { randomUUID } from "node:crypto"

import ExcelJS from "exceljs"
import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it } from "vitest"

import * as dashboardRoute from "@/app/api/reports/dashboard/route"
import * as creditsRoute from "@/app/api/reports/credits/route"
import * as playerCreditRoute from "@/app/api/reports/credits/players/[playerId]/route"
import * as playerSessionPurchasesRoute from "@/app/api/reports/credits/players/[playerId]/sessions/[sessionId]/purchases/route"
import * as exportRoute from "@/app/api/reports/export/xlsx/route"
import * as sessionsRoute from "@/app/api/reports/sessions/route"
import { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { getSessionChipReconciliation } from "@/modules/closure/chip-circulation.service"
import { confirmBankTransfer } from "@/modules/cash/bank-transfer.service"
import { buildClosurePreview } from "@/modules/closure/closure.data"
import {
  confirmClosingChipCount,
  confirmClosure,
  reconcileSessionChips,
  recordClosingCashCount,
  startClosing,
  startClosingChipCount,
} from "@/modules/closure/closure.service"
import {
  registerPayment,
  reversePayment,
} from "@/modules/credits/receivable-payment.service"
import { outstandingOf } from "@/modules/credits/receivable.service"
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
import {
  creditTotals,
  getCreditSummary,
  getCreditTree,
  getPlayerCreditReport,
  listCreditPayments,
  listCreditPlayers,
  listCreditSessions,
  listSettlementOffsets,
} from "@/modules/reports/credit-report.service"
import { getDashboard } from "@/modules/reports/dashboard-report.service"
import { getFinancialReport } from "@/modules/reports/financial-report.service"
import {
  listPurchaseReports,
  listSettlementReports,
} from "@/modules/reports/purchase-report.service"
import { DEFAULT_FILTERS } from "@/modules/reports/report.filters"
import {
  getSessionReport,
  listTableCycles,
} from "@/modules/reports/session-report.service"
import { buildReportXlsx } from "@/modules/reports/xlsx-export.service"
import {
  addPlayerToTable,
  transferPlayer,
} from "@/modules/session-tables/participation.service"
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
  createSession,
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

import {
  auditRows,
  call,
  createTestPlayer,
  createUser,
  resetDatabase,
  signInAs,
  signOut,
} from "./helpers"

/**
 * Módulo 14 — reportes contra PostgreSQL REAL. Todo se registra con los
 * servicios reales de los Módulos 06–12 (compras firmadas, transferencias,
 * cierres autorizados, abonos FIFO); los reportes solo LEEN.
 *
 * Caso obligatorio (§32): Juan Pérez.
 *   Sesión A: compra a crédito $3,000 (10/10) + recompra a crédito $2,000
 *             (25/25, tras cambiar de mesa) = $5,000.
 *   Abono general $2,000 (FIFO → sesión A).
 *   Sesión B: compra $6,000 con transferencia pendiente $1,000 (pago
 *             VINCULADO a esa compra, se verifica después) → B pendiente $5,000.
 *   Total pendiente $8,000. Luego abono general $4,000:
 *   FIFO → A $3,000 (queda $0) y B $1,000 (queda $4,000). Total $4,000.
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
    _user: u,
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

let cashier: Actor
let partner: Actor
let admin: Actor
let t25: string
let t10: string
let denominationId: string

async function openRealSession() {
  const s = await createSession(cashier, { idempotencyKey: key() })
  await prepareSession(cashier, s.id)
  const { count } = await createOpeningChipCount(cashier, s.id)
  await updateStockCount(cashier, count.id, {
    lines: count.details.map((x) => ({
      denominationId: x.denominationId,
      countedQuantity: x.expectedQuantity,
    })),
  })
  await confirmStockCount(cashier, count.id, key())
  await confirmOpeningCashCount(cashier, s.id, {
    countedAmount: "0",
    physicallyVerified: true,
  })
  await openSession(cashier, s.id, { idempotencyKey: key() })
  return s.id
}

async function openTables(sid: string) {
  await openSessionTable(cashier, sid, t25, { idempotencyKey: key() })
  await openSessionTable(cashier, sid, t10, { idempotencyKey: key() })
}

async function seat(sid: string, playerId: string, tableId: string) {
  const r = await addPlayerToTable(cashier, sid, tableId, {
    playerId,
    idempotencyKey: key(),
  })
  return r.participationId
}

async function creditBuy(
  participationId: string,
  amount: string,
  opts: { transfer?: string } = {}
) {
  const { purchaseId } = await createPurchase(cashier, {
    participationId,
    nominalAmount: amount,
    idempotencyKey: key(),
  })
  if (opts.transfer)
    await recordPayment(cashier, purchaseId, {
      method: "BANK_TRANSFER",
      amount: opts.transfer,
      bankReference: `SPEI-${opts.transfer}`,
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
  const p = await getPurchase(purchaseId)
  await confirmDelivery(cashier, purchaseId, {
    expectedVersion: p.version,
    physicalDeliveryConfirmed: true,
    idempotencyKey: key(),
  })
  return purchaseId
}

/** Liquidación con $0 devueltos y sin compensar (la deuda queda viva). */
async function settleZero(participationId: string) {
  return settle(participationId, "0", "NO_COMPENSATE")
}

async function settle(
  participationId: string,
  returned: string,
  offsetDecision: "NO_COMPENSATE" | "PARTIAL" | "MAXIMUM",
  offsetAmount?: string
) {
  const { settlementId } = await createSettlement(cashier, {
    participationId,
    returnedNominalAmount: returned,
    offsetDecision,
    ...(offsetAmount ? { offsetAmount } : {}),
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
    chipsReceived: true,
    ...(Number(s.returnedNominalAmount) === 0
      ? { zeroReturnConfirmed: true as const }
      : {}),
    idempotencyKey: key(),
  })
  return settlementId
}

/** Cierre completo autorizado por el socio (caja $0, arqueo global exacto). */
async function closeSession(sid: string) {
  await closeSessionTable(cashier, sid, t25, { idempotencyKey: key() })
  await closeSessionTable(cashier, sid, t10, { idempotencyKey: key() })
  await startClosing(cashier, sid, { idempotencyKey: key() })
  const state = await prisma.chipSetInventoryState.findFirstOrThrow()
  const quantity = D(state.custodyNominal).div(500).toNumber()
  const { count } = await startClosingChipCount(cashier, sid)
  await updateStockCount(cashier, count.id, {
    lines: [{ denominationId, countedQuantity: quantity }],
  })
  await confirmClosingChipCount(cashier, sid, {
    countId: count.id,
    idempotencyKey: key(),
  })
  await recordClosingCashCount(cashier, sid, {
    countedAmount: "0",
    physicallyCounted: true,
  })
  // Este escenario deja fichas sin regresar a propósito: la conciliación
  // global exige que un socio documente y autorice la diferencia.
  if (
    (await getSessionChipReconciliation(prisma, sid)).status ===
    "UNEXPLAINED_DIFFERENCE"
  )
    await reconcileSessionChips(partner, sid, {
      kind: "UNRECOVERED_AUTHORIZED",
      reason: "Escenario de prueba: fichas no devueltas documentadas",
      idempotencyKey: key(),
    })
  const p = await buildClosurePreview(prisma, sid)
  await confirmClosure(partner, sid, {
    idempotencyKey: key(),
    previewHash: p.previewHash,
  })
}

const adminPay = (playerId: string, amount: string, k = key()) =>
  registerPayment(cashier, {
    playerId,
    amount,
    origin: "ADMINISTRATIVE",
    method: "CASH",
    cashReceived: true,
    idempotencyKey: k,
  } as Parameters<typeof registerPayment>[1])

type Scenario = {
  juan: string
  sessionA: string
  sessionB: string
  folioA: string
  folioB: string
  initialA: string
  rebuyA: string
  purchaseB: string
}

/** Construye el caso de Juan Pérez hasta $8,000 pendientes (antes del abono de $4,000). */
async function juanScenario(): Promise<Scenario> {
  const juan = (await createTestPlayer({ name: "Juan Pérez" })).id
  // ── Sesión A ──
  const sessionA = await openRealSession()
  await openTables(sessionA)
  const p10 = await seat(sessionA, juan, t10)
  const initialA = await creditBuy(p10, "3000")
  const moved = await transferPlayer(cashier, sessionA, {
    sourceParticipationId: p10,
    destinationTableId: t25,
    idempotencyKey: key(),
  })
  const p25 = (
    await prisma.tableParticipation.findFirstOrThrow({
      where: { sessionId: sessionA, playerId: juan, status: "ACTIVE" },
      select: { id: true },
    })
  ).id
  expect(moved).toBeTruthy()
  const rebuyA = await creditBuy(p25, "2000")
  await settleZero(p25)
  await closeSession(sessionA)
  // Abono general previo de $2,000 (fuera de sesión) → FIFO a la sesión A.
  await adminPay(juan, "2000")
  // ── Sesión B ──
  const sessionB = await openRealSession()
  await openTables(sessionB)
  const pB = await seat(sessionB, juan, t10)
  const purchaseB = await creditBuy(pB, "6000", { transfer: "1000" })
  // La transferencia de la compra se verifica después: pago VINCULADO.
  const t = await prisma.bankTransferVerification.findFirstOrThrow({
    where: { referenceType: "PurchasePayment" },
  })
  await confirmBankTransfer(cashier, t.id, { verifiedInBank: true })
  await settleZero(pB)
  await closeSession(sessionB)
  const folios = await prisma.pokerSession.findMany({
    where: { id: { in: [sessionA, sessionB] } },
    select: { id: true, folio: true },
  })
  return {
    juan,
    sessionA,
    sessionB,
    folioA: folios.find((f) => f.id === sessionA)!.folio,
    folioB: folios.find((f) => f.id === sessionB)!.folio,
    initialA,
    rebuyA,
    purchaseB,
  }
}

beforeEach(async () => {
  await resetDatabase()
  const shared = await prisma.chipSet.findUniqueOrThrow({
    where: { code: "CHIPSET_MAIN" },
  })
  denominationId = (
    await prisma.chipDenomination.create({
      data: { chipSetId: shared.id, value: "500" },
    })
  ).id
  cashier = await actorFor("CASHIER")
  partner = await actorFor("PARTNER")
  admin = await actorFor("SUPERADMIN")
  await initializeStock(cashier, {
    chipSetId: shared.id,
    lines: [{ denominationId, quantity: 200 }],
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

const F = DEFAULT_FILTERS

describe("caso obligatorio: Juan Pérez (§32)", () => {
  it("desglosa por sesión de origen y por compra; FIFO entre sesiones; histórico intacto", async () => {
    const s = await juanScenario()

    // ── Estado inicial: A $3,000 + B $5,000 = $8,000 ──
    const before = await getPlayerCreditReport(s.juan, F)
    expect(before.totals.balance).toBe("8000.00")
    expect(before.totals.original).toBe("11000.00")
    expect(before.totals.paymentsApplied).toBe("3000.00")
    expect(before.sessions.map((x) => x.session.id)).toEqual([
      s.sessionA,
      s.sessionB,
    ])
    const [a0, b0] = before.sessions
    expect([a0.original, a0.paymentsApplied, a0.balance]).toEqual([
      "5000.00",
      "2000.00",
      "3000.00",
    ])
    expect([b0.original, b0.paymentsApplied, b0.balance]).toEqual([
      "6000.00",
      "1000.00",
      "5000.00",
    ])
    // Detalle por compra: inicial 10/10 (abonada $2,000) y recompra #1 en 25/25.
    const [ini, reb] = a0.debts
    expect(ini.purchase.id).toBe(s.initialA)
    expect(ini.purchase.type).toBe("INITIAL_PURCHASE")
    expect(ini.table.id).toBe(t10)
    expect([ini.original, ini.paymentsApplied, ini.balance]).toEqual([
      "3000.00",
      "2000.00",
      "1000.00",
    ])
    expect(reb.purchase.id).toBe(s.rebuyA)
    expect(reb.purchase.typeLabel).toBe("Recompra #1")
    expect(reb.table.id).toBe(t25)
    expect([reb.original, reb.balance]).toEqual(["2000.00", "2000.00"])
    expect(reb.authorization.partnerName).toBe(partner.name)
    expect(reb.signature?.status).toBe("VALID")
    // La transferencia vinculada se quedó en la compra de B (no por FIFO).
    expect(b0.debts[0].linkedPayments).toBe("1000.00")
    expect(b0.debts[0].payments).toBe("0.00")

    // Comprobante de cierre de A: inmutable.
    const reportA = await prisma.closureReport.findUniqueOrThrow({
      where: { sessionId: s.sessionA },
    })
    const allocationsBefore = await prisma.paymentAllocation.count()

    // ── Abono general de $4,000 ──
    const { paymentId } = await adminPay(s.juan, "4000")
    const after = await getPlayerCreditReport(s.juan, F)
    const [a1, b1] = after.sessions
    expect(a1.balance).toBe("0.00")
    expect(b1.balance).toBe("4000.00")
    expect(after.totals.balance).toBe("4000.00")
    expect(after.sessions).toHaveLength(2) // la deuda no se traslada a otra sesión
    expect(await outstandingOf(prisma, s.juan)).toEqual(D("4000"))

    // Sin duplicados: un solo abono nuevo con 3 aplicaciones que suman $4,000.
    expect(await prisma.paymentAllocation.count()).toBe(allocationsBefore + 3)
    const payments = await listCreditPayments({ ...F, playerId: s.juan })
    const p4000 = payments.items.find((p) => p.id === paymentId)!
    expect(p4000.amount).toBe("4000.00")
    expect(p4000.applied).toBe("4000.00")
    expect(p4000.allocations.map((x) => x.originSession.id)).toEqual([
      s.sessionA,
      s.sessionA,
      s.sessionB,
    ])
    expect(p4000.affectedSessions.map((x) => x.id)).toEqual([
      s.sessionA,
      s.sessionB,
    ])
    expect(payments.totals.received).toBe("6000.00") // $2,000 + $4,000, sin duplicar
    // Fecha real del pago ≠ fecha de origen de la deuda.
    const app = a1.debts[1].applications.at(-1)!
    expect(app.paymentFolio).toBe(p4000.folio)
    expect(new Date(app.appliedAt).getTime()).toBeGreaterThan(
      new Date(a1.debts[1].createdAt).getTime()
    )
    expect(app.collectedInSessionFolio).toBeNull()

    // Deuda al cierre vs. actual.
    expect(a1.atClosure).toMatchObject({
      balanceAtClosure: "5000.00",
      paymentsAfter: "5000.00",
      currentBalance: "0.00",
      reconciles: true,
    })
    expect(b1.atClosure).toMatchObject({
      balanceAtClosure: "5000.00",
      paymentsAfter: "1000.00",
      linkedPaymentsAfter: "0.00",
      currentBalance: "4000.00",
      reconciles: true,
    })
    const bySession = await listCreditSessions(F)
    const rowA = bySession.items.find((r) => r.session.id === s.sessionA)!
    const rowB = bySession.items.find((r) => r.session.id === s.sessionB)!
    expect(rowA.closureSnapshotOutstanding).toBe("5000.00")
    expect(rowA.balance).toBe("0.00")
    expect(rowB.closureSnapshotOutstanding).toBe("5000.00")
    expect(rowB.balance).toBe("4000.00")
    // El comprobante histórico NO cambió.
    const reportAfter = await prisma.closureReport.findUniqueOrThrow({
      where: { sessionId: s.sessionA },
    })
    expect(reportAfter.contentHash).toBe(reportA.contentHash)
    const detailA = await getSessionReport(s.sessionA)
    expect(detailA.historical?.creditsOutstandingAtClosure).toBe("5000.00")
    expect(detailA.current.creditsOutstanding).toBe("0.00")

    // SQL agregado y árbol coinciden (una sola fórmula de saldo).
    const summary = await getCreditSummary(F)
    const totals = creditTotals(await getCreditTree(F))
    expect(summary.balance).toBe(totals.balance)
    expect(summary.original).toBe(totals.original)
    expect(summary.paymentsApplied).toBe(totals.paymentsApplied)
    const players = await listCreditPlayers(F)
    expect(players.items[0]).toMatchObject({
      player: { id: s.juan },
      balance: "4000.00",
      sessionsWithBalance: 1,
    })

    // ── XLSX: coincide con la pantalla ──
    const { buffer, fileName } = await buildReportXlsx(
      "credits",
      { ...F, playerId: s.juan },
      { id: cashier.id, name: cashier.name }
    )
    expect(fileName).toBe("PokerManager_Creditos.xlsx")
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer as unknown as ArrayBuffer)
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "Resumen global",
      "Deudas por jugador",
      "Deudas por sesión",
      "Detalle de compras",
      "Aplicaciones de abonos",
      "Filtros y fecha",
    ])
    const ws = wb.getWorksheet("Deudas por sesión")!
    const header = (ws.getRow(1).values as unknown[]).slice(1)
    const col = (h: string) => header.indexOf(h) + 1
    const rows = [2, 3].map((r) => ws.getRow(r))
    expect(rows.map((r) => r.getCell(col("Sesión")).value)).toEqual([
      s.folioA,
      s.folioB,
    ])
    expect(rows.map((r) => r.getCell(col("Saldo actual")).value)).toEqual([
      0, 4000,
    ])
    expect(
      rows.map((r) => r.getCell(col("Deuda registrada al cierre")).value)
    ).toEqual([5000, 5000])
    expect(rows.map((r) => r.getCell(col("Crédito original")).value)).toEqual([
      5000, 6000,
    ])
    const apps = wb.getWorksheet("Aplicaciones de abonos")!
    const aHeader = (apps.getRow(1).values as unknown[]).slice(1)
    const appliedCol = aHeader.indexOf("Importe aplicado") + 1
    const folioCol = aHeader.indexOf("Folio de abono") + 1
    let applied4000 = 0
    for (let r = 2; r <= apps.rowCount; r++) {
      const row = apps.getRow(r)
      if (row.getCell(folioCol).value === p4000.folio)
        applied4000 += Number(row.getCell(appliedCol).value)
    }
    expect(applied4000).toBe(4000) // suma de aplicaciones = abono real
    const resumen = wb.getWorksheet("Resumen global")!
    const deuda = resumen
      .getColumn(1)
      .values.findIndex((v) => v === "Deuda global pendiente")
    expect(resumen.getRow(deuda).getCell(2).value).toBe(4000)
    const [exported] = await auditRows("REPORT_EXPORTED")
    expect(exported).toMatchObject({
      actorUserId: cashier.id,
      result: "SUCCESS",
      entityId: "credits",
    })
    expect(exported.metadata).toMatchObject({
      format: "XLSX",
      filters: { playerId: s.juan },
    })
  })

  it("reportes por sesión, mesa, compras y finanzas reflejan el origen sin duplicar", async () => {
    const s = await juanScenario()
    const detailA = await getSessionReport(s.sessionA)
    expect(detailA.metrics).toMatchObject({
      initialCount: 1,
      initialNominal: "3000.00",
      rebuyCount: 1,
      rebuyNominal: "2000.00",
      creditsOriginated: "5000.00",
      players: 1,
      netNotReturned: "5000.00",
    })
    expect(detailA.closure?.approvedBy?.id).toBe(partner.id)
    const cycles = await listTableCycles({ ...F, sessionId: s.sessionA })
    const c10 = cycles.items.find((c) => c.table.id === t10)!
    const c25 = cycles.items.find((c) => c.table.id === t25)!
    expect([c10.transfersOut, c10.transfersIn]).toEqual([1, 0])
    expect([c25.transfersOut, c25.transfersIn]).toEqual([0, 1])
    expect(c10.initialNominal).toBe("3000.00")
    expect(c25.rebuyNominal).toBe("2000.00")
    const purchases = await listPurchaseReports({ ...F, sessionId: s.sessionB })
    expect(purchases.items[0]).toMatchObject({
      nominalAmount: "6000.00",
      transferConfirmed: "1000.00",
      transferPending: "0.00",
      cashConfirmed: "0.00",
      creditOriginated: "6000.00",
    })
    const fin = await getFinancialReport(F)
    expect(fin.receivables.balance).toBe("8000.00")
    expect(fin.monetary.flows.highlights.bankCollectionsConfirmed).toBe(
      "1000.00"
    )
    // Crédito no es dinero: las cuatro categorías van separadas.
    expect(fin.nominal.circulationNow).toBe("11000.00")
    expect(fin.payables.pending).toBe("0.00")
  })

  it("reverso de un abono: el saldo vuelve y el histórico se concilia", async () => {
    const s = await juanScenario()
    const { paymentId } = await adminPay(s.juan, "4000")
    await reversePayment(cashier, paymentId, {
      reason: "Abono capturado al jugador equivocado",
      idempotencyKey: key(),
    })
    const r = await getPlayerCreditReport(s.juan, F)
    expect(r.totals.balance).toBe("8000.00")
    expect(r.totals.reversals).toBe("4000.00")
    expect(r.sessions[0].atClosure).toMatchObject({
      reversalsAfter: "3000.00",
      currentBalance: "3000.00",
      reconciles: true,
    })
    const pays = await listCreditPayments({ ...F, playerId: s.juan })
    const reversed = pays.items.find((p) => p.id === paymentId)!
    expect(reversed.status).toBe("REVERSED")
    expect(reversed.applied).toBe("0.00")
    expect(pays.totals.received).toBe("2000.00")
  })

  it("abonos concurrentes: FIFO serializado, sin sobreaplicar y reportes consistentes", async () => {
    const s = await juanScenario()
    const results = await Promise.allSettled([
      adminPay(s.juan, "5000"),
      adminPay(s.juan, "5000"),
      getCreditSummary(F),
    ])
    expect(
      results.slice(0, 2).filter((x) => x.status === "fulfilled")
    ).toHaveLength(1)
    const summary = await getCreditSummary(F)
    const tree = await getCreditTree(F)
    expect(summary.balance).toBe("3000.00")
    expect(creditTotals(tree).balance).toBe("3000.00")
    expect(tree[0].sessions.map((x) => x.balance)).toEqual(["0.00", "3000.00"])
  })
})

describe("liquidaciones: compensación opcional y pagos pendientes", () => {
  it("la compensación parcial no es abono ni dinero; la obligación pendiente sobrevive al cierre y no se netea", async () => {
    const ana = (await createTestPlayer({ name: "Ana" })).id
    const sid = await openRealSession()
    await openTables(sid)
    const part = await seat(sid, ana, t25)
    await creditBuy(part, "2000")
    const settlementId = await settle(part, "2000", "PARTIAL", "1500")
    await closeSession(sid)
    const r = await listSettlementReports(F)
    expect(r.items[0]).toMatchObject({
      id: settlementId,
      returnedNominal: "2000.00",
      offsetDecision: "PARTIAL",
      offsetAmount: "1500.00",
      payablePending: "500.00",
      cashPaid: "0.00",
      transferPending: "0.00",
      session: { id: sid, status: "CLOSED" },
    })
    const offsets = await listSettlementOffsets(F)
    expect(offsets).toHaveLength(1)
    expect(offsets[0]).toMatchObject({
      amount: "1500.00",
      originSession: { id: sid },
      settlement: { debtBefore: "2000.00", debtAfter: "500.00" },
    })
    const credit = await getPlayerCreditReport(ana, F)
    expect(credit.totals).toMatchObject({
      offsets: "1500.00",
      paymentsApplied: "0.00",
      balance: "500.00",
    })
    // Por cobrar y por pagar se muestran por separado (no se netean).
    const fin = await getFinancialReport(F)
    expect(fin.receivables.balance).toBe("500.00")
    expect(fin.payables.pending).toBe("500.00")
    expect(fin.monetary.flows.highlights.bankCollectionsConfirmed).toBe("0.00")
    const pays = await listCreditPayments(F)
    expect(pays.total).toBe(0) // la compensación no es un abono
    const dash = await getDashboard()
    expect(dash.globalKpis.find((k) => k.id === "payables")?.value).toBe(
      "500.00"
    )
    expect(dash.globalKpis.find((k) => k.id === "receivables")?.value).toBe(
      "500.00"
    )
  })
})

describe("endpoints, permisos y exportación", () => {
  it("los tres roles consultan y exportan; sin sesión 401; filtros inválidos 400", async () => {
    const s = await juanScenario()
    for (const actor of [cashier, partner, admin]) {
      signInAs(actor._user)
      const d = await call(dashboardRoute.GET, {
        path: "/api/reports/dashboard",
      })
      expect(d.status).toBe(200)
      const c = await call(creditsRoute.GET, {
        path: `/api/reports/credits?playerId=${s.juan}`,
      })
      expect(c.status).toBe(200)
      expect(
        (c.json.data as { summary: { balance: string } }).summary.balance
      ).toBe("8000.00")
      const p = await call(playerSessionPurchasesRoute.GET, {
        path: `/api/reports/credits/players/${s.juan}/sessions/${s.sessionA}/purchases`,
        params: { playerId: s.juan, sessionId: s.sessionA },
      })
      expect(p.status).toBe(200)
      expect(
        (p.json.data as { purchases: { balance: string }[] }).purchases.map(
          (x) => x.balance
        )
      ).toEqual(["1000.00", "2000.00"])
      const x = await exportRoute.GET(
        new NextRequest(
          "http://localhost:3000/api/reports/export/xlsx?report=sessions",
          { headers: { host: "localhost:3000" } }
        ),
        { params: Promise.resolve({}) }
      )
      expect(x.status).toBe(200)
      expect(x.headers.get("content-type")).toBe(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      )
      expect(x.headers.get("content-disposition")).toContain(
        "PokerManager_Sesiones.xlsx"
      )
    }
    signInAs(cashier._user)
    const bad = await call(sessionsRoute.GET, {
      path: "/api/reports/sessions?from=2026-99-01",
    })
    expect(bad.status).toBe(400)
    const badStatus = await call(creditsRoute.GET, {
      path: "/api/reports/credits?status=CONFIRMED",
    })
    expect(badStatus.status).toBe(400)
    const csv = await call(exportRoute.GET, {
      path: "/api/reports/export/xlsx?report=credits&format=csv",
    })
    expect(csv.status).toBe(400)
    const unknown = await call(exportRoute.GET, {
      path: "/api/reports/export/xlsx?report=users",
    })
    expect(unknown.status).toBe(400)
    const missing = await call(playerCreditRoute.GET, {
      path: "/api/reports/credits/players/nope",
      params: { playerId: "nope" },
    })
    expect(missing.status).toBe(404)
    signOut()
    const anon = await call(dashboardRoute.GET, {
      path: "/api/reports/dashboard",
    })
    expect(anon.status).toBe(401)
    const anonExport = await call(exportRoute.GET, {
      path: "/api/reports/export/xlsx?report=credits",
    })
    expect(anonExport.status).toBe(401)
  })

  it("la exportación respeta los filtros y audita; los reportes no escriben movimientos", async () => {
    const s = await juanScenario()
    const counts = async () => ({
      tx: await prisma.cashTransaction.count(),
      alloc: await prisma.paymentAllocation.count(),
      chips: await prisma.chipNominalMovement.count(),
    })
    const before = await counts()
    for (const kind of [
      "dashboard",
      "sessions",
      "tables",
      "purchases",
      "financial",
      "credits",
      "payments",
      "settlements",
      "chips",
      "players",
      "comparisons",
    ] as const) {
      const r = await buildReportXlsx(
        kind,
        { ...F, sessionId: kind === "dashboard" ? undefined : s.sessionA },
        { id: admin.id, name: admin.name }
      )
      expect(r.buffer.length).toBeGreaterThan(1000)
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(r.buffer as unknown as ArrayBuffer)
      const criteria = wb.getWorksheet("Filtros y fecha")!
      expect(criteria.getCell("A2").value).toBe("Reporte")
    }
    // Solo la sesión A en el XLSX de créditos filtrado.
    const { buffer } = await buildReportXlsx(
      "credits",
      { ...F, sessionId: s.sessionA },
      { id: admin.id, name: admin.name }
    )
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer as unknown as ArrayBuffer)
    const ws = wb.getWorksheet("Deudas por sesión")!
    expect(ws.getRow(2).getCell(2).value).toBe(s.folioA)
    expect(ws.getRow(3).getCell(1).value).toBe("TOTAL")
    expect(await counts()).toEqual(before)
    expect((await auditRows("REPORT_EXPORTED")).length).toBe(12)
    expect(
      (await auditRows("REPORT_EXPORTED")).every((r) => r.result === "SUCCESS")
    ).toBe(true)
    const dash = await getDashboard()
    expect(dash.globalKpis.find((k) => k.id === "receivables")?.value).toBe(
      "8000.00"
    )
    expect(dash.session).toBeNull()
  })
})
