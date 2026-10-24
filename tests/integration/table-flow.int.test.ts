import { randomUUID } from "node:crypto"

import { beforeEach, describe, expect, it } from "vitest"

import * as createSettlementRoute from "@/app/api/settlements/route"
import { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { cashBalanceOf } from "@/modules/cash/ledger"
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
  getSettlementContext,
} from "@/modules/settlements/settlement.service"
import {
  captureSignature,
  prepareSignatureSummary,
} from "@/modules/signatures/signature.service"
import { getTableBoard } from "@/modules/table-floor/seat.service"

import {
  call,
  createTestPlayer,
  createUser,
  resetDatabase,
  signInAs,
} from "./helpers"

/**
 * Flujo de mesa (OUT, cashout con abono, compra inicial/recompra por mesa y
 * modalidades de pago) con la base de PRUEBAS y los servicios reales.
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
let t25: string
let t10: string
let sessionId: string

beforeEach(async () => {
  await resetDatabase()
  const shared = await prisma.chipSet.findUniqueOrThrow({
    where: { code: "CHIPSET_MAIN" },
  })
  const d = await prisma.chipDenomination.create({
    data: { chipSetId: shared.id, value: "500" },
  })
  cashier = await actorFor("CASHIER")
  partner = await actorFor("PARTNER")
  await initializeStock(cashier, {
    chipSetId: shared.id,
    lines: [{ denominationId: d.id, quantity: 200 }],
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

async function sit(playerId: string, tableId = t25) {
  const r = await addPlayerToTable(cashier, sessionId, tableId, {
    playerId,
    idempotencyKey: key(),
  })
  return r.participationId
}

async function buy(
  participationId: string,
  amount: string,
  mode: "CASH" | "CREDIT" | "MIXED" = "CASH",
  cash?: string
) {
  const { purchaseId } = await createPurchase(cashier, {
    participationId,
    nominalAmount: amount,
    paymentMode: mode,
    idempotencyKey: key(),
  })
  const cashAmount = mode === "CASH" ? amount : cash
  if (cashAmount)
    await recordPayment(cashier, purchaseId, {
      method: "CASH",
      amount: cashAmount,
      cashReceived: true,
      idempotencyKey: key(),
    })
  if (mode !== "CASH") {
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
  }
  const p = await getPurchase(purchaseId)
  await confirmDelivery(cashier, purchaseId, {
    expectedVersion: p.version,
    physicalDeliveryConfirmed: true,
    idempotencyKey: key(),
  })
  return getPurchase(purchaseId)
}

async function sign(settlementId: string) {
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
  return getSettlement(settlementId)
}

/** OUT: retorno $0 confirmado UNA vez, firma y confirmación sin «fichas recibidas». */
async function out(participationId: string) {
  const { settlementId } = await createSettlement(cashier, {
    participationId,
    returnedNominalAmount: "0",
    offsetDecision: "NO_COMPENSATE",
    exitKind: "OUT",
    idempotencyKey: key(),
  })
  const s = await sign(settlementId)
  await confirmReturn(cashier, settlementId, {
    expectedVersion: s.version,
    zeroReturnConfirmed: true,
    idempotencyKey: key(),
  })
  return settlementId
}

const debtOf = async (playerId: string) =>
  (await receivablesOf(prisma, playerId)).reduce(
    (a, r) => a.add(r.balance),
    D(0)
  )

