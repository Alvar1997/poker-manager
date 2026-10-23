import { randomUUID } from "node:crypto"

import { beforeEach, describe, expect, it } from "vitest"

import * as advancesRoute from "@/app/api/admin/banking/advances/route"
import * as agreementsRoute from "@/app/api/admin/banking/agreements/route"
import * as approveClosingRoute from "@/app/api/admin/banking/cycles/[id]/approve-closing/route"
import * as dashboardRoute from "@/app/api/admin/banking/dashboard/route"
import * as playerRoute from "@/app/api/admin/banking/players/[id]/route"
import * as decisionRoute from "@/app/api/admin/banking/reserves/withdrawals/[id]/decision/route"
import * as changeDecisionRoute from "@/app/api/admin/banking/change-requests/[id]/decision/route"
import * as boardRoute from "@/app/api/sessions/[id]/tables/[tableId]/seats/route"
import * as specialPayoutRoute from "@/app/api/special-operations/payables/[id]/payouts/route"
import { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { listAuditEvents } from "@/modules/audit/audit-query.service"
import { advanceLimitOf, reserveStateOf } from "@/modules/banking/banking-core"
import {
  getBankedPlayer,
  getCycle,
} from "@/modules/banking/banking-query.service"
import { buildBankingXlsx } from "@/modules/banking/banking-report.service"
import {
  closeAdvance,
  registerAdvance,
} from "@/modules/banking/advance.service"
import {
  createAgreement,
  decidePercentageChange,
  requestPercentageChange,
} from "@/modules/banking/agreement.service"
import {
  approveClosing,
  prepareClosing,
  rejectClosing,
} from "@/modules/banking/closing.service"
import {
  adjustGame,
  reconcileGame,
  recordFinancedPurchase,
  reportDiscrepancy,
  resolveDiscrepancy,
} from "@/modules/banking/game.service"
import {
  disburseAdvance,
  disburseWithdrawal,
  payBankingPayable,
} from "@/modules/banking/payout.service"
import {
  recordRegularizationFunds,
  resolveRegularization,
} from "@/modules/banking/regularization.service"
import {
  closeWithdrawal,
  decideWithdrawal,
  requestWithdrawal,
} from "@/modules/banking/reserve.service"
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
import { contributeToCustody } from "@/modules/credits/custody.service"
import { purchasesQuerySchema } from "@/modules/purchases/purchase.schemas"
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
  listPurchases,
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
import { getTableBoard } from "@/modules/table-floor/seat.service"

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
 * Módulo 17 — jugadores bancados por la casa. Noches REALES completas con la
 * base de PRUEBAS: apertura con arqueo, mesa, compras financiadas, una
 * contraparte que paga en efectivo, conciliación física, liquidación
 * ordinaria de la contraparte y cierre real (Módulo 12). Ningún saldo se
 * fabrica: todo sale de los servicios legítimos.
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
let denominationId: string
let t25: string
let t10: string

beforeEach(async () => {
  await resetDatabase()
  signOut()
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

// ── Noche real ────────────────────────────────────────────────────────

async function openNight() {
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
  return s.id
}

async function seat(sessionId: string, playerId: string, tableId = t25) {
  const r = await addPlayerToTable(cashier, sessionId, tableId, {
    playerId,
    idempotencyKey: key(),
  })
  return r.participationId
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
    ...(immediateCashAmount
      ? { immediateCashAmount, cashDelivered: true }
      : {}),
    idempotencyKey: key(),
  })
}

const financed = (participationId: string, amount: string, k: string = key()) =>
  recordFinancedPurchase(cashier, {
    participationId,
    nominalAmount: amount,
    physicalDeliveryConfirmed: true,
    idempotencyKey: k,
  })

async function gameOf(playerId: string, sessionId: string) {
  return prisma.bankingGame.findUniqueOrThrow({
    where: { playerId_sessionId: { playerId, sessionId } },
  })
}

async function reconcile(
  gameId: string,
  returned: string,
  zeroReturnConfirmed = returned === "0"
) {
  const g = await prisma.bankingGame.findUniqueOrThrow({
    where: { id: gameId },
  })
  return (await reconcileGame(cashier, gameId, {
    returnedNominalAmount: returned,
    zeroReturnConfirmed,
    physicalReturnVerified: true,
    expectedVersion: g.version,
    idempotencyKey: key(),
  })) as { replayed: boolean; grossResult?: string }
}

/** Cierre REAL de la sesión (Módulo 12): mesas, arqueos, retiro y confirmación. */
async function closeNight(sessionId: string) {
  const tables = await prisma.sessionTable.findMany({
    where: { sessionId, status: "OPEN" },
    select: { tableId: true },
  })
  for (const t of tables)
    await closeSessionTable(cashier, sessionId, t.tableId, {
      idempotencyKey: key(),
    })
  await startClosing(cashier, sessionId, { idempotencyKey: key() })
  const { count } = await startClosingChipCount(cashier, sessionId)
  await updateStockCount(cashier, count.id, {
    lines: [{ denominationId, countedQuantity: 200 }],
  })
  await confirmClosingChipCount(cashier, sessionId, {
    countId: count.id,
    idempotencyKey: key(),
  })
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
  await confirmClosure(partner, sessionId, {
    idempotencyKey: key(),
    previewHash: p.previewHash,
  })
}

/**
 * Una noche con el jugador bancado: financia `buys`, devuelve `returned` y
 * una contraparte ordinaria (efectivo) equilibra la circulación para que
 * el arqueo final cuadre sin inventar nada.
 */
async function night(
  playerId: string,
  buys: string[],
  returned: string,
  opts: {
    keepOpen?: boolean
    beforeReconcile?: (sid: string) => Promise<void>
  } = {}
) {
  const sid = await openNight()
  const pid = await seat(sid, playerId)
  for (const b of buys) await financed(pid, b)
  const total = buys.reduce((a, b) => a.add(D(b)), D(0))
  const result = D(returned).sub(total)
  // Contraparte ordinaria (efectivo) que equilibra las fichas en circulación.
  const op = result.isZero()
    ? null
    : await seat(sid, (await createTestPlayer()).id)
  if (op) await cashBuy(op, result.abs().toFixed(2))
  if (opts.beforeReconcile) await opts.beforeReconcile(sid)
  const game = await gameOf(playerId, sid)
  await reconcile(game.id, returned)
  if (op && result.greaterThan(0)) await settle(op, "0")
  else if (op)
    await settle(op, result.abs().mul(2).toFixed(2), result.abs().toFixed(2))
  if (!opts.keepOpen) await closeNight(sid)
  return { sessionId: sid, gameId: game.id }
}

async function bank(percent = "50") {
  const player = await createTestPlayer({ name: "Bancado Uno" })
  const r = await createAgreement(partner, {
    playerId: player.id,
    playerPercent: percent,
    reason: "Acuerdo privado de bancaje de prueba",
    idempotencyKey: key(),
  })
  return { playerId: player.id, agreementId: r.agreementId }
}

async function fundCustody(actor: Actor, amount: string) {
  await contributeToCustody(actor, {
    amount,
    counterpartyName: "Socio",
    reason: "Fondeo de custodia para pagos administrativos",
    cashReceived: true,
    idempotencyKey: key(),
  })
}

async function cycleOf(playerId: string, number = 1) {
  return prisma.bankingCycle.findUniqueOrThrow({
    where: { playerId_number: { playerId, number } },
  })
}

async function cut(
  cycleId: string,
  reserveAmount: string,
  payAmount: string,
  actor: Actor = cashier,
  lossAllocation?: Record<string, string>
) {
  return prepareClosing(actor, cycleId, {
    reserveAmount,
    payAmount,
    ...(lossAllocation ? { lossAllocation } : {}),
    idempotencyKey: key(),
  })
}

async function approve(cycleId: string, actor: Actor = partner) {
  const c = await prisma.bankingCycleClosing.findFirstOrThrow({
    where: { cycleId, status: "UNDER_REVIEW" },
  })
  return (await approveClosing(actor, cycleId, {
    closingId: c.id,
    snapshotHash: c.snapshotHash,
    idempotencyKey: key(),
  })) as { replayed: boolean; payableId?: string | null }
}

async function shareAccount() {
  const rows = await prisma.cashTransactionEntry.findMany({
    where: { account: { kind: "BANKING_PLAYER_SHARE" } },
    select: { direction: true, amount: true },
  })
  return rows.reduce(
    (a, r) =>
      r.direction === "DEBIT" ? a.add(D(r.amount)) : a.sub(D(r.amount)),
    D(0)
  )
}

// ── Compras financiadas, jugadas y conciliación ───────────────────────

describe("compras financiadas y conciliación física", () => {
  it("compra y recompra financiadas: inventario real, sin efectivo, sin crédito ni deuda ordinaria", async () => {
    const { playerId } = await bank()
    const sid = await openNight()
    const pid = await seat(sid, playerId)
    const a = await financed(pid, "5000")
    const b = await financed(pid, "2000")
    expect(a.gameId).toBe(b.gameId)
    const purchases = await prisma.chipPurchase.findMany({
      where: { playerId, sessionId: sid },
      orderBy: { sequenceNumber: "asc" },
      include: { payments: true, debt: true, delivery: true, receipt: true },
    })
    expect(purchases.map((p) => [p.purchaseType, p.rebuyNumber])).toEqual([
      ["INITIAL_PURCHASE", null],
      ["REBUY", 1],
    ])
    for (const p of purchases) {
      expect(p.fundingSource).toBe("HOUSE")
      expect(p.status).toBe("CONFIRMED")
      expect(p.payments).toHaveLength(0)
      expect(p.debt).toBeNull()
      expect(p.receipt).toBeNull()
      expect(p.delivery?.outstandingAmount.toFixed(2)).toBe("0.00")
    }
    // Inventario compartido: 7,000 en circulación (salida nominal real).
    const inv = await prisma.chipSetInventoryState.findFirstOrThrow()
    expect(D(inv.circulationNominal).toFixed(2)).toBe("7000.00")
    // Caja: ni efectivo ficticio ni transferencias.
    expect((await cashBalanceOf(prisma, sid)).balance.toFixed(2)).toBe("0.00")
    expect(await prisma.cashTransaction.count()).toBe(0)
    expect(await prisma.bankTransferVerification.count()).toBe(0)
    expect(await prisma.playerDebt.count()).toBe(0)
    expect(await prisma.notificationOutbox.count()).toBe(0)
    // La base impide cobros, crédito o deuda sobre una compra financiada.
    await expect(
      prisma.purchasePayment.create({
        data: {
          purchaseId: a.purchaseId,
          method: "CASH",
          amount: "1",
          status: "CONFIRMED",
          createdById: cashier.id,
          idempotencyKey: key(),
        },
      })
    ).rejects.toThrow()
    // Reintento con la misma clave: no duplica.
    const again = await financed(
      pid,
      "5000",
      (
        await prisma.chipPurchase.findUniqueOrThrow({
          where: { id: a.purchaseId },
        })
      ).idempotencyKey
    )
    expect(again).toMatchObject({ purchaseId: a.purchaseId, replayed: true })
    expect(
      await prisma.chipPurchase.count({ where: { playerId, sessionId: sid } })
    ).toBe(2)
  })

  it("ganancia: +$3,000 con devolución física de $10,000 (entra al inventario una vez; no se paga el valor devuelto)", async () => {
    const { playerId } = await bank()
    const sid = await openNight()
    const pid = await seat(sid, playerId)
    await financed(pid, "5000")
    await financed(pid, "2000")
    const op = await seat(sid, (await createTestPlayer()).id)
    await cashBuy(op, "3000")
    const g = await gameOf(playerId, sid)
    const r = await reconcile(g.id, "10000")
    expect(r).toMatchObject({ grossResult: "3000.00" })
    const game = await prisma.bankingGame.findUniqueOrThrow({
      where: { id: g.id },
    })
    expect(game).toMatchObject({ status: "CONFIRMED" })
    expect(game.financedNominal?.toFixed(2)).toBe("7000.00")
    expect(game.returnedNominal?.toFixed(2)).toBe("10000.00")
    expect(game.grossResult?.toFixed(2)).toBe("3000.00")
    // Participación SETTLED SIN liquidación ordinaria ni cuenta por pagar.
    const part = await prisma.tableParticipation.findUniqueOrThrow({
      where: { id: pid },
    })
    expect(part).toMatchObject({
      status: "SETTLED",
      settlementId: null,
      bankingGameId: g.id,
    })
    expect(await prisma.playerSettlement.count({ where: { playerId } })).toBe(0)
    expect(await prisma.settlementPayable.count({ where: { playerId } })).toBe(
      0
    )
    // Una sola entrada nominal por la jugada.
    expect(
      await prisma.chipInventoryOperation.count({
        where: { referenceType: "BankingGame", referenceId: g.id },
      })
    ).toBe(1)
    // Reintentar con otra clave: ya conciliada (no hay doble devolución).
    await expect(reconcile(g.id, "10000")).rejects.toThrow(
      /ya fue conciliada|cambió/
    )
    // La caja de la sesión solo tiene el efectivo REAL de la contraparte.
    expect((await cashBalanceOf(prisma, sid)).balance.toFixed(2)).toBe(
      "3000.00"
    )
  })

  it("pérdida −$3,000 y retorno cero −$7,000 solo con confirmación expresa", async () => {
    const { playerId } = await bank()
    const sid = await openNight()
    const pid = await seat(sid, playerId)
    await financed(pid, "5000")
    await financed(pid, "2000")
    const g = await gameOf(playerId, sid)
    await expect(reconcile(g.id, "0", false)).rejects.toThrow(
      /confirma expresamente/
    )
    const r = await reconcile(g.id, "0", true)
    expect(r).toMatchObject({ grossResult: "-7000.00" })
    const game = await prisma.bankingGame.findUniqueOrThrow({
      where: { id: g.id },
    })
    expect(game.zeroReturnConfirmed).toBe(true)
    expect(game.returnOperationId).toBeNull()
    expect(
      await prisma.chipInventoryOperation.count({
        where: { referenceType: "BankingGame" },
      })
    ).toBe(0)

    const other = await bank()
    const sid2 = sid
    const pid2 = await seat(sid2, other.playerId)
    await financed(pid2, "5000")
    await financed(pid2, "2000")
    const g2 = await gameOf(other.playerId, sid2)
    expect((await reconcile(g2.id, "4000")).grossResult).toBe("-3000.00")
  })

  it("cambiar de mesa en la misma sesión cuenta UNA sola jugada", async () => {
    const { playerId } = await bank()
    const sid = await openNight()
    await openSessionTable(cashier, sid, t10, { idempotencyKey: key() })
    const pid = await seat(sid, playerId)
    await financed(pid, "2000")
    const moved = await transferPlayer(cashier, sid, {
      sourceParticipationId: pid,
      destinationTableId: t10,
      idempotencyKey: key(),
    })
    const destination = await prisma.tableParticipation.findFirstOrThrow({
      where: { playerId, sessionId: sid, status: "ACTIVE" },
    })
    expect(moved).toBeTruthy()
    await financed(destination.id, "1000")
    expect(await prisma.bankingGame.count({ where: { playerId } })).toBe(1)
    const g = await gameOf(playerId, sid)
    await reconcile(g.id, "3000")
    const game = await prisma.bankingGame.findUniqueOrThrow({
      where: { id: g.id },
    })
    expect(game.financedNominal?.toFixed(2)).toBe("3000.00")
    expect(game.gameNumber).toBe(1)
  })

  it("no mezcla: compra ordinaria y liquidación ordinaria rechazadas para una jugada financiada", async () => {
    const { playerId } = await bank()
    const sid = await openNight()
    const pid = await seat(sid, playerId)
    await financed(pid, "1000")
    await expect(
      createPurchase(cashier, {
        participationId: pid,
        nominalAmount: "500",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/Administración/)
    await expect(
      createSettlement(cashier, {
        participationId: pid,
        returnedNominalAmount: "1000",
        offsetDecision: "NO_COMPENSATE",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/Administración/)
    // Y al revés: quien ya pagó con su dinero no recibe fichas financiadas.
    const normal = await bank()
    const pn = await seat(sid, normal.playerId)
    await cashBuy(pn, "500")
    await expect(financed(pn, "1000")).rejects.toThrow(/no se mezclan/)
  })

  it("discrepancia física: bloquea, abre incidencia y expediente; un socio la aclara", async () => {
    const { playerId } = await bank()
    const sid = await openNight()
    const pid = await seat(sid, playerId)
    await financed(pid, "1000")
    const g = await gameOf(playerId, sid)
    await reportDiscrepancy(cashier, g.id, {
      description: "El conteo no coincide con lo declarado por el jugador",
      idempotencyKey: key(),
    })
    await expect(reconcile(g.id, "1000")).rejects.toThrow(/discrepancia/)
    const inc = await prisma.operationalIncident.findFirstOrThrow()
    expect(inc.title).not.toMatch(/bancad/i)
    expect(inc.status).toBe("OPEN")
    expect(
      (await prisma.bankingCycle.findFirstOrThrow({ where: { playerId } }))
        .status
    ).toBe("UNDER_REGULARIZATION")
    expect(
      await prisma.chipInventoryOperation.count({
        where: { referenceType: "BankingGame" },
      })
    ).toBe(0)
    await resolveDiscrepancy(partner, g.id, {
      notes: "Recuento físico confirmado en presencia del socio",
      idempotencyKey: key(),
    })
    expect((await prisma.operationalIncident.findFirstOrThrow()).status).toBe(
      "RESOLVED"
    )
    expect((await reconcile(g.id, "1000")).grossResult).toBe("0.00")
  })
})

// ── Ciclos de cuatro jugadas ──────────────────────────────────────────

describe("ciclos de exactamente cuatro jugadas", () => {
  it("cuatro noches completan el ciclo; la quinta abre el siguiente; las ausencias no cuentan", async () => {
    const { playerId } = await bank()
    for (const r of ["2000", "1000", "1000", "1000"])
      await night(playerId, ["1000"], r)
    const c1 = await cycleOf(playerId, 1)
    expect(c1.status).toBe("READY_FOR_REVIEW")
    expect(await prisma.bankingGame.count({ where: { cycleId: c1.id } })).toBe(
      4
    )
    // Una noche sin el jugador bancado no crea jugada.
    const sid = await openNight()
    const someone = await seat(sid, (await createTestPlayer()).id)
    await cashBuy(someone, "500")
    await settle(someone, "500", "500")
    await closeNight(sid)
    expect(await prisma.bankingGame.count({ where: { playerId } })).toBe(4)
    // La siguiente jugada pertenece al ciclo 2 (nunca una quinta en el 1).
    await night(playerId, ["1000"], "1000")
    const c2 = await cycleOf(playerId, 2)
    expect(await prisma.bankingGame.count({ where: { cycleId: c2.id } })).toBe(
      1
    )
    await expect(
      prisma.bankingGame.create({
        data: {
          cycleId: c1.id,
          playerId,
          sessionId: sid,
          gameNumber: 5,
          startedById: cashier.id,
        },
      })
    ).rejects.toThrow()
  })
})

// ── Escenario A ───────────────────────────────────────────────────────

describe("Escenario A — ciclo ganador con anticipo, reserva y obligación", () => {
  it("+5,000 −2,000 +4,000 −1,000 al 50%: participación 3,000 − anticipo 1,000 = 2,000 → 1,500 reserva y 500 por pagar", async () => {
    const { playerId } = await bank("50")
    await fundCustody(cashier, "5000")
    const n1 = await night(playerId, ["5000"], "10000")
    // Anticipo de $1,000 tras la jugada ganadora (verbal), pagado en efectivo.
    const adv = await registerAdvance(cashier, {
      playerId,
      enablingGameId: n1.gameId,
      requestedAmount: "1000",
      authorizedAmount: "1000",
      authorizerId: partner.id,
      channel: "VERBAL",
      idempotencyKey: key(),
    })
    await disburseAdvance(cashier, adv.advanceId, {
      amount: "1000",
      method: "CASH",
      funding: "ADMIN_CUSTODY",
      idempotencyKey: key(),
    })
    await night(playerId, ["5000"], "3000")
    await night(playerId, ["2000"], "6000")
    await night(playerId, ["2000"], "1000")
    const cycle = await cycleOf(playerId)
    const view = await getCycle(cycle.id)
    expect(view.provisional).toMatchObject({
      grossTotal: "6000.00",
      playerShare: "3000.00",
      houseShare: "3000.00",
      advancesPaid: "1000.00",
      balance: "2000.00",
    })
    await expect(cut(cycle.id, "1500", "600")).rejects.toThrow(
      /exactamente el saldo/
    )
    await cut(cycle.id, "1500", "500")
    // CASHIER no aprueba digitalmente.
    await expect(approve(cycle.id, cashier)).rejects.toThrow(
      /PARTNER o SUPERADMIN/
    )
    expect(
      (await auditRows("BANKING_CLOSING_APPROVAL_DENIED"))[0]?.result
    ).toBe("DENIED")
    const r = await approve(cycle.id, partner)
    const closing = await prisma.bankingCycleClosing.findFirstOrThrow({
      where: { cycleId: cycle.id, status: "APPROVED" },
    })
    expect(closing.playerShare.toFixed(2)).toBe("3000.00")
    expect(closing.advancesPaid.toFixed(2)).toBe("1000.00")
    expect(closing.reserveAmount.toFixed(2)).toBe("1500.00")
    expect(closing.payAmount.toFixed(2)).toBe("500.00")
    expect(closing.carriedLossOut.toFixed(2)).toBe("0.00")
    // Reserva creada UNA vez; obligación de $500 SIN pago automático.
    expect((await reserveStateOf(prisma, playerId)).balance.toFixed(2)).toBe(
      "1500.00"
    )
    expect(
      await prisma.bankingReserveMovement.count({ where: { playerId } })
    ).toBe(1)
    const payable = await prisma.specialPayable.findUniqueOrThrow({
      where: { id: r.payableId! },
      include: { payouts: true },
    })
    expect(payable).toMatchObject({
      kind: "BANKING_CYCLE_PAYOUT",
      status: "OPEN",
    })
    expect(payable.payouts).toHaveLength(0)
    // Dinero real: solo el anticipo salió de la custodia ($1,000).
    expect((await shareAccount()).toFixed(2)).toBe("1000.00")
    expect(
      (await prisma.bankingCycle.findUniqueOrThrow({ where: { id: cycle.id } }))
        .status
    ).toBe("CLOSED")
    // El ciclo cerrado es inmutable y su corte no se aprueba dos veces.
    await expect(
      prisma.bankingCycle.update({
        where: { id: cycle.id },
        data: { status: "IN_PROGRESS" },
      })
    ).rejects.toThrow()
    await expect(
      prisma.bankingCycleClosing.update({
        where: { id: closing.id },
        data: { payAmount: "999" },
      })
    ).rejects.toThrow()
    // Pago final parcial (efectivo de custodia) y saldo pendiente.
    await payBankingPayable(cashier, payable.id, {
      amount: "200",
      method: "CASH",
      funding: "ADMIN_CUSTODY",
      idempotencyKey: key(),
    })
    const after = await prisma.specialPayable.findUniqueOrThrow({
      where: { id: payable.id },
    })
    expect(after.status).toBe("PARTIALLY_PAID")
    expect((await shareAccount()).toFixed(2)).toBe("1200.00")
    // Nunca se paga desde el endpoint general de operaciones especiales.
    signInAs({ ...cashier._user, isActive: true })
    const generic = await call(specialPayoutRoute.POST, {
      method: "POST",
      params: { id: payable.id },
      body: { method: "CASH", amount: "100", idempotencyKey: key() },
    })
    expect(generic.status).toBe(422)
    // Auditoría privada completa.
    for (const a of [
      "BANKING_AGREEMENT_CREATED",
      "BANKING_CYCLE_STARTED",
      "BANKING_GAME_CONFIRMED",
      "BANKING_ADVANCE_REGISTERED",
      "BANKING_ADVANCE_DISBURSED",
      "BANKING_CLOSING_PREPARED",
      "BANKING_CLOSING_APPROVED",
      "BANKING_RESERVE_CREATED",
      "BANKING_CYCLE_CLOSED",
    ])
      expect((await auditRows(a)).length, a).toBeGreaterThan(0)
    expect((await auditRows("BANKING_CLOSING_APPROVED"))[0]).toMatchObject({
      module: "BANKING",
      actorRole: "PARTNER",
    })
    // Diagnóstico de integridad COMPLETO (Módulo 15): sin errores.
    const findings = []
    for (const check of integrityChecks(prisma))
      findings.push(...(await check.run()))
    expect(
      findings.filter((f) => f.status === "ERROR").map((f) => f.checkCode)
    ).toEqual([])
  })
})

// ── Escenario B ───────────────────────────────────────────────────────

describe("Escenario B — la reserva absorbe la pérdida sin doble descuento", () => {
  it("reserva 3,000; ciclo −5,000 → reserva aplicada 3,000, arrastre 2,000; el siguiente recupera solo los 2,000", async () => {
    const { playerId } = await bank("50")
    // Ciclo 1: +6,000 → participación 3,000 → toda a reserva.
    await night(playerId, ["1000"], "7000")
    for (let i = 0; i < 3; i++) await night(playerId, ["1000"], "1000")
    const c1 = await cycleOf(playerId, 1)
    await cut(c1.id, "3000", "0")
    await approve(c1.id)
    expect((await reserveStateOf(prisma, playerId)).balance.toFixed(2)).toBe(
      "3000.00"
    )
    // Ciclo 2: −2,000 −1,000 −1,000 −1,000 = −5,000.
    await night(playerId, ["3000"], "1000")
    for (let i = 0; i < 3; i++) await night(playerId, ["2000"], "1000")
    const c2 = await cycleOf(playerId, 2)
    // Con déficit confirmado la reserva no es retirable.
    expect(
      (await reserveStateOf(prisma, playerId)).withdrawable.toFixed(2)
    ).toBe("0.00")
    await cut(c2.id, "0", "0")
    await approve(c2.id)
    const closing = await prisma.bankingCycleClosing.findFirstOrThrow({
      where: { cycleId: c2.id, status: "APPROVED" },
    })
    expect(closing.grossTotal.toFixed(2)).toBe("-5000.00")
    expect(closing.reserveConsumed.toFixed(2)).toBe("3000.00")
    expect(closing.carriedLossOut.toFixed(2)).toBe("2000.00")
    expect(closing.playerShare.toFixed(2)).toBe("0.00")
    expect((await reserveStateOf(prisma, playerId)).balance.toFixed(2)).toBe(
      "0.00"
    )
    // Ciclo 3: +3,000 → primero recupera los 2,000 (no los 5,000): 1,000 × 50%.
    const n = await night(playerId, ["1000"], "4000")
    const limit = await advanceLimitOf(prisma, (await cycleOf(playerId, 3)).id)
    expect(limit.guaranteedShare.toFixed(2)).toBe("500.00")
    expect(n.gameId).toBeTruthy()
    // La reserva nunca queda negativa (la base lo impide).
    await expect(
      prisma.bankingReserveMovement.create({
        data: {
          playerId,
          kind: "CONSUMED_BY_LOSS",
          amount: "1",
          uniqueKey: key(),
          createdById: admin.id,
        },
      })
    ).rejects.toThrow()
  })
})

// ── Escenario C ───────────────────────────────────────────────────────

describe("Escenario C — porcentajes distintos y distribución de pérdidas entre tramos", () => {
  it("50%, 50%, 60%, 60% con pérdidas: el socio decide una distribución válida; las inválidas se rechazan", async () => {
    const { playerId, agreementId } = await bank("50")
    await night(playerId, ["1000"], "5000") // +4,000 @50
    await night(playerId, ["2000"], "1000") // −1,000 @50
    // Cambio desde la SIGUIENTE jugada: CASHIER solicita, PARTNER aprueba.
    const req = await requestPercentageChange(cashier, agreementId, {
      playerPercent: "60",
      mode: "FROM_NEXT_GAME",
      reason: "Nuevo acuerdo a partir de la jugada 3",
      idempotencyKey: key(),
    })
    signInAs({ ...cashier._user, isActive: true })
    const denied = await call(changeDecisionRoute.POST, {
      method: "POST",
      params: { id: req.requestId },
      body: { decision: "APPROVE", idempotencyKey: key() },
    })
    expect(denied.status).toBe(403)
    await decidePercentageChange(partner, req.requestId, {
      decision: "APPROVE",
      idempotencyKey: key(),
    })
    const changed =
      await prisma.bankingPercentageChangeRequest.findUniqueOrThrow({
        where: { id: req.requestId },
      })
    expect(changed).toMatchObject({
      status: "APPROVED",
      startGameNumber: 3,
      decidedById: partner.id,
    })
    expect(changed.beforeCalculation).toBeTruthy()
    expect(changed.afterCalculation).toBeTruthy()
    await night(playerId, ["1000"], "4000") // +3,000 @60
    await night(playerId, ["3000"], "1000") // −2,000 @60
    const cycle = await cycleOf(playerId)
    const view = await getCycle(cycle.id)
    expect(view.games.map((g) => g.playerPercent)).toEqual([
      "50.00",
      "50.00",
      "60.00",
      "60.00",
    ])
    expect(view.provisional?.allocationRequired).toBe(true)
    const [tA, tB] = view.provisional!.tranches.map((t) => t.key)
    // CASHIER no decide la distribución; tampoco se prepara sin ella.
    await expect(cut(cycle.id, "0", "2100")).rejects.toThrow(
      /socio debe decidir/
    )
    await expect(
      cut(cycle.id, "0", "2100", cashier, { [tA]: "1000", [tB]: "2000" })
    ).rejects.toThrow(/PARTNER o SUPERADMIN/)
    // Inválidas: suma distinta de la pérdida o tramo que absorbe más que sus ganancias.
    await expect(
      cut(cycle.id, "0", "2100", partner, { [tA]: "4000", [tB]: "0" })
    ).rejects.toThrow(/exactamente la pérdida/)
    await expect(
      cut(cycle.id, "0", "2100", partner, { [tA]: "0", [tB]: "3500" })
    ).rejects.toThrow(/solo tiene/)
    // Válida: A absorbe 1,000 y B 2,000 → 3,000×50% + 1,000×60% = 2,100.
    await cut(cycle.id, "0", "2100", partner, { [tA]: "1000", [tB]: "2000" })
    await approve(cycle.id, partner)
    const closing = await prisma.bankingCycleClosing.findFirstOrThrow({
      where: { cycleId: cycle.id, status: "APPROVED" },
    })
    expect(closing.grossTotal.toFixed(2)).toBe("4000.00")
    expect(closing.playerShare.toFixed(2)).toBe("2100.00")
    expect(closing.houseShare.toFixed(2)).toBe("1900.00")
    expect(closing.lossAllocation).toEqual({ [tA]: "1000", [tB]: "2000" })
    expect((await auditRows("BANKING_LOSS_ALLOCATED")).length).toBe(1)
    // Resultados brutos intactos.
    const games = await prisma.bankingGame.findMany({
      where: { cycleId: cycle.id },
      orderBy: { gameNumber: "asc" },
    })
    expect(games.map((g) => g.grossResult?.toFixed(2))).toEqual([
      "4000.00",
      "-1000.00",
      "3000.00",
      "-2000.00",
    ])
  })

  it("cambio para TODO el ciclo: un tramo nuevo desde la jugada 1; un corte en revisión queda invalidado", async () => {
    const { playerId, agreementId } = await bank("50")
    for (const r of ["3000", "1000", "1000", "1000"])
      await night(playerId, ["1000"], r)
    const cycle = await cycleOf(playerId)
    await cut(cycle.id, "0", "1000")
    const reviewed = await prisma.bankingCycleClosing.findFirstOrThrow({
      where: { cycleId: cycle.id, status: "UNDER_REVIEW" },
    })
    const req = await requestPercentageChange(cashier, agreementId, {
      playerPercent: "40",
      mode: "WHOLE_CYCLE",
      reason: "Ajuste acordado para todo el ciclo",
      idempotencyKey: key(),
    })
    await decidePercentageChange(admin, req.requestId, {
      decision: "APPROVE",
      idempotencyKey: key(),
    })
    expect(
      (
        await prisma.bankingCycleClosing.findUniqueOrThrow({
          where: { id: reviewed.id },
        })
      ).status
    ).toBe("SUPERSEDED")
    // Aprobar la versión obsoleta: rechazado (no conserva autorizaciones viejas).
    await expect(
      approveClosing(partner, cycle.id, {
        closingId: reviewed.id,
        snapshotHash: reviewed.snapshotHash,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/ya no está en revisión/)
    const view = await getCycle(cycle.id)
    expect(view.games.every((g) => g.playerPercent === "40.00")).toBe(true)
    expect(view.provisional?.playerShare).toBe("800.00")
  })
})

// ── Escenario D ───────────────────────────────────────────────────────

describe("Escenario D — anticipos con autorización verbal o por mensaje", () => {
  it("disponible conservador 2,000; CASHIER registra 1,000 VERBAL y lo paga; pagos parciales; límite revalidado", async () => {
    const { playerId } = await bank("50")
    await fundCustody(cashier, "5000")
    const n1 = await night(playerId, ["1000"], "5000") // +4,000 → 2,000 garantizado
    const cycle = await cycleOf(playerId)
    expect((await advanceLimitOf(prisma, cycle.id)).available.toFixed(2)).toBe(
      "2000.00"
    )
    // Más que el disponible: rechazado.
    await expect(
      registerAdvance(cashier, {
        playerId,
        enablingGameId: n1.gameId,
        requestedAmount: "2500",
        authorizedAmount: "2500",
        authorizerId: partner.id,
        channel: "VERBAL",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/2000\.00/)
    // El autorizador debe ser socio o superadmin.
    await expect(
      registerAdvance(cashier, {
        playerId,
        enablingGameId: n1.gameId,
        requestedAmount: "1000",
        authorizedAmount: "1000",
        authorizerId: cashier.id,
        channel: "VERBAL",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/PARTNER o SUPERADMIN/)
    signInAs({ ...cashier._user, isActive: true })
    const res = await call(advancesRoute.POST, {
      method: "POST",
      body: {
        playerId,
        enablingGameId: n1.gameId,
        requestedAmount: "1000",
        authorizedAmount: "1000",
        authorizerId: partner.id,
        channel: "VERBAL",
        idempotencyKey: key(),
      },
    })
    expect(res.status).toBe(201)
    const advanceId = (res.json.data as { advanceId: string }).advanceId
    // Registrar no es pagar.
    expect((await shareAccount()).toFixed(2)).toBe("0.00")
    expect((await advanceLimitOf(prisma, cycle.id)).available.toFixed(2)).toBe(
      "1000.00"
    )
    const k = key()
    const [p1, p2] = await Promise.allSettled([
      disburseAdvance(cashier, advanceId, {
        amount: "600",
        method: "CASH",
        funding: "ADMIN_CUSTODY",
        idempotencyKey: k,
      }),
      disburseAdvance(cashier, advanceId, {
        amount: "600",
        method: "CASH",
        funding: "ADMIN_CUSTODY",
        idempotencyKey: k,
      }),
    ])
    expect([p1.status, p2.status]).toContain("fulfilled")
    expect((await shareAccount()).toFixed(2)).toBe("600.00")
    expect(
      (
        await prisma.bankingAdvance.findUniqueOrThrow({
          where: { id: advanceId },
        })
      ).status
    ).toBe("PARTIALLY_PAID")
    await expect(
      disburseAdvance(cashier, advanceId, {
        amount: "500",
        method: "CASH",
        funding: "ADMIN_CUSTODY",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/autorizado pendiente/)
    await disburseAdvance(cashier, advanceId, {
      amount: "400",
      method: "CASH",
      funding: "ADMIN_CUSTODY",
      idempotencyKey: key(),
    })
    expect(
      (
        await prisma.bankingAdvance.findUniqueOrThrow({
          where: { id: advanceId },
        })
      ).status
    ).toBe("PAID")
    expect((await shareAccount()).toFixed(2)).toBe("1000.00")
    const [audit] = await auditRows("BANKING_ADVANCE_REGISTERED")
    expect(audit.metadata).toMatchObject({
      channel: "VERBAL",
      digitalApproval: false,
      authorizerId: partner.id,
    })
    // Anticipo por MENSAJE con el resto disponible y desembolso por transferencia en trámite.
    const m = await registerAdvance(cashier, {
      playerId,
      enablingGameId: n1.gameId,
      requestedAmount: "1500",
      authorizedAmount: "1000",
      authorizerId: admin.id,
      channel: "MESSAGE",
      idempotencyKey: key(),
    })
    await disburseAdvance(cashier, m.advanceId, {
      amount: "1000",
      method: "BANK_TRANSFER",
      bankReference: "SPEI-001",
      idempotencyKey: key(),
    })
    // Una transferencia pendiente no cuenta como pagada.
    expect((await shareAccount()).toFixed(2)).toBe("1000.00")
    expect((await advanceLimitOf(prisma, cycle.id)).available.toFixed(2)).toBe(
      "0.00"
    )
  })

  it("rechaza anticipos tras una jugada perdedora y cierra el remanente no pagado", async () => {
    const { playerId } = await bank("50")
    await fundCustody(cashier, "2000")
    const win = await night(playerId, ["1000"], "3000") // +2,000 → 1,000 garantizado
    const lose = await night(playerId, ["1000"], "500") // −500
    await expect(
      registerAdvance(cashier, {
        playerId,
        enablingGameId: lose.gameId,
        requestedAmount: "100",
        authorizedAmount: "100",
        authorizerId: partner.id,
        channel: "MESSAGE",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/no fue ganadora/)
    const cycle = await cycleOf(playerId)
    // (2,000 − 500) × 50% = 750 garantizado.
    expect((await advanceLimitOf(prisma, cycle.id)).available.toFixed(2)).toBe(
      "750.00"
    )
    const a = await registerAdvance(cashier, {
      playerId,
      enablingGameId: win.gameId,
      requestedAmount: "700",
      authorizedAmount: "700",
      authorizerId: partner.id,
      channel: "MESSAGE",
      idempotencyKey: key(),
    })
    await disburseAdvance(cashier, a.advanceId, {
      amount: "300",
      method: "CASH",
      funding: "ADMIN_CUSTODY",
      idempotencyKey: key(),
    })
    await closeAdvance(cashier, a.advanceId, {
      reason: "El jugador no quiso el resto del anticipo",
      idempotencyKey: key(),
    })
    expect((await advanceLimitOf(prisma, cycle.id)).available.toFixed(2)).toBe(
      "450.00"
    )
  })
})

// ── Escenario E ───────────────────────────────────────────────────────

describe("Escenario E — anticipo excedido, caso por caso", () => {
  it("anticipos 3,000 > participación 2,000: expediente de 1,000 sin deuda ordinaria; se recupera del siguiente corte", async () => {
    const { playerId } = await bank("50")
    await fundCustody(cashier, "5000")
    const n1 = await night(playerId, ["1000"], "7000") // +6,000 → 3,000
    const a = await registerAdvance(cashier, {
      playerId,
      enablingGameId: n1.gameId,
      requestedAmount: "3000",
      authorizedAmount: "3000",
      authorizerId: partner.id,
      channel: "VERBAL",
      idempotencyKey: key(),
    })
    await disburseAdvance(cashier, a.advanceId, {
      amount: "3000",
      method: "CASH",
      funding: "ADMIN_CUSTODY",
      idempotencyKey: key(),
    })
    await night(playerId, ["3000"], "1000") // −2,000
    expect((await auditRows("BANKING_EXCESS_ADVANCE_DETECTED")).length).toBe(1)
    await night(playerId, ["1000"], "1000")
    await night(playerId, ["1000"], "1000")
    const cycle = await cycleOf(playerId)
    await expect(cut(cycle.id, "0", "1")).rejects.toThrow(/anticipos excedidos/)
    await cut(cycle.id, "0", "0")
    await approve(cycle.id)
    const reg = await prisma.bankingRegularization.findFirstOrThrow({
      where: { playerId, kind: "EXCESS_ADVANCE" },
    })
    expect(reg.status).toBe("OPEN")
    expect(reg.amount.toFixed(2)).toBe("1000.00")
    expect(await prisma.playerDebt.count()).toBe(0)
    expect(await prisma.paymentAllocation.count()).toBe(0)
    // Mientras está abierto, no hay anticipos nuevos.
    const n5 = await night(playerId, ["1000"], "5000") // ciclo 2: +4,000 → 2,000
    const c2 = await cycleOf(playerId, 2)
    expect((await advanceLimitOf(prisma, c2.id)).blockedReason).toMatch(
      /regularización/
    )
    // CASHIER no resuelve; el socio decide recuperar contra participaciones futuras.
    await resolveRegularization(partner, reg.id, {
      resolution: "RECOVER_FROM_FUTURE",
      notes: "Se descontará del siguiente corte, acordado con el jugador",
      idempotencyKey: key(),
    })
    expect((await advanceLimitOf(prisma, c2.id)).available.toFixed(2)).toBe(
      "1000.00"
    )
    for (let i = 0; i < 3; i++) await night(playerId, ["1000"], "1000")
    await cut(c2.id, "0", "1000")
    await approve(c2.id)
    const closing = await prisma.bankingCycleClosing.findFirstOrThrow({
      where: { cycleId: c2.id, status: "APPROVED" },
    })
    expect(closing.recoveryApplied.toFixed(2)).toBe("1000.00")
    expect(
      (
        await prisma.bankingRegularization.findUniqueOrThrow({
          where: { id: reg.id },
        })
      ).status
    ).toBe("RESOLVED")
    expect(n5.gameId).toBeTruthy()
  })

  it("devolución acordada: el dinero entra SOLO al recibirlo (custodia) y nunca más que lo pendiente", async () => {
    const { playerId } = await bank("50")
    await fundCustody(cashier, "5000")
    const n1 = await night(playerId, ["1000"], "3000") // +2,000 → 1,000
    const a = await registerAdvance(cashier, {
      playerId,
      enablingGameId: n1.gameId,
      requestedAmount: "1000",
      authorizedAmount: "1000",
      authorizerId: partner.id,
      channel: "VERBAL",
      idempotencyKey: key(),
    })
    await disburseAdvance(cashier, a.advanceId, {
      amount: "1000",
      method: "CASH",
      funding: "ADMIN_CUSTODY",
      idempotencyKey: key(),
    })
    await night(playerId, ["2000"], "1000") // −1,000 → neto 1,000 → 500
    await night(playerId, ["1000"], "1000")
    await night(playerId, ["1000"], "1000")
    const cycle = await cycleOf(playerId)
    await cut(cycle.id, "0", "0")
    await approve(cycle.id)
    const reg = await prisma.bankingRegularization.findFirstOrThrow({
      where: { playerId },
    })
    expect(reg.amount.toFixed(2)).toBe("500.00")
    await resolveRegularization(admin, reg.id, {
      resolution: "MONEY_RETURNED",
      notes: "El jugador devolverá el excedente en efectivo",
      idempotencyKey: key(),
    })
    // Aprobar no registra dinero.
    expect((await shareAccount()).toFixed(2)).toBe("1000.00")
    await expect(
      recordRegularizationFunds(cashier, reg.id, {
        amount: "600",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/500\.00/)
    await recordRegularizationFunds(cashier, reg.id, {
      amount: "500",
      idempotencyKey: key(),
    })
    expect((await shareAccount()).toFixed(2)).toBe("500.00")
    expect(
      (
        await prisma.bankingRegularization.findUniqueOrThrow({
          where: { id: reg.id },
        })
      ).status
    ).toBe("RESOLVED")
  })
})

// ── Escenario F ───────────────────────────────────────────────────────

describe("Escenario F — retiro de reserva con aprobación digital", () => {
  it("reserva 5,000 → retiro 2,000 aprobado por PARTNER → pago real de 1,000; sin dobles ni excesos", async () => {
    const { playerId } = await bank("50")
    await fundCustody(cashier, "5000")
    await night(playerId, ["1000"], "11000") // +10,000 → 5,000
    for (let i = 0; i < 3; i++) await night(playerId, ["1000"], "1000")
    const cycle = await cycleOf(playerId)
    await cut(cycle.id, "5000", "0")
    await approve(cycle.id)
    expect(
      (await reserveStateOf(prisma, playerId)).withdrawable.toFixed(2)
    ).toBe("5000.00")
    const w = await requestWithdrawal(cashier, {
      playerId,
      amount: "2000",
      reason: "El jugador solicita parte de su reserva",
      idempotencyKey: key(),
    })
    // CASHIER no aprueba (endpoint 403).
    signInAs({ ...cashier._user, isActive: true })
    const denied = await call(decisionRoute.POST, {
      method: "POST",
      params: { id: w.withdrawalId },
      body: { decision: "APPROVE", idempotencyKey: key() },
    })
    expect(denied.status).toBe(403)
    // Sin aprobación no se paga.
    await expect(
      disburseWithdrawal(cashier, w.withdrawalId, {
        amount: "1000",
        method: "CASH",
        funding: "ADMIN_CUSTODY",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/aprobación digital/)
    // Dos aprobaciones simultáneas: el compromiso se aplica UNA vez.
    await Promise.allSettled([
      decideWithdrawal(partner, w.withdrawalId, {
        decision: "APPROVE",
        idempotencyKey: key(),
      }),
      decideWithdrawal(admin, w.withdrawalId, {
        decision: "APPROVE",
        idempotencyKey: key(),
      }),
    ])
    expect(
      await prisma.bankingReserveMovement.count({
        where: {
          withdrawalId: w.withdrawalId,
          kind: "RECLASSIFIED_TO_WITHDRAWAL",
        },
      })
    ).toBe(1)
    expect((await reserveStateOf(prisma, playerId)).balance.toFixed(2)).toBe(
      "3000.00"
    )
    // Otro retiro por más de lo libre: rechazado (no se compromete dos veces).
    await expect(
      requestWithdrawal(cashier, {
        playerId,
        amount: "4000",
        reason: "Segundo retiro mayor a la reserva libre",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/3000\.00/)
    const k = key()
    await Promise.allSettled([
      disburseWithdrawal(cashier, w.withdrawalId, {
        amount: "1000",
        method: "CASH",
        funding: "ADMIN_CUSTODY",
        idempotencyKey: k,
      }),
      disburseWithdrawal(cashier, w.withdrawalId, {
        amount: "1000",
        method: "CASH",
        funding: "ADMIN_CUSTODY",
        idempotencyKey: k,
      }),
    ])
    expect((await shareAccount()).toFixed(2)).toBe("1000.00")
    const ww = await prisma.bankingReserveWithdrawal.findUniqueOrThrow({
      where: { id: w.withdrawalId },
    })
    expect(ww.status).toBe("PARTIALLY_PAID")
    await expect(
      disburseWithdrawal(cashier, w.withdrawalId, {
        amount: "1500",
        method: "CASH",
        funding: "ADMIN_CUSTODY",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/aprobado pendiente/)
    // Cerrar el remanente lo regresa a la reserva (una vez).
    await closeWithdrawal(cashier, w.withdrawalId, {
      reason: "El jugador ya no requiere el resto",
      idempotencyKey: key(),
    })
    expect((await reserveStateOf(prisma, playerId)).balance.toFixed(2)).toBe(
      "4000.00"
    )
    expect(
      (await auditRows("BANKING_RESERVE_WITHDRAWAL_APPROVED")).length
    ).toBe(1)
    expect((await auditRows("BANKING_RESERVE_WITHDRAWAL_PAID")).length).toBe(1)
  })
})

// ── Escenario G ───────────────────────────────────────────────────────

describe("Escenario G — privacidad", () => {
  it("la mesa muestra igual a un bancado y a un jugador normal; nada privado se filtra", async () => {
    const { playerId } = await bank("50")
    const sid = await openNight()
    const banked = await seat(sid, playerId)
    const normalPlayer = (await createTestPlayer()).id
    const normal = await seat(sid, normalPlayer)
    await financed(banked, "1000")
    await cashBuy(normal, "1000")
    const board = await getTableBoard(sid, t25, { showPhone: false })
    const all = [
      ...board.seats.map((s) => s.occupant),
      ...board.unseated,
    ].filter(Boolean)
    const b = all.find((o) => o!.player.id === playerId)!
    const n = all.find((o) => o!.player.id === normalPlayer)!
    const shape = (o: object): unknown =>
      Object.fromEntries(
        Object.entries(o).map(([k, v]) => [
          k,
          v && typeof v === "object" && !Array.isArray(v) ? shape(v) : typeof v,
        ])
      )
    expect(shape(b)).toEqual(shape(n))
    expect(b.state).toBe(n.state)
    expect(b.sessionNominal).toBe(n.sessionNominal)
    expect(b.debt).toEqual(n.debt)
    signInAs({ ...cashier._user, isActive: true })
    const api = await call(boardRoute.GET, {
      params: { id: sid, tableId: t25 },
    })
    expect(api.status).toBe(200)
    expect(api.text).not.toMatch(
      /bank|HOUSE|fundingSource|reserv|anticip|porcentaje|agreement/i
    )
    // La compra financiada en el detalle ordinario: sin el campo de origen.
    const purchase = await prisma.chipPurchase.findFirstOrThrow({
      where: { playerId },
    })
    expect(JSON.stringify(await getPurchase(purchase.id))).not.toMatch(
      /fundingSource|HOUSE/
    )
    // Listado general: sin saldo por cobrar ni «firma requerida» inventados.
    const list = await listPurchases(
      purchasesQuerySchema.parse({ playerId, page: "1", pageSize: "50" })
    )
    expect(list.items[0]).toMatchObject({
      outstanding: "0.00",
      signature: "NOT_REQUIRED",
      hadCredit: false,
    })
    expect(JSON.stringify(list)).not.toMatch(/fundingSource|HOUSE/)
    // La auditoría general sin `banking:read` no expone eventos de bancaje.
    const hidden = await listAuditEvents(
      { page: 1, pageSize: 200 },
      { canSecurity: false, canInfrastructure: false, canBanking: false }
    )
    expect(JSON.stringify(hidden)).not.toMatch(/BANKING_/)
    const visible = await listAuditEvents(
      { page: 1, pageSize: 200 },
      { canSecurity: false, canInfrastructure: false, canBanking: true }
    )
    expect(JSON.stringify(visible)).toMatch(
      /BANKING_FINANCED_PURCHASE_DELIVERED/
    )
  })

  it("endpoints privados: 401 sin sesión, 403 sin permiso de aprobación; CASHIER consulta lo necesario", async () => {
    const { playerId } = await bank("50")
    signOut()
    expect((await call(dashboardRoute.GET)).status).toBe(401)
    expect(
      (await call(playerRoute.GET, { params: { id: playerId } })).status
    ).toBe(401)
    signInAs({ ...cashier._user, isActive: true })
    expect((await call(dashboardRoute.GET)).status).toBe(200)
    expect(
      (await call(playerRoute.GET, { params: { id: playerId } })).status
    ).toBe(200)
    const other = await createTestPlayer()
    const created = await call(agreementsRoute.POST, {
      method: "POST",
      body: {
        playerId: other.id,
        playerPercent: "50",
        reason: "Intento de crear acuerdo sin ser socio",
        idempotencyKey: key(),
      },
    })
    expect(created.status).toBe(403)
    const cycleFake = await call(approveClosingRoute.POST, {
      method: "POST",
      params: { id: "cycle_inexistente" },
      body: {
        closingId: "x",
        snapshotHash: "a".repeat(64),
        idempotencyKey: key(),
      },
    })
    expect(cycleFake.status).toBe(403)
    // Campos no previstos → 400 (p. ej. inventar un aprobador).
    signInAs({ ...partner._user, isActive: true })
    const extra = await call(agreementsRoute.POST, {
      method: "POST",
      body: {
        playerId: other.id,
        playerPercent: "50",
        reason: "Acuerdo con un campo inventado",
        approvedById: admin.id,
        idempotencyKey: key(),
      },
    })
    expect(extra.status).toBe(400)
    // Porcentaje fuera de rango → 400.
    const bad = await call(agreementsRoute.POST, {
      method: "POST",
      body: {
        playerId: other.id,
        playerPercent: "120",
        reason: "Porcentaje imposible del jugador",
        idempotencyKey: key(),
      },
    })
    expect(bad.status).toBe(400)
  })

  it("XLSX privado auditado y vista del jugador sin datos en la mesa", async () => {
    const { playerId } = await bank("50")
    await night(playerId, ["1000"], "2000")
    const x = await buildBankingXlsx({ id: partner.id, name: partner.name })
    expect(x.fileName).toBe("PokerManager_Bancaje.xlsx")
    expect(x.buffer.length).toBeGreaterThan(1000)
    expect((await auditRows("BANKING_REPORT_EXPORTED"))[0]).toMatchObject({
      module: "BANKING",
    })
    const v = await getBankedPlayer(playerId)
    expect(v.agreement?.playerPercent).toBe("50.00")
    expect(v.cycles[0]).toMatchObject({
      number: 1,
      confirmed: 1,
      net: "1000.00",
    })
  })
})

// ── Concurrencia, correcciones y rechazos ─────────────────────────────

describe("concurrencia y correcciones", () => {
  it("doble conciliación simultánea: una sola jugada confirmada y una sola devolución", async () => {
    const { playerId } = await bank()
    const sid = await openNight()
    const pid = await seat(sid, playerId)
    await financed(pid, "1000")
    const g = await gameOf(playerId, sid)
    const results = await Promise.allSettled([
      reconcile(g.id, "1000"),
      reconcile(g.id, "1000"),
    ])
    expect(
      results.filter((r) => r.status === "fulfilled").length
    ).toBeGreaterThanOrEqual(1)
    expect(
      await prisma.chipInventoryOperation.count({
        where: { referenceType: "BankingGame", referenceId: g.id },
      })
    ).toBe(1)
  })

  it("dos anticipos simultáneos no superan el límite garantizado", async () => {
    const { playerId } = await bank("50")
    await fundCustody(cashier, "5000")
    const n1 = await night(playerId, ["1000"], "3000") // 1,000 garantizado
    const reg = () =>
      registerAdvance(cashier, {
        playerId,
        enablingGameId: n1.gameId,
        requestedAmount: "800",
        authorizedAmount: "800",
        authorizerId: partner.id,
        channel: "VERBAL",
        idempotencyKey: key(),
      })
    const r = await Promise.allSettled([reg(), reg()])
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1)
  })

  it("dos socios aprobando a la vez: un solo corte aprobado; ajuste de jugada invalida la revisión", async () => {
    const { playerId } = await bank("50")
    for (const r of ["2000", "1000", "1000", "1000"])
      await night(playerId, ["1000"], r)
    const cycle = await cycleOf(playerId)
    await cut(cycle.id, "0", "500")
    // Corrección auditada: una recompra omitida (−200) invalida el corte en revisión.
    const g1 = await prisma.bankingGame.findFirstOrThrow({
      where: { cycleId: cycle.id, gameNumber: 1 },
    })
    await expect(
      adjustGame(cashier, g1.id, {
        amount: "-200",
        reason: "Recompra omitida en la captura",
        idempotencyKey: key(),
      })
    ).resolves.toBeTruthy() // el servicio no autoriza: la RUTA exige banking:approve
    expect(
      await prisma.bankingCycleClosing.count({
        where: { cycleId: cycle.id, status: "SUPERSEDED" },
      })
    ).toBe(1)
    await cut(cycle.id, "0", "400")
    const c = await prisma.bankingCycleClosing.findFirstOrThrow({
      where: { cycleId: cycle.id, status: "UNDER_REVIEW" },
    })
    const results = await Promise.allSettled([
      approveClosing(partner, cycle.id, {
        closingId: c.id,
        snapshotHash: c.snapshotHash,
        idempotencyKey: key(),
      }),
      approveClosing(admin, cycle.id, {
        closingId: c.id,
        snapshotHash: c.snapshotHash,
        idempotencyKey: key(),
      }),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(
      await prisma.bankingCycleClosing.count({
        where: { cycleId: cycle.id, status: "APPROVED" },
      })
    ).toBe(1)
    expect(
      await prisma.specialPayable.count({
        where: { kind: "BANKING_CYCLE_PAYOUT" },
      })
    ).toBe(1)
    // El resultado original se conserva; el ajuste no se aplica a un ciclo cerrado.
    expect(
      (
        await prisma.bankingGame.findUniqueOrThrow({ where: { id: g1.id } })
      ).grossResult?.toFixed(2)
    ).toBe("1000.00")
    await expect(
      adjustGame(partner, g1.id, {
        amount: "100",
        reason: "Intento sobre ciclo cerrado",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/cerrado/)
  })

  it("rechazar un corte vuelve el ciclo a revisión; la sesión CLOSED no se toca", async () => {
    const { playerId } = await bank("50")
    for (const r of ["2000", "1000", "1000", "1000"])
      await night(playerId, ["1000"], r)
    const cycle = await cycleOf(playerId)
    const { closingId } = await cut(cycle.id, "0", "500")
    await rejectClosing(partner, cycle.id, {
      closingId,
      notes: "Revisar con el jugador antes de aprobar",
      idempotencyKey: key(),
    })
    expect(
      (await prisma.bankingCycle.findUniqueOrThrow({ where: { id: cycle.id } }))
        .status
    ).toBe("READY_FOR_REVIEW")
    const closedSessions = await prisma.pokerSession.findMany({
      where: { status: "CLOSED" },
    })
    expect(closedSessions).toHaveLength(4)
    // Ningún asiento de caja apunta a sesiones cerradas después de su cierre.
    for (const s of closedSessions) {
      const late = await prisma.cashTransaction.count({
        where: { sessionId: s.id, createdAt: { gt: s.closedAt! } },
      })
      expect(late).toBe(0)
    }
  })
})
