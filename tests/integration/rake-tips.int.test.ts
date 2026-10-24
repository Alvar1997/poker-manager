import { randomUUID } from "node:crypto"

import { beforeEach, describe, expect, it } from "vitest"

import { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { cashBalanceOf } from "@/modules/cash/ledger"
import { getSessionChipReconciliation } from "@/modules/closure/chip-circulation.service"
import {
  buildClosurePreview,
  computePrecheck,
} from "@/modules/closure/closure.data"
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
import {
  confirmRakeCount,
  getTableRake,
  recordRakeCorrection,
  recordRakeEntry,
  setTableRakeMode,
} from "@/modules/rake/rake.service"
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
import { createStaff, listPositions } from "@/modules/staff-tips/staff.service"
import {
  addStaffToSession,
  confirmTipCount,
  correctTipCount,
  getSessionTips,
  recordPartialTip,
  saveTipCountDraft,
} from "@/modules/staff-tips/tips.service"

import {
  auditRows,
  createTestPlayer,
  createUser,
  resetDatabase,
} from "./helpers"

/**
 * Módulo 18 (simplificado) con la base de PRUEBAS y los servicios reales:
 * rake por mesa (manual y conteo final), propinas por empleado, fórmula
 * global (entregado = jugadores + rake + propinas + diferencia) y cierre
 * con diferencia: advertencia, motivo obligatorio, CASHIER confirma, sin
 * ajustes ficticios; diferencia física independiente.
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

let cashier: Actor
let partner: Actor
let t25: string
let t10: string
let denominationId: string
let sessionId: string

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
  await openSessionTable(cashier, s.id, t25, { idempotencyKey: key() })
  await openSessionTable(cashier, s.id, t10, { idempotencyKey: key() })
  return s.id
}

beforeEach(async () => {
  await resetDatabase()
  const shared = await prisma.chipSet.findUniqueOrThrow({
    where: { code: "CHIPSET_MAIN" },
  })
  // Fichas de $25: permite diferencias como +$25 o −$100.
  denominationId = (
    await prisma.chipDenomination.create({
      data: { chipSetId: shared.id, value: "25" },
    })
  ).id
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
  sessionId = await openRealSession()
})

async function seat(tableId: string) {
  const p = await createTestPlayer()
  const { participationId } = await addPlayerToTable(
    cashier,
    sessionId,
    tableId,
    {
      playerId: p.id,
      idempotencyKey: key(),
    }
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
}

/** Liquidación SIN pago inmediato (la cuenta por pagar sobrevive). */
async function settle(participationId: string, returned: string) {
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
    ...(Number(returned) > 0
      ? { chipsReceived: true as const }
      : { zeroReturnConfirmed: true as const }),
    idempotencyKey: key(),
  })
}

async function cycleOf(tableId: string) {
  return prisma.sessionTableCycle.findFirstOrThrow({
    where: { sessionTable: { sessionId, tableId } },
    orderBy: { cycleNumber: "desc" },
  })
}

async function staffIn(name: string, code = "DEALER") {
  const positions = await listPositions()
  const m = await createStaff(cashier, {
    name,
    positionId: positions.find((p) => p.code === code)!.id,
  })
  return (await addStaffToSession(cashier, sessionId, m.id)).id
}

async function tip(sessionStaffId: string, amount: string) {
  const d = await saveTipCountDraft(cashier, sessionId, sessionStaffId, {
    amount,
  })
  await confirmTipCount(cashier, sessionId, sessionStaffId, {
    expectedVersion: d.version,
    amount,
    physicallyReceived: true,
    ...(D(amount).isZero() ? { zeroConfirmed: true as const } : {}),
  })
}

/**
 * Noche: compras de 100,000 en ambas mesas, devoluciones 80,000, rake
 * 10/10 manual 4,000 + 25/25 conteo final 8,000 = 12,000 y las propinas
 * indicadas. Deja las mesas cerradas.
 */
