import { randomUUID } from "node:crypto"

import { beforeEach, describe, expect, it } from "vitest"

import * as reconcileRoute from "@/app/api/sessions/[id]/closure/chip-reconciliation/route"
import { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { createAgreement } from "@/modules/banking/agreement.service"
import {
  reconcileGame,
  recordFinancedPurchase,
} from "@/modules/banking/game.service"
import { cashBalanceOf } from "@/modules/cash/ledger"
import { getSessionChipReconciliation } from "@/modules/closure/chip-circulation.service"
import {
  buildClosurePreview,
  computePrecheck,
} from "@/modules/closure/closure.data"
import {
  confirmClosingChipCount,
  confirmClosure,
  reconcileSessionChips,
  recordClosingCashCount,
  registerFinalWithdrawal,
  startClosing,
  startClosingChipCount,
} from "@/modules/closure/closure.service"
import { integrityChecks } from "@/modules/integrity/integrity.checks"
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
import { getTableBoard } from "@/modules/table-floor/seat.service"

import {
  auditRows,
  call,
  createTestPlayer,
  createUser,
  resetDatabase,
  signInAs,
} from "./helpers"

/**
 * Corrección transversal — conciliación GLOBAL de fichas. Ningún jugador se
 * lleva fichas: lo que uno pierde lo gana otro y regresa en SU liquidación.
 * Noches REALES (apertura, mesas, compras, liquidaciones con firma y
 * recepción física, arqueo global, cierre del Módulo 12) en la base de
 * PRUEBAS. Inventario: 200 fichas de $500 = $100,000.
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
let denominationId: string
let t25: string
let t10: string
let sessionId: string

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
  sessionId = s.id
  await openSessionTable(cashier, sessionId, t25, { idempotencyKey: key() })
  await openSessionTable(cashier, sessionId, t10, { idempotencyKey: key() })
})

async function seat(name: string, tableId = t25) {
  const pid = (await createTestPlayer({ name })).id
  const r = await addPlayerToTable(cashier, sessionId, tableId, {
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
}

/** Liquidación completa: firma obligatoria + recepción física (o cero explícito). */
async function settle(
  participationId: string,
  returned: string,
  opts: { zero?: boolean; cash?: string } = {}
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
    ...((opts.zero ?? returned === "0") ? { zeroReturnConfirmed: true } : {}),
    ...(opts.cash
      ? { immediateCashAmount: opts.cash, cashDelivered: true }
      : {}),
    idempotencyKey: key(),
  })
  return settlementId
}

async function closeTables() {
  for (const t of [t25, t10])
    await closeSessionTable(cashier, sessionId, t, { idempotencyKey: key() })
}

/** Arqueo global de cierre: `chips` fichas de $500 contadas físicamente. */
async function countAtClose(chips: number) {
  const { count } = await startClosingChipCount(cashier, sessionId)
  await updateStockCount(cashier, count.id, {
    lines: [{ denominationId, countedQuantity: chips }],
  })
  await confirmClosingChipCount(cashier, sessionId, {
    countId: count.id,
    idempotencyKey: key(),
  })
}

async function finishCashAndConfirm(actor: Actor = partner) {
  const cash = (await cashBalanceOf(prisma, sessionId)).balance.toFixed(2)
  await recordClosingCashCount(cashier, sessionId, {
    countedAmount: cash,
    physicallyCounted: true,
  })
  if (D(cash).greaterThan(0))
    await registerFinalWithdrawal(cashier, sessionId, {
      idempotencyKey: key(),
      amount: cash,
      recipientName: "Socio receptor",
      physicallyDelivered: true,
    })
  const p = await buildClosurePreview(prisma, sessionId)
  return {
    preview: p,
    confirm: () =>
      confirmClosure(actor, sessionId, {
        idempotencyKey: key(),
        previewHash: p.previewHash,
      }),
  }
}

const codes = async () =>
  (await computePrecheck(prisma, sessionId)).findings.map((f) => ({
    code: f.code,
    severity: f.severity,
  }))
