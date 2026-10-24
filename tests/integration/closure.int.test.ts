import { randomUUID } from "node:crypto"

import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it } from "vitest"

import * as confirmRoute from "@/app/api/sessions/[id]/closure/confirm/route"
import * as resolveRoute from "@/app/api/sessions/[id]/closure/discrepancies/[discrepancyId]/resolve/route"
import * as reportImageRoute from "@/app/api/sessions/[id]/closure/report/image/route"
import * as startRoute from "@/app/api/sessions/[id]/closure/start/route"
import { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { confirmBankTransfer } from "@/modules/cash/bank-transfer.service"
import { cashBalanceOf } from "@/modules/cash/ledger"
import {
  buildClosurePreview,
  computePrecheck,
  getInventoryStatus,
} from "@/modules/closure/closure.data"
import {
  confirmClosingChipCount,
  confirmClosure,
  reconcileSessionChips,
  getClosureReport,
  recordClosingCashCount,
  registerFinalWithdrawal,
  renderClosureReportPng,
  resolveDiscrepancy,
  returnToOpen,
  startClosing,
  startClosingChipCount,
} from "@/modules/closure/closure.service"
import {
  contributeToCustody,
  custodyBalanceOf,
} from "@/modules/credits/custody.service"
import { registerPayment } from "@/modules/credits/receivable-payment.service"
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
import { addPlayerToTable } from "@/modules/session-tables/participation.service"
import {
  closeSessionTable,
  openSessionTable,
} from "@/modules/session-tables/session-table.service"
import {
  confirmOpeningCashCount,
  createOpeningChipCount,
  getOpeningChecklist,
  openSession,
} from "@/modules/sessions/opening.service"
import {
  createSession,
  prepareSession,
} from "@/modules/sessions/session.service"
import {
  listPendingPayables,
  registerPayout,
} from "@/modules/settlements/settlement-payout.service"
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
} from "./helpers"

/**
 * Módulo 12 — cierre contra PostgreSQL REAL: sesiones, mesas, compras,
 * firmas, liquidaciones, inventario compartido (Módulo 04) y libro
 * financiero (Módulo 05) reales; nada simulado.
 *
 * Escenario base: inventario de 200 fichas de $500 ($100,000 bajo custodia).
 */

type Role = "SUPERADMIN" | "PARTNER" | "CASHIER"
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
let sessionId: string
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
  sessionId = await openRealSession()
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

const openTables = async (sid = sessionId) => {
  await openSessionTable(cashier, sid, t25, { idempotencyKey: key() })
  await openSessionTable(cashier, sid, t10, { idempotencyKey: key() })
}
const closeTable = (tableId: string, sid = sessionId) =>
  closeSessionTable(cashier, sid, tableId, { idempotencyKey: key() })