async function night(tipAmounts: string[]) {
  const a = await seat(t25)
  const b = await seat(t25)
  const c = await seat(t10)
  const d = await seat(t10)
  await cashBuy(a.participationId, "30000")
  await cashBuy(b.participationId, "30000")
  await cashBuy(c.participationId, "20000")
  await cashBuy(d.participationId, "20000")
  for (const amount of ["1000", "1500", "1500"])
    await recordRakeEntry(cashier, sessionId, t10, {
      amount,
      idempotencyKey: key(),
    })
  for (const [i, amount] of tipAmounts.entries())
    await tip(await staffIn(`Empleado ${i + 1}`), amount)
  await settle(a.participationId, "26000")
  await settle(b.participationId, "20000")
  await settle(c.participationId, "19000")
  await settle(d.participationId, "15000")
  await closeSessionTable(cashier, sessionId, t25, { idempotencyKey: key() })
  await closeSessionTable(cashier, sessionId, t10, { idempotencyKey: key() })
  await confirmRakeCount(cashier, sessionId, t25, {
    cycleId: (await cycleOf(t25)).id,
    countedAmount: "8000",
    physicallyCounted: true,
    idempotencyKey: key(),
  })
}

/** Cierre completo: arqueo global (chips = custodia esperada + offset), caja y retiro. */
async function prepareClosing(chipOffset = 0) {
  await startClosing(cashier, sessionId, { idempotencyKey: key() })
  const { count } = await startClosingChipCount(cashier, sessionId)
  const state = await prisma.chipSetInventoryState.findFirstOrThrow()
  const quantity = D(state.custodyNominal).div(25).toNumber() + chipOffset
  await updateStockCount(cashier, count.id, {
    lines: [{ denominationId, countedQuantity: quantity }],
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

async function confirmAs(actor: Actor, differenceReason?: string) {
  const p = await buildClosurePreview(prisma, sessionId)
  return confirmClosure(actor, sessionId, {
    idempotencyKey: key(),
    previewHash: p.previewHash,
    ...(differenceReason ? { differenceReason } : {}),
  })
}

const sessionStatus = async () =>
  (await prisma.pokerSession.findUniqueOrThrow({ where: { id: sessionId } }))
    .status

describe("rake por mesa", () => {
  it("D: 10/10 manual 3,000 (acumulado y hora del servidor) + 25/25 conteo final 8,000 = 11,000", async () => {
    const p = await seat(t10)
    await cashBuy(p.participationId, "20000")
    const before = new Date()
    for (const amount of ["1000", "1000", "1000"])
      await recordRakeEntry(cashier, sessionId, t10, {
        amount,
        idempotencyKey: key(),
      })
    const k = key()
    await recordRakeEntry(cashier, sessionId, t10, {
      amount: "50",
      idempotencyKey: k,
    })
    await recordRakeEntry(cashier, sessionId, t10, {
      amount: "50",
      idempotencyKey: k,
    })
    const corr = await prisma.rakeMovement.findFirstOrThrow({
      where: { idempotencyKey: k },
    })
    // Corrección auditable del registro de 50 (captura duplicada).
    await recordRakeCorrection(cashier, sessionId, t10, {
      cycleId: (await cycleOf(t10)).id,
      movementId: corr.id,
      amount: "-50",
      reason: "Captura de prueba que no correspondía",
      idempotencyKey: key(),
    })
    const view = await getTableRake(sessionId, t10)
    expect(view.cycles[0].movements.map((m) => m.cumulative)).toEqual([
      "1000.00",
      "2000.00",
      "3000.00",
      "3050.00",
      "3000.00",
    ])
    expect(new Date(view.cycles[0].movements[0].recordedAt) >= before).toBe(
      true
    )
    expect(view.totals.recognized).toBe("3000.00")
    // 25/25 en conteo final: no admite capturas manuales.
    await expect(
      recordRakeEntry(cashier, sessionId, t25, {
        amount: "25",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/conteo final/)
    await settle(p.participationId, "9000")
    await closeSessionTable(cashier, sessionId, t25, { idempotencyKey: key() })
    await closeSessionTable(cashier, sessionId, t10, { idempotencyKey: key() })
    // Reapertura de 25/25: ciclo nuevo; el recipiente se cuenta al cerrarla.
    await openSessionTable(cashier, sessionId, t25, { idempotencyKey: key() })
    const r = await seat(t25)
    await cashBuy(r.participationId, "10000")
    await settle(r.participationId, "2000")
    await closeSessionTable(cashier, sessionId, t25, { idempotencyKey: key() })
    await confirmRakeCount(cashier, sessionId, t25, {
      cycleId: (await cycleOf(t25)).id,
      countedAmount: "8000",
      physicallyCounted: true,
      idempotencyKey: key(),
    })
    await expect(
      confirmRakeCount(cashier, sessionId, t25, {
        cycleId: (await cycleOf(t25)).id,
        countedAmount: "8000",
        physicallyCounted: true,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/ya se contó/)
    // Comprobación del recipiente manual: 2,975 contado vs 3,000 registrado.
    const check = await confirmRakeCount(cashier, sessionId, t10, {
      cycleId: (await cycleOf(t10)).id,
      countedAmount: "2975",
      physicallyCounted: true,
      idempotencyKey: key(),
    })
    expect(check.difference).toBe("-25.00")
    const rec = await getSessionChipReconciliation(prisma, sessionId)
    expect(rec.rake.recognized.toFixed(2)).toBe("11000.00")
    expect(rec.breakdown.rake.toFixed(2)).toBe("11000.00")
    expect(rec.rake.cyclesWithDifference).toBe(1)
    // Reapertura: el ciclo anterior de 25/25 conserva su rake.
    const v25 = await getTableRake(sessionId, t25)
    expect(v25.cycles.map((c) => c.recognized)).toEqual(["0.00", "8000.00"])
    // Rake nominal: no hay ninguna entrada de efectivo por rake.
    expect(
      await prisma.cashTransaction.count({
        where: { referenceType: { contains: "Rake" } },
      })
    ).toBe(0)
  })

  it("manual sin capturas: el conteo de comprobación muestra la diferencia y una corrección contra el conteo la reconoce como rake", async () => {
    const p = await seat(t10)
    await cashBuy(p.participationId, "20000")
    await settle(p.participationId, "4050")
    await closeSessionTable(cashier, sessionId, t10, { idempotencyKey: key() })
    const cycleId = (await cycleOf(t10)).id
    await confirmRakeCount(cashier, sessionId, t10, {
      cycleId,
      countedAmount: "15950",
      physicallyCounted: true,
      idempotencyKey: key(),
    })
    let view = await getTableRake(sessionId, t10)
    expect(view.cycles[0]).toMatchObject({
      rakeStatus: "DIFFERENCE",
      recognized: "0.00",
      difference: "15950.00",
    })
    await recordRakeCorrection(cashier, sessionId, t10, {
      cycleId,
      amount: "15950",
      reason: "Rake contado en el recipiente sin capturas durante la mesa",
      idempotencyKey: key(),
    })
    view = await getTableRake(sessionId, t10)
    expect(view.cycles[0]).toMatchObject({
      rakeStatus: "RECONCILED",
      recognized: "15950.00",
      difference: "0.00",
    })
    const rec = await getSessionChipReconciliation(prisma, sessionId)
    expect(rec.breakdown.rake.toFixed(2)).toBe("15950.00")
    expect(rec.difference.toFixed(2)).toBe("0.00")
  })

  it("modalidad configurable en ambas mesas; el cambio requiere la mesa cerrada y PARTNER/SUPERADMIN", async () => {
    await expect(
      setTableRakeMode(cashier, t10, {
        mode: "FINAL_COUNT",
        reason: "Cambio de prueba",
      })
    ).rejects.toThrow(/PARTNER o SUPERADMIN/)
    await expect(
      setTableRakeMode(partner, t10, {
        mode: "FINAL_COUNT",
        reason: "Cambio de prueba",
      })
    ).rejects.toThrow(/mesa está abierta/)
    await closeSessionTable(cashier, sessionId, t10, { idempotencyKey: key() })
    await closeSessionTable(cashier, sessionId, t25, { idempotencyKey: key() })
    expect(
      await setTableRakeMode(partner, t10, {
        mode: "FINAL_COUNT",
        reason: "Cambio de prueba",
      })
    ).toMatchObject({ changed: true })
    expect(
      await setTableRakeMode(partner, t25, {
        mode: "MANUAL",
        reason: "Cambio de prueba",
      })
    ).toMatchObject({ changed: true })
  })
})

describe("propinas por empleado", () => {
  it("E: Carlos 1,500 · Mario 1,000 · Pedro 800 · Ana 700 = 4,000; parciales y borradores no se suman; sin duplicar", async () => {
    const p = await seat(t25)
    await cashBuy(p.participationId, "10000")
    const carlos = await staffIn("Carlos")
    const mario = await staffIn("Mario")
    const pedro = await staffIn("Pedro", "WAITER")
    const ana = await staffIn("Ana", "WAITER")
    const nadie = await staffIn("Luis", "OTHER")
    // Parcial informativo durante la noche (no cuenta).
    await recordPartialTip(cashier, sessionId, carlos, {
      amount: "500",
      idempotencyKey: key(),
    })
    // Borrador editable, luego confirmado una sola vez.
    let d = await saveTipCountDraft(cashier, sessionId, carlos, {
      amount: "1400",
    })
    d = await saveTipCountDraft(cashier, sessionId, carlos, {
      amount: "1500",
      expectedVersion: d.version,
    })
    await expect(
      confirmTipCount(cashier, sessionId, carlos, {
        expectedVersion: d.version,
        amount: "1400",
        physicallyReceived: true,
      })
    ).rejects.toThrow(/cambió/)
    await confirmTipCount(cashier, sessionId, carlos, {
      expectedVersion: d.version,
      amount: "1500",
      physicallyReceived: true,
    })
    // Reintento idempotente: no duplica la entrada de fichas.
    const ops = await prisma.chipInventoryOperation.count()
    expect(
      await confirmTipCount(cashier, sessionId, carlos, {
        expectedVersion: d.version,
        amount: "1500",
        physicallyReceived: true,
      })
    ).toEqual({ replayed: true })
    expect(await prisma.chipInventoryOperation.count()).toBe(ops)
    await tip(mario, "1000")
    await tip(pedro, "800")
    await saveTipCountDraft(cashier, sessionId, ana, { amount: "700" })
    let t = await getSessionTips(sessionId)
    expect(t.total).toBe("3300.00")
    expect(t.unconfirmed).toBe(2)
    const anaRow = t.staff.find((s) => s.id === ana)!
    await confirmTipCount(cashier, sessionId, ana, {
      expectedVersion: anaRow.version!,
      amount: "700",
      physicallyReceived: true,
    })
    // Empleado con $0: confirmación explícita.
    const z = await saveTipCountDraft(cashier, sessionId, nadie, {
      amount: "0",
    })
    await expect(
      confirmTipCount(cashier, sessionId, nadie, {
        expectedVersion: z.version,
        amount: "0",
        physicallyReceived: true,
      })
    ).rejects.toThrow(/\$0/)
    await tip(nadie, "0")
    t = await getSessionTips(sessionId)
    expect(t.total).toBe("4000.00")
    expect(t.unconfirmed).toBe(0)
    const carlosRow = t.staff.find((s) => s.id === carlos)!
    expect(carlosRow).toMatchObject({
      partials: "500.00",
      recognized: "1500.00",
      countVsPartials: "1000.00",
    })
    // Corrección auditable (original conservado).
    await expect(
      saveTipCountDraft(cashier, sessionId, carlos, { amount: "1475" })
    ).rejects.toThrow(/corrección/)
    await correctTipCount(cashier, sessionId, carlos, {
      amount: "-25",
      reason: "Una ficha era del rake de la mesa",
      idempotencyKey: key(),
    })
    t = await getSessionTips(sessionId)
    expect(t.staff.find((s) => s.id === carlos)).toMatchObject({
      confirmedCount: "1500.00",
      corrections: "-25.00",
      recognized: "1475.00",
    })
    expect(t.total).toBe("3975.00")
    const rec = await getSessionChipReconciliation(prisma, sessionId)
    expect(rec.breakdown.tips.toFixed(2)).toBe("3975.00")
    // Las propinas no son dinero de la casa.
    expect((await cashBalanceOf(prisma, sessionId)).balance.toFixed(2)).toBe(
      "10000.00"
    )
    expect((await auditRows("STAFF_TIP_CORRECTED")).length).toBe(1)
  })
})

describe("conciliación global y cierre con diferencia", () => {
  it("A: todo cuadra (100,000 = 80,000 + 12,000 + 8,000): cierre normal sin motivo", async () => {
    await night(["3000", "2500", "1500", "1000"])
    const rec = await getSessionChipReconciliation(prisma, sessionId)
    expect(
      [
        rec.delivered,
        rec.breakdown.players,
        rec.breakdown.rake,
        rec.breakdown.tips,
        rec.difference,
      ].map((x) => x.toFixed(2))
    ).toEqual(["100000.00", "80000.00", "12000.00", "8000.00", "0.00"])
    expect(rec.status).toBe("RECONCILED")
    await prepareClosing()
    await confirmAs(cashier)
    expect(await sessionStatus()).toBe("CLOSED")
    expect(await prisma.sessionChipDifference.count()).toBe(0)
  })

  it("B: faltan $25 (propinas 7,975): advertencia, motivo obligatorio, CASHIER cierra, sin ajuste ficticio", async () => {
    await night(["3000", "2500", "1500", "975"])
    const pre = await computePrecheck(prisma, sessionId)
    const f = pre.findings.find((x) => x.code === "SESSION_NOMINAL_DIFFERENCE")!
    expect(f).toMatchObject({ severity: "WARNING", amount: "25.00" })
    expect(f.title).toMatch(/faltan \$25.00 por justificar/)
    await prepareClosing()
    // El arqueo físico cuadra: las 25 nominales faltan, no están en la caja.
    const preview = await buildClosurePreview(prisma, sessionId)
    expect(preview.inventory.position.physicalDifference).toBe("0.00")
    expect(preview.readiness.ready).toBe(true)
    const opsBefore = await prisma.chipInventoryOperation.count()
    const cashBefore = await prisma.cashTransaction.count()
    await expect(confirmAs(cashier)).rejects.toThrow(/motivo/)
    await confirmAs(cashier, "Propina que no quedó correctamente registrada")
    expect(await sessionStatus()).toBe("CLOSED")
    const diff = await prisma.sessionChipDifference.findFirstOrThrow()
    expect(diff.nominalDifference.toFixed(2)).toBe("25.00")
    expect(diff.tips.toFixed(2)).toBe("7975.00")
    expect(diff.reason).toBe("Propina que no quedó correctamente registrada")
    expect(diff.recordedById).toBe(cashier.id)
    // Sin movimientos de fichas ni dinero para «cuadrar».
    expect(await prisma.chipInventoryOperation.count()).toBe(opsBefore)
    // (el retiro final se registró antes de confirmar)
    expect(await prisma.cashTransaction.count()).toBe(cashBefore)
    expect(await prisma.closureAdjustmentAuthorization.count()).toBe(0)
    expect((await auditRows("SESSION_CLOSED_WITH_DIFFERENCE")).length).toBe(1)
    expect((await auditRows("CHIP_DIFFERENCE_RECORDED")).length).toBe(1)
    const report = await prisma.closureReport.findFirstOrThrow({
      where: { sessionId },
    })
    const content = report.content as {
      inventory: { chipReconciliation: Record<string, string> }
    }
    expect(content.inventory.chipReconciliation).toMatchObject({
      nominalDifference: "25.00",
      differenceReason: "Propina que no quedó correctamente registrada",
    })
    // Sesión CLOSED: inmutable para rake y propinas.
    await expect(
      recordRakeEntry(cashier, sessionId, t10, {
        amount: "25",
        cycleId: (await cycleOf(t10)).id,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/cerrada no se modifica/)
    const anyStaff = await prisma.sessionStaff.findFirstOrThrow({
      where: { sessionId },
    })
    await expect(
      correctTipCount(cashier, sessionId, anyStaff.id, {
        amount: "25",
        reason: "Intento posterior al cierre",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/cerrada no se modifica/)
  })

  it("C: sobran $100 (propinas 8,100 con fichas de una sesión anterior): advertencia y cierre con motivo", async () => {
    // Sesión anterior deja 100 en circulación (OUT sin devolución, cerrada con motivo).
    const prev = await seat(t25)
    await cashBuy(prev.participationId, "100")
    await settle(prev.participationId, "0")
    await closeSessionTable(cashier, sessionId, t25, { idempotencyKey: key() })
    await closeSessionTable(cashier, sessionId, t10, { idempotencyKey: key() })
    await confirmRakeCount(cashier, sessionId, t25, {
      cycleId: (await cycleOf(t25)).id,
      countedAmount: "0",
      zeroConfirmed: true,
      physicallyCounted: true,
      idempotencyKey: key(),
    })
    await prepareClosing()
    await confirmAs(cashier, "Posible ficha extraviada en la mesa 25/25")
    sessionId = await openRealSession()
    await night(["3000", "2500", "1500", "1100"])
    const rec = await getSessionChipReconciliation(prisma, sessionId)
    expect(rec.difference.toFixed(2)).toBe("-100.00")
    const pre = await computePrecheck(prisma, sessionId)
    const f = pre.findings.find((x) => x.code === "SESSION_NOMINAL_DIFFERENCE")!
    expect(f.severity).toBe("WARNING")
    expect(f.title).toMatch(/sobran \$100.00/)
    await prepareClosing()
    await expect(confirmAs(cashier)).rejects.toThrow(/motivo/)
    await confirmAs(cashier, "Diferencia detectada durante el conteo")
    expect(await sessionStatus()).toBe("CLOSED")
    const diffs = await prisma.sessionChipDifference.findMany({
      orderBy: { createdAt: "asc" },
    })
    expect(diffs.map((d) => d.nominalDifference.toFixed(2))).toEqual([
      "100.00",
      "-100.00",
    ])
  })

  it("F: cerrar con diferencia no cancela deudas de jugadores ni pagos pendientes", async () => {
    const a = await seat(t25)
    await creditBuy(a.participationId, "5000")
    await settle(a.participationId, "4975")
    await closeSessionTable(cashier, sessionId, t25, { idempotencyKey: key() })
    await closeSessionTable(cashier, sessionId, t10, { idempotencyKey: key() })
    await confirmRakeCount(cashier, sessionId, t25, {
      cycleId: (await cycleOf(t25)).id,
      countedAmount: "0",
      zeroConfirmed: true,
      physicallyCounted: true,
      idempotencyKey: key(),
    })
    const debtBefore = (await receivablesOf(prisma, a.playerId)).reduce(
      (x, r) => x.add(r.balance),
      D(0)
    )
    const payableBefore = await prisma.settlementPayable.findFirstOrThrow()
    await prepareClosing()
    await confirmAs(cashier, "Error de captura pendiente de aclarar")
    expect(await sessionStatus()).toBe("CLOSED")
    const debtAfter = (await receivablesOf(prisma, a.playerId)).reduce(
      (x, r) => x.add(r.balance),
      D(0)
    )
    expect(debtAfter.toFixed(2)).toBe(debtBefore.toFixed(2))
    expect(debtAfter.toFixed(2)).toBe("5000.00")
    const payableAfter = await prisma.settlementPayable.findFirstOrThrow()
    expect(payableAfter.status).toBe(payableBefore.status)
    expect(payableAfter.originalAmount.toFixed(2)).toBe("4975.00")
  })

  it("G: el arqueo físico no coincide: ambas diferencias por separado, motivo y cierre sin falsificar inventario", async () => {
    await night(["3000", "2500", "1500", "1000"])
    // Se cuentan 2 fichas de $25 MENOS que lo esperado.
    await prepareClosing(-2)
    const preview = await buildClosurePreview(prisma, sessionId)
    expect(preview.inventory.reconciliation.difference).toBe("0.00")
    expect(preview.inventory.position.physicalDifference).toBe("-50.00")
    expect(preview.readiness.ready).toBe(true)
    const custody = (await prisma.chipSetInventoryState.findFirstOrThrow())
      .custodyNominal
    await expect(confirmAs(cashier)).rejects.toThrow(/motivo/)
    await confirmAs(cashier, "Posible ficha extraviada durante el conteo")
    expect(await sessionStatus()).toBe("CLOSED")
    const diff = await prisma.sessionChipDifference.findFirstOrThrow()
    expect(diff.nominalDifference.toFixed(2)).toBe("0.00")
    expect(diff.physicalDifference?.toFixed(2)).toBe("-50.00")
    // Sin ajuste de inventario: la custodia del libro no cambió.
    expect(
      (
        await prisma.chipSetInventoryState.findFirstOrThrow()
      ).custodyNominal.toFixed(2)
    ).toBe(D(custody).toFixed(2))
    const count = await prisma.chipStockCount.findFirstOrThrow({
      where: { sessionId, countType: "CLOSING" },
    })
    expect(count.reconciliationStatus).toBe("ACCEPTED_WITH_DIFFERENCE")
    const disc = await prisma.closureDiscrepancy.findFirstOrThrow({
      where: { sessionId },
    })
    expect(disc).toMatchObject({
      status: "RESOLVED",
      resolution: "CLOSED_WITH_REASON",
    })
    expect(await prisma.closureAdjustmentAuthorization.count()).toBe(0)
    // La siguiente sesión puede prepararse (el arqueo aceptado no la bloquea).
    const next = await createSession(cashier, { idempotencyKey: key() })
    await prepareSession(cashier, next.id)
    const { count: opening } = await createOpeningChipCount(cashier, next.id)
    expect(opening.id).toBeTruthy()
  })

  it("reintentos de confirmación no duplican el cierre ni la diferencia", async () => {
    await night(["3000", "2500", "1500", "975"])
    await prepareClosing()
    const p = await buildClosurePreview(prisma, sessionId)
    const k = key()
    const input = {
      idempotencyKey: k,
      previewHash: p.previewHash,
      differenceReason: "Propina que no quedó correctamente registrada",
    }
    await Promise.allSettled([
      confirmClosure(cashier, sessionId, input),
      confirmClosure(cashier, sessionId, input),
    ])
    expect(await confirmClosure(cashier, sessionId, input)).toEqual({
      replayed: true,
    })
    expect(await prisma.sessionChipDifference.count()).toBe(1)
    expect(await prisma.closureReport.count({ where: { sessionId } })).toBe(1)
  })
})