const status = async () =>
  (await prisma.pokerSession.findUniqueOrThrow({ where: { id: sessionId } }))
    .status

describe("ESCENARIO A — pérdidas de uno = ganancias de otro", () => {
  it("Juan 5,000 → 2,000 (−3,000); Pedro 5,000 → 8,000 (+3,000): balance $0, sin alerta de fichas pendientes, cierre normal", async () => {
    const juan = await seat("Juan")
    const pedro = await seat("Pedro")
    await cashBuy(juan.participationId, "5000")
    await cashBuy(pedro.participationId, "5000")
    // En juego: no es diferencia.
    expect(await codes()).toEqual(
      expect.arrayContaining([{ code: "CHIPS_IN_PLAY", severity: "INFO" }])
    )
    await settle(juan.participationId, "2000", { cash: "2000" })
    await settle(pedro.participationId, "8000", { cash: "8000" })
    const rec = await getSessionChipReconciliation(prisma, sessionId)
    expect(rec.status).toBe("RECONCILED")
    expect(rec.delivered.toFixed(2)).toBe("10000.00")
    expect(rec.returned.toFixed(2)).toBe("10000.00")
    const byPlayer = Object.fromEntries(
      rec.byPlayer.map((p) => [p.player.name, p.result])
    )
    expect(byPlayer).toEqual({ Juan: "-3000.00", Pedro: "3000.00" })
    await closeTables()
    const c = await codes()
    expect(c.map((x) => x.code)).not.toContain("SESSION_NOMINAL_DIFFERENCE")
    expect(c).toEqual(
      expect.arrayContaining([{ code: "CHIPS_RECONCILED", severity: "INFO" }])
    )
    await startClosing(cashier, sessionId, { idempotencyKey: key() })
    await countAtClose(200)
    const { preview, confirm } = await finishCashAndConfirm()
    expect(preview.readiness.ready).toBe(true)
    await confirm()
    expect(await status()).toBe("CLOSED")
    const inv = await prisma.chipSetInventoryState.findFirstOrThrow()
    expect(D(inv.circulationNominal).toFixed(2)).toBe("0.00")
    // Ningún ajuste ni retorno inventado.
    expect(
      await prisma.chipInventoryOperation.count({
        where: {
          type: { in: ["INVENTORY_ADJUSTMENT", "COUNT_RECONCILIATION"] },
        },
      })
    ).toBe(0)
    expect(await prisma.sessionChipReconciliation.count()).toBe(0)
    const report = await prisma.closureReport.findFirstOrThrow({
      where: { sessionId },
    })
    expect(JSON.stringify(report.content)).toMatch(/"status":"RECONCILED"/)
  })
})