async function seat(tableId = t25, sid = sessionId) {
  const pid = (await createTestPlayer()).id
  const r = await addPlayerToTable(cashier, sid, tableId, {
    playerId: pid,
    idempotencyKey: key(),
  })
  return { playerId: pid, participationId: r.participationId }
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
  const p = await getPurchase(purchaseId)
  await confirmDelivery(cashier, purchaseId, {
    expectedVersion: p.version,
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
  const p = await getPurchase(purchaseId)
  await confirmDelivery(cashier, purchaseId, {
    expectedVersion: p.version,
    physicalDeliveryConfirmed: true,
    idempotencyKey: key(),
  })
  return purchaseId
}

/** Liquidación completa (firma + recepción), opcionalmente con pago inmediato en efectivo. */
async function settle(
  participationId: string,
  returned: string,
  immediateCashAmount?: string
) {
  const { settlementId } = await createSettlement(cashier, {
    participationId,
    returnedNominalAmount: returned,
    offsetDecision: "NO_COMPENSATE",
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
    ...(immediateCashAmount
      ? { immediateCashAmount, cashDelivered: true }
      : {}),
    idempotencyKey: key(),
  })
  return settlementId
}

const start = (actor: Actor = cashier, sid = sessionId) =>
  startClosing(actor, sid, { idempotencyKey: key() })

/** Arqueo global de fichas del cierre: `quantity` fichas de $500 contadas. */
async function countChips(quantity: number, actor: Actor = cashier) {
  const { count } = await startClosingChipCount(actor, sessionId)
  await updateStockCount(actor, count.id, {
    lines: [{ denominationId, countedQuantity: quantity }],
  })
  return confirmClosingChipCount(actor, sessionId, {
    countId: count.id,
    idempotencyKey: key(),
  })
}

const countCash = (amount: string, explanation?: string, sid = sessionId) =>
  recordClosingCashCount(cashier, sid, {
    countedAmount: amount,
    physicallyCounted: true,
    ...(explanation ? { explanation } : {}),
  })

const withdraw = (
  amount: string,
  recipientName = "Socio receptor",
  k: string = key()
) =>
  registerFinalWithdrawal(cashier, sessionId, {
    idempotencyKey: k,
    amount,
    recipientName,
    physicallyDelivered: true,
  })

async function confirmAs(
  actor: Actor,
  extra: { noActivityReason?: string } = {}
) {
  const p = await buildClosurePreview(prisma, sessionId)
  return confirmClosure(actor, sessionId, {
    idempotencyKey: key(),
    previewHash: p.previewHash,
    ...extra,
  })
}

const cash = async (sid = sessionId) =>
  (await cashBalanceOf(prisma, sid)).balance.toFixed(2)
const status = async (sid = sessionId) =>
  (
    await prisma.pokerSession.findUniqueOrThrow({
      where: { id: sid },
      select: { status: true },
    })
  ).status
async function nominal() {
  const s = await prisma.chipSetInventoryState.findFirstOrThrow()
  return {
    custody: D(s.custodyNominal).toFixed(2),
    circulation: D(s.circulationNominal).toFixed(2),
  }
}

/**
 * Operación típica (≈ ejemplo del Módulo 12): entregas $10,000 y
 * devoluciones $7,000 → $3,000 siguen en circulación. Efectivo: $7,000 de
 * compras − $6,000 pagados a A = $1,000. B queda con deuda y pago pendiente.
 */
async function typicalNight() {
  await openTables()
  const a = await seat(t25)
  const b = await seat(t10)
  await cashBuy(a.participationId, "5000")
  await cashBuy(a.participationId, "2000") // recompra
  await creditBuy(b.participationId, "3000")
  const settlementA = await settle(a.participationId, "6000", "6000")
  const settlementB = await settle(b.participationId, "1000")
  return { a, b, settlementA, settlementB }
}

describe("cierre de mesas (ciclos)", () => {
  it("una mesa cierra mientras la otra sigue operando; inventario y caja siguen siendo únicos", async () => {
    await openTables()
    const a = await seat(t25)
    const b = await seat(t10)
    await cashBuy(a.participationId, "1000")
    await settle(a.participationId, "1000", "1000")
    await closeTable(t25)
    const tables = await prisma.sessionTable.findMany({
      where: { sessionId },
      select: { tableId: true, status: true },
    })
    expect(tables.find((t) => t.tableId === t25)?.status).toBe("CLOSED")
    expect(tables.find((t) => t.tableId === t10)?.status).toBe("OPEN")
    // La otra mesa sigue operando con el MISMO inventario y la MISMA caja.
    await cashBuy(b.participationId, "2000")
    expect(await cash()).toBe("2000.00")
    expect(await nominal()).toEqual({
      custody: "98000.00",
      circulation: "2000.00",
    })
    // No hay arqueo físico al cerrar la primera mesa.
    expect(
      await prisma.chipStockCount.count({ where: { countType: "CLOSING" } })
    ).toBe(0)
    const [audit] = await auditRows("TABLE_CYCLE_CLOSED")
    expect(audit.metadata).toMatchObject({
      initialPurchases: 1,
      initialPurchasesNominal: "1000.00",
      returnedNominal: "1000.00",
      playersFinished: 1,
      settlementsCompleted: 1,
    })
  })

  it("rechaza cerrar con jugadores ACTIVE, compras sin entregar o liquidaciones sin recepción; acepta SETTLING", async () => {
    await openTables()
    const a = await seat(t25)
    await expect(closeTable(t25)).rejects.toThrow(/jugadores activos/)
    await cashBuy(a.participationId, "1000")
    // Liquidación en borrador: la participación sigue ACTIVE.
    await createSettlement(cashier, {
      participationId: a.participationId,
      returnedNominalAmount: "1000",
      offsetDecision: "NO_COMPENSATE",
      idempotencyKey: key(),
    })
    await expect(closeTable(t25)).rejects.toThrow()
    // Una compra sin entregar es un bloqueo de la prevalidación global.
    const c = await seat(t10)
    await createPurchase(cashier, {
      participationId: c.participationId,
      nominalAmount: "500",
      idempotencyKey: key(),
    })
    const p = await computePrecheck(prisma, sessionId)
    expect(
      p.findings.find((f) => f.code === "PURCHASES_PENDING_DELIVERY")?.severity
    ).toBe("BLOCKING")
    expect(
      p.findings.find((f) => f.code === "SETTLEMENTS_PENDING_RECEPTION")
        ?.severity
    ).toBe("BLOCKING")
  })

  it("permite cerrar la mesa con participaciones SETTLING (pago pendiente)", async () => {
    await openTables()
    const a = await seat(t25)
    await cashBuy(a.participationId, "1000")
    await settle(a.participationId, "1000")
    await closeTable(t25)
    expect(
      (
        await prisma.sessionTable.findFirstOrThrow({
          where: { sessionId, tableId: t25 },
        })
      ).status
    ).toBe("CLOSED")
  })
})

describe("prevalidación e inicio del cierre", () => {
  it("clasifica bloqueos y advertencias; no inicia con mesas abiertas ni jugadores activos", async () => {
    await openTables()
    const a = await seat(t25)
    await cashBuy(a.participationId, "1000")
    let p = await computePrecheck(prisma, sessionId)
    const codes = (s: string) =>
      p.findings.filter((f) => f.severity === s).map((f) => f.code)
    expect(codes("BLOCKING")).toEqual(
      expect.arrayContaining(["OPEN_TABLES", "ACTIVE_PARTICIPANTS"])
    )
    await expect(start()).rejects.toThrow(/No se puede iniciar el cierre/)
    expect(await status()).toBe("OPEN")
    await settle(a.participationId, "500")
    await closeTable(t25)
    await closeTable(t10)
    p = await computePrecheck(prisma, sessionId)
    expect(codes("BLOCKING")).toEqual([])
    // Pago pendiente y fichas no retornadas: advertencias, no bloqueos.
    expect(codes("WARNING")).toEqual(
      expect.arrayContaining(["PAYABLES_PENDING", "SESSION_NOMINAL_DIFFERENCE"])
    )
    await start()
    expect(await status()).toBe("CLOSING")
    const [audit] = await auditRows("SESSION_CLOSING_STARTED")
    expect(audit.metadata).toMatchObject({ from: "OPEN", to: "CLOSING" })
    expect(
      await prisma.closurePrecheck.count({ where: { stage: "START" } })
    ).toBe(1)
  })

  it("CLOSING bloquea compras, apertura de mesas, nuevos jugadores, liquidaciones nuevas y pago en efectivo de la caja", async () => {
    await openTables()
    const a = await seat(t25)
    await cashBuy(a.participationId, "1000")
    const sid = await settle(a.participationId, "1000")
    await closeTable(t25)
    await closeTable(t10)
    await start()
    await expect(
      openSessionTable(cashier, sessionId, t25, { idempotencyKey: key() })
    ).rejects.toThrow()
    await expect(seat(t25)).rejects.toThrow()
    await expect(
      registerPayout(cashier, sid, {
        method: "CASH",
        amount: "1000",
        cashDelivered: true,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/en cierre/)
    expect(await cash()).toBe("1000.00")
  })

  it("dos usuarios iniciando el cierre a la vez: un solo intento", async () => {
    const results = await Promise.allSettled([start(cashier), start(partner)])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(await prisma.sessionClosure.count()).toBe(1)
    expect(await status()).toBe("CLOSING")
  })

  it("abrir una mesa mientras se inicia el cierre: gana exactamente una operación", async () => {
    const results = await Promise.allSettled([
      openSessionTable(cashier, sessionId, t25, { idempotencyKey: key() }),
      start(),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const tableOpen = await prisma.sessionTable.count({
      where: { sessionId, status: "OPEN" },
    })
    // O la mesa quedó abierta (y la sesión sigue OPEN) o la sesión entró en cierre sin mesas.
    expect(tableOpen === 1 ? "OPEN" : "CLOSING").toBe(await status())
  })
})

describe("cierre completo (flujo normal)", () => {
  it("arqueo global único, diferencia nominal conciliada por un socio (≠ faltante físico), caja $0, retiro con receptor y confirmación de PARTNER", async () => {
    const { b } = await typicalNight()
    await closeTable(t25)
    await closeTable(t10)
    await start()
    const inv = await getInventoryStatus(prisma, sessionId)
    // Esperado = 100,000 − 10,000 entregado + 7,000 devuelto.
    expect(inv.nominal.projectedCustody).toBe("97000.00")
    expect(inv.nominal.computedExpected).toBe("97000.00")
    expect(inv.nominal.consistent).toBe(true)
    expect(inv.position.sessionNetNotReturned).toBe("3000.00")
    expect(inv.position.globalCirculation).toBe("3000.00")

    // Conteo por denominación: 194 × $500 = $97,000 → sin diferencia física.
    const count = await countChips(194)
    expect(count).toMatchObject({
      countType: "CLOSING",
      reconciliationStatus: "NOT_REQUIRED",
      differenceTotal: "0.00",
    })
    expect(count.details[0]).toMatchObject({ countedQuantity: 194 })
    expect(
      await prisma.chipStockCount.count({
        where: { sessionId, countType: "CLOSING" },
      })
    ).toBe(1)
    expect(await prisma.closureDiscrepancy.count()).toBe(0)
    // Las fichas no retornadas no generan ajustes ni ingresos.
    expect(
      await prisma.chipInventoryOperation.count({
        where: {
          type: { in: ["INVENTORY_ADJUSTMENT", "COUNT_RECONCILIATION"] },
        },
      })
    ).toBe(0)

    // Caja: inició en $0; esperado $1,000 (7,000 − 6,000).
    expect(await cash()).toBe("1000.00")
    await countCash("1000")
    await expect(withdraw("900")).rejects.toThrow(/\$0\.00/)
    await expect(withdraw("1500")).rejects.toThrow()
    const w = await withdraw("1000", "Socio Juan")
    expect(await cash()).toBe("0.00")
    const withdrawal = await prisma.closureCashWithdrawal.findUniqueOrThrow({
      where: { id: w.id },
      include: { cashTransaction: true },
    })
    expect(withdrawal).toMatchObject({
      recipientName: "Socio Juan",
      withdrawnById: cashier.id,
      recipientUserId: null,
    })
    expect(withdrawal.cashTransaction).toMatchObject({
      transactionType: "CASH_WITHDRAWAL",
      withdrawalDestination: "SESSION_CLOSING",
      counterpartyName: "Socio Juan",
    })
    // Sin confirmación del receptor: no existe ningún estado de aprobación pendiente.
    expect(await prisma.closureApproval.count()).toBe(0)

    // CASHIER no confirma (servicio y endpoint).
    await expect(confirmAs(cashier)).rejects.toThrow(
      /socio o un superadministrador/
    )
    signInAs({ ...cashier._user, isActive: true })
    const p = await buildClosurePreview(prisma, sessionId)
    const denied = await call(confirmRoute.POST, {
      method: "POST",
      params: { id: sessionId },
      body: { idempotencyKey: key(), previewHash: p.previewHash },
    })
    expect(denied.status).toBe(403)
    expect(await status()).toBe("CLOSING")

    // Sin conciliar la diferencia nominal global no está listo.
    expect(p.readiness.ready).toBe(false)
    // Conciliación global: todos terminaron y faltan fichas que el arqueo
    // NO encontró → bloquea hasta que un socio documente y autorice.
    expect(
      (await computePrecheck(prisma, sessionId)).findings.find(
        (f) => f.code === "SESSION_NOMINAL_DIFFERENCE"
      )?.severity
    ).toBe("BLOCKING")
    await reconcileSessionChips(partner, sessionId, {
      kind: "UNRECOVERED_AUTHORIZED",
      reason: "Fichas no localizadas tras la revisión del cierre",
      idempotencyKey: key(),
    })
    await confirmAs(partner)
    expect(await status()).toBe("CLOSED")

    const report = await getClosureReport(sessionId)
    expect(report.intact).toBe(true)
    expect(report.content).toMatchObject({
      kind: "NORMAL",
      approvedBy: { id: partner.id, role: "PARTNER" },
      preparedBy: { id: cashier.id },
      inventory: {
        expectedCustody: "97000.00",
        countedCustody: "97000.00",
        physicalDifference: "0.00",
        sessionNetNotReturned: "3000.00",
        globalCirculation: "3000.00",
      },
      cash: {
        expected: "1000.00",
        counted: "1000.00",
        final: "0.00",
        withdrawal: { amount: "1000.00", recipientName: "Socio Juan" },
      },
      credits: { originated: "3000.00", outstanding: "3000.00" },
      settlements: { pendingAmount: "1000.00", pendingPlayers: 1 },
    })
    expect(report.lines.map((l) => l.label)).toContain(
      "Balance nominal de la sesión"
    )
    expect(report.content.inventory.chipReconciliation).toMatchObject({
      status: "RECONCILED",
      authorizedUnrecovered: "3000.00",
    })

    // PNG (no PDF) y su descarga auditada.
    const { png, filename } = await renderClosureReportPng(sessionId)
    expect(png.subarray(1, 4).toString()).toBe("PNG")
    expect(filename).toMatch(/\.png$/)
    signInAs({ ...partner._user, isActive: true })
    const image = await reportImageRoute.GET(
      new NextRequest(
        `http://localhost:3000/api/sessions/${sessionId}/closure/report/image`,
        { headers: { host: "localhost:3000" } }
      ),
      { params: Promise.resolve({ id: sessionId }) }
    )
    expect(image.status).toBe(200)
    expect(image.headers.get("content-type")).toBe("image/png")
    expect(await auditRows("CLOSURE_REPORT_DOWNLOADED")).toHaveLength(1)

    // Deudas y pagos pendientes sobreviven intactos.
    expect(
      (await receivablesOf(prisma, b.playerId)).map((r) => r.balance.toFixed(2))
    ).toEqual(["3000.00"])
    expect((await listPendingPayables({ sessionId })).totals.pending).toBe(
      "1000.00"
    )

    // Sesión CLOSED: no admite compras, ni reabrirse, ni movimientos de su caja.
    await expect(seat(t25)).rejects.toThrow()
    await expect(start(admin)).rejects.toThrow()
    await expect(
      prisma.$executeRaw`UPDATE "poker_sessions" SET "status" = 'OPEN' WHERE "id" = ${sessionId}`
    ).rejects.toThrow()
    const cashAccount = await prisma.financialAccount.findUniqueOrThrow({
      where: { kind: "CASH_ON_HAND" },
    })
    const anyTx = await prisma.cashTransaction.findFirstOrThrow()
    await expect(
      prisma.cashTransactionEntry.create({
        data: {
          transactionId: anyTx.id,
          accountId: cashAccount.id,
          direction: "DEBIT",
          amount: "10",
          scopeKey: sessionId,
        },
      })
    ).rejects.toThrow(/no admite movimientos/)

    // Pago posterior: desde custodia administrativa, sin tocar la caja cerrada.
    await contributeToCustody(cashier, {
      amount: "1000",
      counterpartyName: "Socio Juan",
      reason: "Fondeo para pagar liquidación pendiente",
      cashReceived: true,
      idempotencyKey: key(),
    })
    const settlementB = await prisma.playerSettlement.findFirstOrThrow({
      where: { playerId: b.playerId },
    })
    await registerPayout(cashier, settlementB.id, {
      method: "CASH",
      amount: "1000",
      cashDelivered: true,
      idempotencyKey: key(),
    })
    expect(await cash()).toBe("0.00")
    expect(await custodyBalanceOf(cashier.id)).toBe("0.00")
    // Abono administrativo posterior: tampoco toca la caja cerrada.
    await registerPayment(cashier, {
      playerId: b.playerId,
      amount: "500",
      origin: "ADMINISTRATIVE",
      method: "CASH",
      cashReceived: true,
      idempotencyKey: key(),
    } as Parameters<typeof registerPayment>[1])
    expect(await cash()).toBe("0.00")
    // El comprobante histórico no cambia con los movimientos posteriores.
    const after = await getClosureReport(sessionId)
    expect(after.contentDigest).toBe(report.contentDigest)
    expect(after.content.settlements.pendingAmount).toBe("1000.00")
    await expect(
      prisma.$executeRaw`UPDATE "closure_reports" SET "folio" = 'X' WHERE "sessionId" = ${sessionId}`
    ).rejects.toThrow()

    // Auditoría del flujo.
    for (const action of [
      "SESSION_CLOSING_STARTED",
      "CLOSURE_PRECHECK_COMPLETED",
      "INVENTORY_FINAL_COUNT_RECORDED",
      "OUTSTANDING_CHIP_VALUE_CALCULATED",
      "CASH_FINAL_COUNT_RECORDED",
      "CASH_WITHDRAWAL_CONFIRMED",
      "SESSION_CLOSURE_APPROVED",
      "CLOSURE_REPORT_CREATED",
      "SESSION_CLOSED",
      "TABLE_CYCLE_CLOSED",
    ]) {
      expect((await auditRows(action)).length).toBeGreaterThan(0)
    }
    const closedAudit = (await auditRows("SESSION_CLOSED"))[0]
    expect(closedAudit.metadata).toMatchObject({
      finalCash: "0.00",
      withdrawn: "1000.00",
      recipient: "Socio Juan",
    })
    expect(
      JSON.stringify((await auditRows()).map((r) => r.metadata))
    ).not.toMatch(/"[a-zA-Z]*Hash"/)
  })

  it("SUPERADMIN también confirma; reintentos y confirmaciones simultáneas no duplican el cierre ni el comprobante", async () => {
    await openTables()
    const a = await seat(t25)
    await cashBuy(a.participationId, "2000")
    await settle(a.participationId, "2000", "2000")
    await closeTable(t25)
    await closeTable(t10)
    await start()
    await countChips(200)
    await countCash("0")
    // Mismo conteo repetido (doble envío): el mismo arqueo.
    const again = await countCash("0")
    expect(again.replayed).toBe(true)
    const p = await buildClosurePreview(prisma, sessionId)
    expect(p.readiness.ready).toBe(true)
    const k = key()
    const results = await Promise.allSettled([
      confirmClosure(admin, sessionId, {
        idempotencyKey: k,
        previewHash: p.previewHash,
      }),
      confirmClosure(admin, sessionId, {
        idempotencyKey: k,
        previewHash: p.previewHash,
      }),
      confirmClosure(partner, sessionId, {
        idempotencyKey: key(),
        previewHash: p.previewHash,
      }),
    ])
    expect(results.some((r) => r.status === "fulfilled")).toBe(true)
    expect(await status()).toBe("CLOSED")
    expect(await prisma.closureReport.count()).toBe(1)
    expect(await prisma.closureApproval.count()).toBe(1)
    expect(await auditRows("SESSION_CLOSED")).toHaveLength(1)
    const approval = await prisma.closureApproval.findFirstOrThrow()
    const replay = await confirmClosure(admin, sessionId, {
      idempotencyKey: approval.idempotencyKey,
      previewHash: p.previewHash,
    })
    expect(replay.replayed).toBe(true)
  })

  it("retiro final duplicado (misma clave o simultáneo) se registra una sola vez", async () => {
    await openTables()
    const a = await seat(t25)
    await cashBuy(a.participationId, "3000")
    await settle(a.participationId, "1000", "1000")
    await closeTable(t25)
    await closeTable(t10)
    await start()
    await countChips(196)
    await countCash("2000")
    const k = key()
    const results = await Promise.allSettled([
      withdraw("2000", "Socio", k),
      withdraw("2000", "Socio", k),
      withdraw("2000", "Otro"),
    ])
    expect(results.some((r) => r.status === "fulfilled")).toBe(true)
    expect(await prisma.closureCashWithdrawal.count()).toBe(1)
    expect(
      await prisma.cashTransaction.count({
        where: { withdrawalDestination: "SESSION_CLOSING" },
      })
    ).toBe(1)
    expect(await cash()).toBe("0.00")
    const done = await prisma.closureCashWithdrawal.findFirstOrThrow()
    expect(
      (await withdraw("2000", done.recipientName, done.idempotencyKey)).replayed
    ).toBe(true)
  })

  it("un movimiento relevante posterior al resumen invalida la confirmación (nueva revisión)", async () => {
    await openTables()
    const a = await seat(t25)
    await creditBuy(a.participationId, "3000")
    // Abono por transferencia anunciado en la sesión (pendiente de verificar).
    const { paymentId } = await registerPayment(cashier, {
      playerId: a.playerId,
      amount: "1000",
      origin: "SESSION",
      method: "BANK_TRANSFER",
      bankReference: "SPEI-PEND",
      idempotencyKey: key(),
    } as Parameters<typeof registerPayment>[1])
    await settle(a.participationId, "3000")
    await closeTable(t25)
    await closeTable(t10)
    await start()
    await countChips(200)
    await countCash("0")
    const p = await buildClosurePreview(prisma, sessionId)
    expect(
      p.precheck.findings.find((f) => f.code === "INCOMING_TRANSFERS_PENDING")
        ?.severity
    ).toBe("WARNING")
    const transfer = await prisma.receivablePayment.findUniqueOrThrow({
      where: { id: paymentId },
      select: { bankTransferId: true },
    })
    await confirmBankTransfer(cashier, transfer.bankTransferId!, {
      verifiedInBank: true,
    })
    await expect(
      confirmClosure(partner, sessionId, {
        idempotencyKey: key(),
        previewHash: p.previewHash,
      })
    ).rejects.toThrow(/revísalo de nuevo/)
    expect(await status()).toBe("CLOSING")
    await confirmAs(partner)
    expect(await status()).toBe("CLOSED")
  })

  it("transferencias y terminal pendientes conservan su estado real tras el cierre", async () => {
    await openTables()
    const a = await seat(t25)
    await creditBuy(a.participationId, "2000")
    const { paymentId } = await registerPayment(cashier, {
      playerId: a.playerId,
      amount: "500",
      origin: "SESSION",
      method: "BANK_TRANSFER",
      bankReference: "SPEI-LATER",
      idempotencyKey: key(),
    } as Parameters<typeof registerPayment>[1])
    await settle(a.participationId, "2000")
    await closeTable(t25)
    await closeTable(t10)
    await start()
    await countChips(200)
    await countCash("0")
    await confirmAs(partner)
    const t = await prisma.bankTransferVerification.findFirstOrThrow({
      where: { receivablePayment: { id: paymentId } },
    })
    expect(t.status).toBe("PENDING_VERIFICATION")
    expect(
      (await getClosureReport(sessionId)).content.bank.incomingPending
    ).toBe("500.00")
    // Se verifica después, sin reabrir la sesión ni tocar su caja.
    await confirmBankTransfer(cashier, t.id, { verifiedInBank: true })
    expect(await cash()).toBe("0.00")
    expect(
      (await receivablesOf(prisma, a.playerId)).map((r) => r.balance.toFixed(2))
    ).toEqual(["1500.00"])
  })
})

describe("diferencias físicas y ajustes", () => {
  async function closingWithChipShortage() {
    await openTables()
    const a = await seat(t25)
    await cashBuy(a.participationId, "1000")
    await settle(a.participationId, "1000", "1000")
    await closeTable(t25)
    await closeTable(t10)
    await start()
    return countChips(199) // falta una ficha de $500
  }

  it("una diferencia física bloquea el cierre; CASHIER no autoriza el ajuste; PARTNER sí, sin ocultar la diferencia original", async () => {
    const count = await closingWithChipShortage()
    expect(count).toMatchObject({
      reconciliationStatus: "PENDING",
      differenceTotal: "-500.00",
    })
    const [d] = await prisma.closureDiscrepancy.findMany()
    expect(d).toMatchObject({
      kind: "CHIP_INVENTORY",
      status: "OPEN",
      differenceAmount: D("-500"),
    })
    await countCash("0")
    const p = await buildClosurePreview(prisma, sessionId)
    expect(
      p.readiness.checks.find((c) => c.id === "CHIP_DIFFERENCES")?.ok
    ).toBe(false)
    await expect(confirmAs(partner)).rejects.toThrow(/no puede confirmarse/)

    await expect(
      resolveDiscrepancy(cashier, sessionId, d.id, {
        action: "authorize-adjustment",
        idempotencyKey: key(),
        reason: "Faltante tras investigar",
      })
    ).rejects.toThrow(/socio o un superadministrador/)
    signInAs({ ...cashier._user, isActive: true })
    const denied = await call(resolveRoute.POST, {
      method: "POST",
      params: { id: sessionId, discrepancyId: d.id },
      body: {
        action: "authorize-adjustment",
        idempotencyKey: key(),
        reason: "Faltante tras investigar",
      },
    })
    expect(denied.status).toBe(403)
    // El cajero sí documenta la investigación.
    await resolveDiscrepancy(cashier, sessionId, d.id, {
      action: "note",
      notes: "Se revisó el maletín y la mesa",
    })

    const k = key()
    const input = {
      action: "authorize-adjustment" as const,
      idempotencyKey: k,
      reason: "Ficha extraviada confirmada",
    }
    await Promise.allSettled([
      resolveDiscrepancy(partner, sessionId, d.id, input),
      resolveDiscrepancy(partner, sessionId, d.id, input),
      resolveDiscrepancy(partner, sessionId, d.id, {
        ...input,
        idempotencyKey: key(),
      }),
    ])
    expect(await prisma.closureAdjustmentAuthorization.count()).toBe(1)
    expect(
      await prisma.chipInventoryOperation.count({
        where: { type: "COUNT_RECONCILIATION" },
      })
    ).toBe(1)
    const resolved = await prisma.closureDiscrepancy.findUniqueOrThrow({
      where: { id: d.id },
      include: { adjustment: true },
    })
    expect(resolved).toMatchObject({
      status: "RESOLVED",
      resolution: "AUTHORIZED_ADJUSTMENT",
      differenceAmount: D("-500"),
      expectedAmount: D("100000"),
      countedAmount: D("99500"),
    })
    expect(resolved.investigationNotes).toMatch(/maletín/)
    expect(resolved.adjustment).toMatchObject({
      authorizedById: partner.id,
      amount: D("-500"),
    })
    // El arqueo original conserva su diferencia.
    const original = await prisma.chipStockCount.findUniqueOrThrow({
      where: { id: count.id },
    })
    expect(original.differenceTotal.toFixed(2)).toBe("-500.00")
    expect(original.reconciliationStatus).toBe("RECONCILED")
    await expect(
      prisma.$executeRaw`UPDATE "closure_discrepancies" SET "differenceAmount" = 0 WHERE "id" = ${d.id}`
    ).rejects.toThrow()

    await confirmAs(partner)
    expect(await status()).toBe("CLOSED")
    expect(
      (await getClosureReport(sessionId)).content.inventory.adjustments
    ).toEqual([
      {
        amount: "-500.00",
        reason: "Ficha extraviada confirmada",
        authorizedBy: partner.name,
      },
    ])
    expect(await auditRows("INVENTORY_ADJUSTMENT_AUTHORIZED")).toHaveLength(1)
    expect(await auditRows("INVENTORY_DISCREPANCY_DETECTED")).toHaveLength(1)
  })

  it("un recuento físico resuelve la diferencia (RECOUNT) y conserva el arqueo original", async () => {
    const first = await closingWithChipShortage()
    const recount = await countChips(200)
    expect(recount.reconciliationStatus).toBe("NOT_REQUIRED")
    const original = await prisma.chipStockCount.findUniqueOrThrow({
      where: { id: first.id },
    })
    expect(original.reconciliationStatus).toBe("SUPERSEDED")
    expect(original.differenceTotal.toFixed(2)).toBe("-500.00")
    const [d] = await prisma.closureDiscrepancy.findMany()
    expect(d).toMatchObject({
      status: "RESOLVED",
      resolution: "RECOUNT",
      recountChipStockCountId: recount.id,
    })
    expect(
      await prisma.chipInventoryOperation.count({
        where: { type: "COUNT_RECONCILIATION" },
      })
    ).toBe(0)
    await countCash("0")
    await confirmAs(admin)
    expect(await status()).toBe("CLOSED")
  })

  it("diferencia de efectivo: exige explicación, bloquea y se resuelve con ajuste autorizado; caja final en $0", async () => {
    await openTables()
    const a = await seat(t25)
    await cashBuy(a.participationId, "1000")
    await settle(a.participationId, "1000")
    await closeTable(t25)
    await closeTable(t10)
    await start()
    await countChips(200)
    await expect(countCash("950")).rejects.toThrow(/explica/)
    await countCash("950", "Faltan $50 tras recontar")
    const [d] = await prisma.closureDiscrepancy.findMany({
      where: { kind: "CASH" },
    })
    expect(d.differenceAmount.toFixed(2)).toBe("-50.00")
    await expect(withdraw("950")).rejects.toThrow(/diferencias sin resolver/)
    await resolveDiscrepancy(partner, sessionId, d.id, {
      action: "authorize-adjustment",
      idempotencyKey: key(),
      reason: "Faltante de efectivo documentado",
    })
    expect(await cash()).toBe("950.00")
    await withdraw("950")
    expect(await cash()).toBe("0.00")
    await confirmAs(partner)
    const r = await getClosureReport(sessionId)
    expect(r.content.cash).toMatchObject({
      expected: "1000.00",
      counted: "950.00",
      difference: "-50.00",
      final: "0.00",
    })
    expect(await auditRows("CASH_ADJUSTMENT_AUTHORIZED")).toHaveLength(1)
  })
})

describe("regreso CLOSING → OPEN", () => {
  it("exige motivo, conserva evidencia, invalida el intento y no reabre ciclos cerrados", async () => {
    await openTables()
    const a = await seat(t25)
    await cashBuy(a.participationId, "1000")
    await settle(a.participationId, "1000", "1000")
    await closeTable(t25)
    await closeTable(t10)
    await start()
    const count = await countChips(199) // diferencia pendiente
    await countCash("0")
    await expect(
      returnToOpen(cashier, sessionId, { idempotencyKey: key(), reason: "x" })
    ).rejects.toThrow()
    const forgottenAt = new Date(Date.now() - 30 * 60_000).toISOString()
    await returnToOpen(cashier, sessionId, {
      idempotencyKey: key(),
      reason: "Faltó registrar una recompra real",
      forgottenOperationAt: forgottenAt,
    })
    expect(await status()).toBe("OPEN")
    const closure = await prisma.sessionClosure.findFirstOrThrow()
    expect(closure).toMatchObject({
      status: "RETURNED_TO_OPEN",
      returnReason: "Faltó registrar una recompra real",
      returnedById: cashier.id,
    })
    expect(closure.forgottenOperationAt?.toISOString()).toBe(forgottenAt)
    // Evidencia conservada; la diferencia queda sustituida, sin ajuste.
    const kept = await prisma.chipStockCount.findUniqueOrThrow({
      where: { id: count.id },
    })
    expect(kept.status).toBe("CONFIRMED")
    expect(kept.reconciliationStatus).toBe("SUPERSEDED")
    const [d] = await prisma.closureDiscrepancy.findMany()
    expect(d.resolution).toBe("RETURNED_TO_OPEN")
    // Los ciclos cerrados NO se reabren solos.
    expect(
      await prisma.sessionTableCycle.count({ where: { status: "OPEN" } })
    ).toBe(0)
    expect(await auditRows("SESSION_RETURNED_TO_OPEN")).toHaveLength(1)
    expect(await auditRows("SESSION_CLOSING_ABORTED")).toHaveLength(1)

    // Se habilita la operación de OPEN (mesa nueva = ciclo nuevo).
    await openSessionTable(cashier, sessionId, t25, { idempotencyKey: key() })
    const b = await seat(t25)
    await cashBuy(b.participationId, "500")
    await settle(b.participationId, "500", "500")
    await closeTable(t25)
    // El nuevo cierre exige un arqueo nuevo (el anterior quedó obsoleto).
    await start()
    const p = await buildClosurePreview(prisma, sessionId)
    expect(p.inventory.count).toBeNull()
    expect(p.closure?.attemptNumber).toBe(2)
    await countChips(199)
    await prisma.closureDiscrepancy.findFirstOrThrow({
      where: { status: "OPEN" },
    })
    await countChips(200)
    await countCash("0")
    await confirmAs(partner)
    expect(await status()).toBe("CLOSED")
    const report = await getClosureReport(sessionId)
    expect(report.content.attempts.map((x) => x.status)).toEqual([
      "RETURNED_TO_OPEN",
      "COMPLETED",
    ])
    // Una sesión CLOSED no regresa a OPEN.
    await expect(
      returnToOpen(partner, sessionId, {
        idempotencyKey: key(),
        reason: "Intento de reabrir una sesión cerrada",
      })
    ).rejects.toThrow()
    expect(await status()).toBe("CLOSED")
  })
})

describe("cierre sin actividad", () => {
  it("sesión sin mesas: motivo obligatorio, reporte sin actividad y caja en $0", async () => {
    const p0 = await computePrecheck(prisma, sessionId)
    expect(p0.kind).toBe("NO_ACTIVITY")
    signInAs({ ...cashier._user, isActive: true })
    const started = await call(startRoute.POST, {
      method: "POST",
      params: { id: sessionId },
      body: { idempotencyKey: key() },
    })
    expect(started.status).toBe(200)
    const closure = await prisma.sessionClosure.findFirstOrThrow()
    expect(closure.kind).toBe("NO_ACTIVITY")
    await countCash("0")
    // El arqueo de apertura sigue vigente: no hubo movimientos de fichas.
    const p = await buildClosurePreview(prisma, sessionId)
    expect(p.inventory.openingCountCurrent).toBe(true)
    await expect(confirmAs(partner)).rejects.toThrow(/motivo/)
    await confirmAs(partner, { noActivityReason: "No llegaron jugadores" })
    expect(await status()).toBe("CLOSED")
    const r = await getClosureReport(sessionId)
    expect(r.content).toMatchObject({
      kind: "NO_ACTIVITY",
      noActivityReason: "No llegaron jugadores",
      tables: { operated: 0 },
      cash: { final: "0.00", withdrawal: null },
    })
    expect(await auditRows("SESSION_CLOSED_WITHOUT_ACTIVITY")).toHaveLength(1)
    expect(await auditRows("SESSION_CLOSED")).toHaveLength(0)
    // No se usó CANCELLED como sustituto.
    expect(
      await prisma.sessionStatusHistory.count({
        where: { toStatus: "CANCELLED" },
      })
    ).toBe(0)
  })
})

describe("circulación global entre sesiones", () => {
  it("una diferencia autorizada (no recuperada) persiste fuera de custodia, no bloquea la siguiente apertura y no se duplica", async () => {
    await openTables()
    const a = await seat(t25)
    await cashBuy(a.participationId, "3000")
    await settle(a.participationId, "1000", "1000") // $2,000 no retornados
    await closeTable(t25)
    await closeTable(t10)
    await start()
    await countChips(196)
    await countCash("2000")
    await withdraw("2000")
    // Conciliación global: todos terminaron y faltan fichas que el arqueo
    // NO encontró → bloquea hasta que un socio documente y autorice.
    expect(
      (await computePrecheck(prisma, sessionId)).findings.find(
        (f) => f.code === "SESSION_NOMINAL_DIFFERENCE"
      )?.severity
    ).toBe("BLOCKING")
    await reconcileSessionChips(partner, sessionId, {
      kind: "UNRECOVERED_AUTHORIZED",
      reason: "Fichas no localizadas tras la revisión del cierre",
      idempotencyKey: key(),
    })
    await confirmAs(partner)
    expect(await nominal()).toEqual({
      custody: "98000.00",
      circulation: "2000.00",
    })
    // La siguiente sesión abre aunque haya circulación (se informa).
    const next = await openRealSession()
    const checklist = await getOpeningChecklist(next, cashier)
    expect(
      checklist.steps.find((s) => s.id === "NO_PENDING_CIRCULATION")?.status
    ).toBe("DONE")
    expect(await status(next)).toBe("OPEN")
    // En la nueva sesión la circulación global se arrastra, pero el neto de
    // la sesión es solo lo suyo (sin doble conteo de fichas antiguas).
    const pre = await computePrecheck(prisma, next)
    expect(
      pre.findings.find((f) => f.code === "GLOBAL_CIRCULATION")?.amount
    ).toBe("2000.00")
    expect(
      pre.findings.find((f) => f.code === "SESSION_NOMINAL_DIFFERENCE")
    ).toBeUndefined()
    // Nunca se reconoció como ingreso: ningún asiento financiero por fichas.
    expect(
      await prisma.cashTransaction.count({
        where: { reason: { contains: "ficha" } },
      })
    ).toBe(0)
  })
})