describe("OUT — perdió todas sus fichas", () => {
  it("OUT con deuda y sin abono: firma, sin pantalla de recepción, sin inventario positivo; asiento libre y deuda viva", async () => {
    const player = await createTestPlayer({ name: "Juan Pérez" })
    const pid = await sit(player.id)
    await buy(pid, "2000", "CREDIT")
    const opsBefore = await prisma.chipInventoryOperation.count()
    const ctx = await getSettlementContext(pid)
    expect(ctx.purchasedInSession).toMatchObject({
      nominal: "2000.00",
      credit: "2000.00",
      paid: "0.00",
    })
    const id = await out(pid)
    const s = await prisma.playerSettlement.findUniqueOrThrow({ where: { id } })
    expect(s).toMatchObject({ exitKind: "OUT", zeroReturnConfirmed: true })
    expect(s.netPayoutAmount?.toFixed(2)).toBe("0.00")
    expect(s.signatureId).not.toBeNull()
    // Sin entrada nominal ni movimiento de dinero.
    expect(await prisma.chipInventoryOperation.count()).toBe(opsBefore)
    expect((await cashBalanceOf(prisma, sessionId)).balance.toFixed(2)).toBe(
      "0.00"
    )
    const part = await prisma.tableParticipation.findUniqueOrThrow({
      where: { id: pid },
    })
    expect(part.status).toBe("SETTLED")
    const board = await getTableBoard(sessionId, t25, { showPhone: false })
    expect(board.seats.some((x) => x.occupant?.player.id === player.id)).toBe(
      false
    )
    expect((await debtOf(player.id)).toFixed(2)).toBe("2000.00")
  })

  it("OUT exige la confirmación de retorno cero (nunca se asume) y no acepta fichas ni compensación", async () => {
    const player = await createTestPlayer()
    const pid = await sit(player.id)
    await buy(pid, "1000", "CASH")
    signInAs({ ...cashier._user, isActive: true })
    const bad = await call(createSettlementRoute.POST, {
      method: "POST",
      body: {
        participationId: pid,
        returnedNominalAmount: "500",
        offsetDecision: "NO_COMPENSATE",
        exitKind: "OUT",
        idempotencyKey: key(),
      },
    })
    expect(bad.status).toBe(400)
    const { settlementId } = await createSettlement(cashier, {
      participationId: pid,
      returnedNominalAmount: "0",
      offsetDecision: "NO_COMPENSATE",
      exitKind: "OUT",
      idempotencyKey: key(),
    })
    const s = await sign(settlementId)
    await expect(
      confirmReturn(cashier, settlementId, {
        expectedVersion: s.version,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/terminó sin fichas/)
    // La base también lo impide (no basta la pantalla).
    await expect(
      prisma.playerSettlement.update({
        where: { id: settlementId },
        data: { receivedAt: new Date(), receivedById: cashier.id },
      })
    ).rejects.toThrow()
    // Reintento con la misma clave: un solo OUT.
    const k = key()
    await Promise.allSettled([
      confirmReturn(cashier, settlementId, {
        expectedVersion: s.version,
        zeroReturnConfirmed: true,
        idempotencyKey: k,
      }),
      confirmReturn(cashier, settlementId, {
        expectedVersion: s.version,
        zeroReturnConfirmed: true,
        idempotencyKey: k,
      }),
    ])
    expect(
      (
        await prisma.playerSettlement.findUniqueOrThrow({
          where: { id: settlementId },
        })
      ).receivedAt
    ).not.toBeNull()
  })

  it("OUT con abono real parcial y completo (Módulo 10, FIFO): reduce la deuda sin devolver fichas", async () => {
    const a = await createTestPlayer({ name: "Parcial" })
    const pa = await sit(a.id)
    await buy(pa, "2000", "CREDIT")
    await registerPayment(cashier, {
      playerId: a.id,
      amount: "500",
      origin: "SESSION",
      method: "CASH",
      cashReceived: true,
      idempotencyKey: key(),
    })
    await out(pa)
    expect((await debtOf(a.id)).toFixed(2)).toBe("1500.00")
    // El abono es dinero REAL a la caja de la sesión; el OUT no mueve nada más.
    expect((await cashBalanceOf(prisma, sessionId)).balance.toFixed(2)).toBe(
      "500.00"
    )
    const b = await createTestPlayer({ name: "Completo" })
    const pb = await sit(b.id)
    await buy(pb, "1000", "CREDIT")
    await registerPayment(cashier, {
      playerId: b.id,
      amount: "1000",
      origin: "SESSION",
      method: "CASH",
      cashReceived: true,
      idempotencyKey: key(),
    })
    await out(pb)
    expect((await debtOf(b.id)).toFixed(2)).toBe("0.00")
  })
})

describe("CASHOUT con abono a deuda (compensación)", () => {
  it("crédito 2,000; devuelve 1,600; abono máximo 1,600 → deuda 400, pago 0; sin efectivo ficticio", async () => {
    const p = await createTestPlayer()
    const pid = await sit(p.id)
    await buy(pid, "2000", "CREDIT")
    const { settlementId } = await createSettlement(cashier, {
      participationId: pid,
      returnedNominalAmount: "1600",
      offsetDecision: "MAXIMUM",
      idempotencyKey: key(),
    })
    const s = await sign(settlementId)
    // Con fichas hay recepción física obligatoria.
    await expect(
      confirmReturn(cashier, settlementId, {
        expectedVersion: s.version,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/recibiste físicamente/)
    await confirmReturn(cashier, settlementId, {
      expectedVersion: s.version,
      chipsReceived: true,
      idempotencyKey: key(),
    })
    const done = await prisma.playerSettlement.findUniqueOrThrow({
      where: { id: settlementId },
    })
    expect(done.offsetAmount?.toFixed(2)).toBe("1600.00")
    expect(done.netPayoutAmount?.toFixed(2)).toBe("0.00")
    expect(done.exitKind).toBe("CASHOUT")
    expect((await debtOf(p.id)).toFixed(2)).toBe("400.00")
    expect((await cashBalanceOf(prisma, sessionId)).balance.toFixed(2)).toBe(
      "0.00"
    )
    expect(await prisma.cashTransaction.count()).toBe(0)
    const inv = await prisma.chipSetInventoryState.findFirstOrThrow()
    expect(D(inv.circulationNominal).toFixed(2)).toBe("400.00")
  })

  it("abono parcial 1,000 → deuda 1,000 y 600 por pagar; nunca más que la deuda ni que lo devuelto", async () => {
    const p = await createTestPlayer()
    const pid = await sit(p.id)
    await buy(pid, "2000", "CREDIT")
    await expect(
      createSettlement(cashier, {
        participationId: pid,
        returnedNominalAmount: "1600",
        offsetDecision: "PARTIAL",
        offsetAmount: "1700",
        idempotencyKey: key(),
      })
    ).rejects.toThrow()
    const { settlementId } = await createSettlement(cashier, {
      participationId: pid,
      returnedNominalAmount: "1600",
      offsetDecision: "PARTIAL",
      offsetAmount: "1000",
      idempotencyKey: key(),
    })
    const s = await sign(settlementId)
    await confirmReturn(cashier, settlementId, {
      expectedVersion: s.version,
      chipsReceived: true,
      idempotencyKey: key(),
    })
    const done = await prisma.playerSettlement.findUniqueOrThrow({
      where: { id: settlementId },
      include: { payable: true },
    })
    expect(done.netPayoutAmount?.toFixed(2)).toBe("600.00")
    expect(done.payable?.originalAmount.toFixed(2)).toBe("600.00")
    expect((await debtOf(p.id)).toFixed(2)).toBe("1000.00")
  })
})

describe("compra inicial / recompra POR MESA", () => {
  it("25/25 inicial → OUT → 10/10 inicial → OUT → regresa a 25/25: recompra; reapertura conserva el historial", async () => {
    const juan = await createTestPlayer({ name: "Juan" })
    let pid = await sit(juan.id, t25)
    const first = await buy(pid, "2000")
    expect(first).toMatchObject({
      purchaseType: "INITIAL_PURCHASE",
      sequenceNumber: 1,
    })
    await out(pid)
    pid = await sit(juan.id, t10)
    const board10 = await getTableBoard(sessionId, t10, { showPhone: false })
    expect(
      board10.unseated.find((o) => o.player.id === juan.id)?.nextPurchase
    ).toMatchObject({
      purchaseType: "INITIAL_PURCHASE",
    })
    const second = await buy(pid, "1000")
    expect(second).toMatchObject({
      purchaseType: "INITIAL_PURCHASE",
      sequenceNumber: 2,
      rebuyNumber: null,
    })
    const rebuy10 = await buy(pid, "500")
    expect(rebuy10).toMatchObject({ purchaseType: "REBUY", rebuyNumber: 1 })
    await out(pid)
    // La mesa 25/25 se cierra y se reabre: misma mesa lógica.
    await closeSessionTable(cashier, sessionId, t25, { idempotencyKey: key() })
    await openSessionTable(cashier, sessionId, t25, { idempotencyKey: key() })
    pid = await sit(juan.id, t25)
    const back = await buy(pid, "1000")
    expect(back).toMatchObject({
      purchaseType: "REBUY",
      rebuyNumber: 1,
      sequenceNumber: 4,
    })
  })

  it("transferencia SIN liquidar conserva el tratamiento: compra en la mesa destino = recompra; sin fichas ni compras nuevas por transferir", async () => {
    const ana = await createTestPlayer({ name: "Ana" })
    const pid = await sit(ana.id, t25)
    await buy(pid, "2000")
    const movements = await prisma.chipNominalMovement.count()
    await transferPlayer(cashier, sessionId, {
      sourceParticipationId: pid,
      destinationTableId: t10,
      idempotencyKey: key(),
    })
    expect(await prisma.chipNominalMovement.count()).toBe(movements)
    expect(
      await prisma.chipPurchase.count({ where: { playerId: ana.id } })
    ).toBe(1)
    const dest = await prisma.tableParticipation.findFirstOrThrow({
      where: { playerId: ana.id, status: "ACTIVE" },
    })
    const after = await buy(dest.id, "1000")
    expect(after).toMatchObject({ purchaseType: "REBUY", rebuyNumber: 1 })
    expect(
      await prisma.tableParticipation.count({
        where: { playerId: ana.id, status: "ACTIVE" },
      })
    ).toBe(1)
  })
})

describe("modalidades de pago (el servidor valida, no solo la pantalla)", () => {
  it("CRÉDITO TOTAL no acepta efectivo ni genera entrada a caja; EFECTIVO no acepta transferencias ni pagos parciales", async () => {
    const p = await createTestPlayer()
    const pid = await sit(p.id)
    const { purchaseId } = await createPurchase(cashier, {
      participationId: pid,
      nominalAmount: "2000",
      paymentMode: "CREDIT",
      idempotencyKey: key(),
    })
    await expect(
      recordPayment(cashier, purchaseId, {
        method: "CASH",
        amount: "500",
        cashReceived: true,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/CRÉDITO TOTAL/)
    expect((await getPurchase(purchaseId)).paymentMode).toBe("CREDIT")
    const q = await createTestPlayer()
    const qid = await sit(q.id)
    const cash = await createPurchase(cashier, {
      participationId: qid,
      nominalAmount: "1000",
      paymentMode: "CASH",
      idempotencyKey: key(),
    })
    await expect(
      recordPayment(cashier, cash.purchaseId, {
        method: "BANK_TRANSFER",
        amount: "1000",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/Pago mixto/)
    await recordPayment(cashier, cash.purchaseId, {
      method: "CASH",
      amount: "600",
      cashReceived: true,
      idempotencyKey: key(),
    })
    const v = await getPurchase(cash.purchaseId)
    await expect(
      confirmDelivery(cashier, cash.purchaseId, {
        expectedVersion: v.version,
        physicalDeliveryConfirmed: true,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/Pago mixto/)
  })

  it("PAGO MIXTO separa componentes: 500 efectivo + 1,500 crédito", async () => {
    const p = await createTestPlayer()
    const pid = await sit(p.id)
    const done = await buy(pid, "2000", "MIXED", "500")
    expect(done.status).toBe("CONFIRMED")
    expect(done.paymentMode).toBe("MIXED")
    expect(done.financials.confirmedCash).toBe("500.00")
    expect(done.debt?.originalAmount).toBe("1500.00")
    expect((await cashBalanceOf(prisma, sessionId)).balance.toFixed(2)).toBe(
      "500.00"
    )
  })

  it("crédito total confirmado: deuda por todo y caja sin movimientos", async () => {
    const p = await createTestPlayer()
    const pid = await sit(p.id)
    const done = await buy(pid, "2000", "CREDIT")
    expect(done.debt?.originalAmount).toBe("2000.00")
    expect(await prisma.cashTransaction.count()).toBe(0)
  })
})