describe("ESCENARIO B — retorno cero explícito", () => {
  it("Juan devuelve $0 (explícito, firmado); Pedro devuelve 10,000: sin fichas en circulación al cierre", async () => {
    const juan = await seat("Juan")
    const pedro = await seat("Pedro")
    await cashBuy(juan.participationId, "5000")
    await cashBuy(pedro.participationId, "5000")
    // Sin la confirmación expresa del cero: rechazado.
    const { settlementId } = await createSettlement(cashier, {
      participationId: juan.participationId,
      returnedNominalAmount: "0",
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
    await expect(
      confirmReturn(cashier, settlementId, {
        expectedVersion: s.version,
        chipsReceived: true,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/terminó sin fichas/)
    await confirmReturn(cashier, settlementId, {
      expectedVersion: s.version,
      chipsReceived: true,
      zeroReturnConfirmed: true,
      idempotencyKey: key(),
    })
    // Con $0 no hay entrada nominal artificial.
    expect(
      await prisma.chipInventoryOperation.count({
        where: { referenceType: "PlayerSettlement", referenceId: settlementId },
      })
    ).toBe(0)
    await settle(pedro.participationId, "10000", { cash: "10000" })
    await closeTables()
    expect((await getSessionChipReconciliation(prisma, sessionId)).status).toBe(
      "RECONCILED"
    )
    await startClosing(cashier, sessionId, { idempotencyKey: key() })
    await countAtClose(200)
    const { confirm } = await finishCashAndConfirm()
    await confirm()
    expect(await status()).toBe("CLOSED")
    const inv = await prisma.chipSetInventoryState.findFirstOrThrow()
    expect(D(inv.circulationNominal).toFixed(2)).toBe("0.00")
  })
})

describe("ESCENARIO C — diferencia real: 100,000 entregados, 95,000 devueltos", () => {
  async function night() {
    const players = []
    for (let i = 0; i < 4; i++)
      players.push(await seat(`Jugador ${i}`, i % 2 ? t10 : t25))
    for (const p of players) await cashBuy(p.participationId, "25000")
    // Devoluciones REGISTRADAS: 95,000 (una se capturó $5,000 de menos).
    await settle(players[0].participationId, "40000")
    await settle(players[1].participationId, "30000")
    await settle(players[2].participationId, "20000")
    await settle(players[3].participationId, "5000")
    await closeTables()
  }

  it("se detecta como diferencia por conciliar (no «en circulación»); bloquea; las fichas están en la caja → retorno identificado en el arqueo y recuento", async () => {
    await night()
    const rec = await getSessionChipReconciliation(prisma, sessionId)
    expect(rec.status).toBe("UNEXPLAINED_DIFFERENCE")
    expect(rec.difference.toFixed(2)).toBe("5000.00")
    // Antes del cierre: advertencia (permite iniciar y contar).
    expect(await codes()).toEqual(
      expect.arrayContaining([
        { code: "SESSION_NOMINAL_DIFFERENCE", severity: "WARNING" },
      ])
    )
    await startClosing(cashier, sessionId, { idempotencyKey: key() })
    expect(await codes()).toEqual(
      expect.arrayContaining([
        { code: "SESSION_NOMINAL_DIFFERENCE", severity: "BLOCKING" },
      ])
    )
    // El arqueo físico encuentra las 200 fichas: $5,000 de más (sin capturar).
    await countAtClose(200)
    const before = await finishCashAndConfirm()
    expect(before.preview.readiness.ready).toBe(false)
    await expect(before.confirm()).rejects.toThrow()
    // CASHIER no concilia (servicio y endpoint).
    await expect(
      reconcileSessionChips(cashier, sessionId, {
        kind: "RETURN_IDENTIFIED_IN_COUNT",
        reason: "Las fichas estaban en la caja de la mesa",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/socio o un superadministrador/)
    signInAs({ ...cashier._user, isActive: true })
    const denied = await call(reconcileRoute.POST, {
      method: "POST",
      params: { id: sessionId },
      body: {
        kind: "RETURN_IDENTIFIED_IN_COUNT",
        reason: "Las fichas estaban en la caja de la mesa",
        idempotencyKey: key(),
      },
    })
    expect(denied.status).toBe(403)
    // PARTNER: importe calculado por el servidor (no se acepta otro).
    await expect(
      reconcileSessionChips(partner, sessionId, {
        kind: "RETURN_IDENTIFIED_IN_COUNT",
        amount: "4000",
        reason: "Devolución de $5,000 no capturada en una liquidación",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/5000\.00/)
    const k = key()
    const both = await Promise.allSettled([
      reconcileSessionChips(partner, sessionId, {
        kind: "RETURN_IDENTIFIED_IN_COUNT",
        reason: "Devolución de $5,000 no capturada en una liquidación",
        idempotencyKey: k,
      }),
      reconcileSessionChips(partner, sessionId, {
        kind: "RETURN_IDENTIFIED_IN_COUNT",
        reason: "Devolución de $5,000 no capturada en una liquidación",
        idempotencyKey: k,
      }),
    ])
    expect(both.some((r) => r.status === "fulfilled")).toBe(true)
    // Una sola entrada nominal REAL respaldada por el arqueo.
    expect(
      await prisma.chipInventoryOperation.count({
        where: { referenceType: "SessionChipReconciliation" },
      })
    ).toBe(1)
    expect((await getSessionChipReconciliation(prisma, sessionId)).status).toBe(
      "RECONCILED"
    )
    // El arqueo quedó desactualizado: recuento y cierre.
    await countAtClose(200)
    const after = await buildClosurePreview(prisma, sessionId)
    expect(after.readiness.ready).toBe(true)
    await confirmClosure(partner, sessionId, {
      idempotencyKey: key(),
      previewHash: after.previewHash,
    })
    expect(await status()).toBe("CLOSED")
    expect(
      D(
        (await prisma.chipSetInventoryState.findFirstOrThrow())
          .circulationNominal
      ).toFixed(2)
    ).toBe("0.00")
    expect((await auditRows("CLOSURE_NOMINAL_RETURN_IDENTIFIED")).length).toBe(
      1
    )
  })

  it("las fichas NO aparecen: sin autorización no cierra; el socio documenta y autoriza sin movimientos", async () => {
    await night()
    await startClosing(cashier, sessionId, { idempotencyKey: key() })
    // El arqueo cuenta 190 fichas: coincide con el libro (faltan de verdad).
    await countAtClose(190)
    // No hay sobrante: no se puede «identificar» un retorno inexistente.
    await expect(
      reconcileSessionChips(partner, sessionId, {
        kind: "RETURN_IDENTIFIED_IN_COUNT",
        reason: "Intento de registrar un retorno sin fichas",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/no encontró fichas de más/)
    const blocked = await finishCashAndConfirm()
    expect(blocked.preview.readiness.ready).toBe(false)
    await reconcileSessionChips(partner, sessionId, {
      kind: "UNRECOVERED_AUTHORIZED",
      reason: "Fichas no localizadas tras revisión con la mesa; se documenta",
      idempotencyKey: key(),
    })
    expect(
      await prisma.chipInventoryOperation.count({
        where: { referenceType: "SessionChipReconciliation" },
      })
    ).toBe(0)
    const p = await buildClosurePreview(prisma, sessionId)
    expect(p.readiness.ready).toBe(true)
    await confirmClosure(partner, sessionId, {
      idempotencyKey: key(),
      previewHash: p.previewHash,
    })
    expect(await status()).toBe("CLOSED")
    // El valor sigue fuera de custodia y la integridad no lo marca (autorizado).
    expect(
      D(
        (await prisma.chipSetInventoryState.findFirstOrThrow())
          .circulationNominal
      ).toFixed(2)
    ).toBe("5000.00")
    const findings = []
    for (const c of integrityChecks(prisma)) findings.push(...(await c.run()))
    expect(
      findings.filter((f) => f.checkCode === "SESSION_NOMINAL_BALANCE")
    ).toEqual([])
    expect(
      (await auditRows("CLOSURE_NOMINAL_DIFFERENCE_AUTHORIZED")).length
    ).toBe(1)
  })
})

describe("ESCENARIO D — deudas y pagos pendientes sobreviven al cierre", () => {
  it("créditos y pagos pendientes con fichas conciliadas: el cierre se permite sin cobrar ni pagar", async () => {
    const players = []
    for (let i = 0; i < 4; i++) players.push(await seat(`Deudor ${i}`))
    for (const p of players) await creditBuy(p.participationId, "5000")
    // Dos pierden todo (deben), dos ganan (se les debe): sin pago inmediato.
    await settle(players[0].participationId, "0")
    await settle(players[1].participationId, "0")
    await settle(players[2].participationId, "12000")
    await settle(players[3].participationId, "8000")
    await closeTables()
    const c = await codes()
    expect(c).toEqual(
      expect.arrayContaining([
        { code: "PLAYER_DEBTS_OUTSTANDING", severity: "WARNING" },
        { code: "PAYABLES_PENDING", severity: "WARNING" },
        { code: "CHIPS_RECONCILED", severity: "INFO" },
      ])
    )
    expect(c.filter((x) => x.severity === "BLOCKING")).toEqual([])
    await startClosing(cashier, sessionId, { idempotencyKey: key() })
    await countAtClose(200)
    const { confirm } = await finishCashAndConfirm()
    await confirm()
    expect(await status()).toBe("CLOSED")
    expect(await prisma.playerDebt.count()).toBe(4)
    const payables = await prisma.settlementPayable.findMany({
      where: { originalAmount: { gt: 0 } },
    })
    expect(payables.map((p) => p.status).sort()).toEqual(["OPEN", "OPEN"])
  })
})

describe("ESCENARIO E — transferencia entre mesas", () => {
  it("25/25 → 10/10 sin compra ni movimiento nominal; se liquida en la mesa destino y cuenta una sola vez", async () => {
    const a = await seat("Viajero")
    const b = await seat("Rival", t10)
    await cashBuy(a.participationId, "4000")
    await cashBuy(b.participationId, "4000")
    const movesBefore = await prisma.chipNominalMovement.count()
    await transferPlayer(cashier, sessionId, {
      sourceParticipationId: a.participationId,
      destinationTableId: t10,
      idempotencyKey: key(),
    })
    expect(await prisma.chipNominalMovement.count()).toBe(movesBefore)
    const dest = await prisma.tableParticipation.findFirstOrThrow({
      where: { playerId: a.playerId, status: "ACTIVE" },
    })
    await settle(dest.id, "6000", { cash: "6000" })
    await settle(b.participationId, "2000", { cash: "2000" })
    const rec = await getSessionChipReconciliation(prisma, sessionId)
    expect(rec.delivered.toFixed(2)).toBe("8000.00")
    expect(rec.returned.toFixed(2)).toBe("8000.00")
    expect(rec.status).toBe("RECONCILED")
  })
})

describe("ESCENARIO F — jugador bancado", () => {
  it("fichas financiadas sin efectivo; devuelve físicamente; resultado bancado sin pago automático; la mesa no lo distingue; balance global $0", async () => {
    const banked = await createTestPlayer({ name: "Financiado" })
    await createAgreement(partner, {
      playerId: banked.id,
      playerPercent: "50",
      reason: "Acuerdo privado de prueba de conciliación",
      idempotencyKey: key(),
    })
    const bp = await addPlayerToTable(cashier, sessionId, t25, {
      playerId: banked.id,
      idempotencyKey: key(),
    })
    const other = await seat("Contraparte")
    const { gameId } = await recordFinancedPurchase(cashier, {
      participationId: bp.participationId,
      nominalAmount: "5000",
      physicalDeliveryConfirmed: true,
      idempotencyKey: key(),
    })
    await cashBuy(other.participationId, "5000")
    expect((await cashBalanceOf(prisma, sessionId)).balance.toFixed(2)).toBe(
      "5000.00"
    )
    const board = await getTableBoard(sessionId, t25, { showPhone: false })
    expect(JSON.stringify(board)).not.toMatch(/HOUSE|fundingSource|bank/i)
    const g = await prisma.bankingGame.findUniqueOrThrow({
      where: { id: gameId },
    })
    await reconcileGame(cashier, gameId, {
      returnedNominalAmount: "8000",
      zeroReturnConfirmed: false,
      physicalReturnVerified: true,
      expectedVersion: g.version,
      idempotencyKey: key(),
    })
    await settle(other.participationId, "2000", { cash: "2000" })
    const game = await prisma.bankingGame.findUniqueOrThrow({
      where: { id: gameId },
    })
    expect(game.grossResult?.toFixed(2)).toBe("3000.00")
    expect(
      await prisma.settlementPayable.count({ where: { playerId: banked.id } })
    ).toBe(0)
    const rec = await getSessionChipReconciliation(prisma, sessionId)
    expect(rec.status).toBe("RECONCILED")
    expect(rec.delivered.toFixed(2)).toBe("10000.00")
  })
})
