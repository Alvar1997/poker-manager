import { randomUUID } from "node:crypto"

import { beforeEach, describe, expect, it } from "vitest"

import * as appearanceRoute from "@/app/api/tables/[id]/appearance/route"
import * as assignRoute from "@/app/api/sessions/[id]/tables/[tableId]/seats/[seatNumber]/assign/route"
import * as boardRoute from "@/app/api/sessions/[id]/tables/[tableId]/seats/route"
import * as candidatesRoute from "@/app/api/sessions/[id]/tables/[tableId]/seat-candidates/route"
import * as dealersRoute from "@/app/api/dealers/route"
import * as withdrawRoute from "@/app/api/sessions/[id]/participations/[participationId]/withdraw/route"
import { prisma } from "@/lib/prisma"
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
import { setTableFeltColor } from "@/modules/table-floor/appearance.service"
import {
  assignDealer,
  createDealer,
  getDealerHistory,
  releaseDealer,
  updateDealer,
} from "@/modules/table-floor/dealer.service"
import {
  assignSeat,
  changeSeat,
  getSeatHistory,
  getTableBoard,
  searchSeatCandidates,
  withdrawWithoutPurchase,
} from "@/modules/table-floor/seat.service"

import {
  auditRows,
  call,
  createTestPlayer,
  createUser,
  resetDatabase,
  signInAs,
  signOut,
} from "./helpers"

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
const STROKES: [number, number][][] = [
  Array.from({ length: 40 }, (_, i): [number, number] => [
    100 + i * 20,
    Math.round(200 + 120 * Math.sin(i / 3)),
  ]),
  Array.from({ length: 15 }, (_, i): [number, number] => [150 + i * 50, 360]),
]

let cashier: Actor
let partner: Actor
let sessionId: string
let t25: string
let t10: string

async function openRealSession() {
  const s = await createSession(cashier, { idempotencyKey: key() })
  await prepareSession(cashier, s.id)
  const { count } = await createOpeningChipCount(cashier, s.id)
  await updateStockCount(cashier, count.id, {
    lines: count.details.map((d) => ({
      denominationId: d.denominationId,
      countedQuantity: d.expectedQuantity,
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
  signOut()
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
  await openSessionTable(cashier, sessionId, t25, { idempotencyKey: key() })
})

const board = (tableId = t25) =>
  getTableBoard(sessionId, tableId, { showPhone: true })
const seatOf = async (seatNumber: number, tableId = t25) =>
  (await board(tableId)).seats.find((s) => s.seatNumber === seatNumber)!
    .occupant

async function sit(seatNumber: number, playerId?: string, tableId = t25) {
  const pid = playerId ?? (await createTestPlayer()).id
  const r = await assignSeat(cashier, sessionId, tableId, seatNumber, {
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
  return confirmReturn(cashier, settlementId, {
    expectedVersion: s.version,
    chipsReceived: true,
    ...(Number(s.returnedNominalAmount) === 0
      ? { zeroReturnConfirmed: true as const }
      : {}),
    idempotencyKey: key(),
  })
}

async function moneyAndChips() {
  return {
    cash: await prisma.cashTransaction.count(),
    entries: await prisma.cashTransactionEntry.count(),
    chipMoves: await prisma.chipInventoryMovement.count(),
    nominalMoves: await prisma.chipNominalMovement.count(),
    reservations: await prisma.chipReservation.count(),
    purchases: await prisma.chipPurchase.count(),
    debts: await prisma.playerDebt.count(),
    signatures: await prisma.purchaseSignature.count(),
    settlements: await prisma.playerSettlement.count(),
  }
}

describe("mesa de nueve asientos", () => {
  it("muestra nueve asientos libres con numeración fija, sin dealer y paño por defecto", async () => {
    const b = await board()
    expect(b.seats.map((s) => s.seatNumber)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ])
    expect(b.seats.every((s) => s.occupant === null)).toBe(true)
    expect(b.dealer).toBeNull()
    expect(b.table.feltColor).toBe("CASINO_GREEN")
    expect(b.table.cycle?.number).toBe(1)
  })

  it("sentar a un jugador lo deja PENDIENTE DE COMPRA sin dinero, fichas, compra, firma ni deuda", async () => {
    const before = await moneyAndChips()
    const { participationId } = await sit(3)
    const o = await seatOf(3)
    expect(o).toMatchObject({
      participationId,
      state: "PENDING_BUY",
      sessionPurchases: 0,
      rebuys: 0,
      sessionNominal: "0.00",
      nextPurchase: { purchaseType: "INITIAL_PURCHASE", rebuyNumber: null },
      debt: { global: "0.00", hasDebt: false },
    })
    expect(await moneyAndChips()).toEqual(before)
    expect(await auditRows("SEAT_ASSIGNED")).toHaveLength(1)
    expect(await auditRows("PLAYER_SEATED_PENDING_BUY")).toHaveLength(1)
    expect(await auditRows("TABLE_PLAYER_JOINED")).toHaveLength(1)
  })

  it("rechaza un asiento ocupado y un jugador activo en otra mesa; el reintento con la misma clave es idempotente", async () => {
    const p = await createTestPlayer()
    const k = key()
    const first = await assignSeat(cashier, sessionId, t25, 1, {
      playerId: p.id,
      idempotencyKey: k,
    })
    const again = await assignSeat(cashier, sessionId, t25, 1, {
      playerId: p.id,
      idempotencyKey: k,
    })
    expect(again).toMatchObject({
      replayed: true,
      participationId: first.participationId,
    })
    const other = await createTestPlayer()
    await expect(
      assignSeat(cashier, sessionId, t25, 1, {
        playerId: other.id,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/asiento ya está ocupado/)
    await openSessionTable(cashier, sessionId, t10, { idempotencyKey: key() })
    await expect(
      assignSeat(cashier, sessionId, t10, 4, {
        playerId: p.id,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/activo en la/)
    expect(await prisma.tableSeatAssignment.count()).toBe(1)
  })

  it("concurrencia: dos operadores sobre el mismo asiento → solo uno lo ocupa", async () => {
    const [a, b] = [await createTestPlayer(), await createTestPlayer()]
    const results = await Promise.allSettled([
      assignSeat(cashier, sessionId, t25, 5, {
        playerId: a.id,
        idempotencyKey: key(),
      }),
      assignSeat(cashier, sessionId, t25, 5, {
        playerId: b.id,
        idempotencyKey: key(),
      }),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(
      await prisma.tableSeatAssignment.count({
        where: { seatNumber: 5, releasedAt: null },
      })
    ).toBe(1)
    // Solo existe una participación: la otra se revirtió con su transacción.
    expect(
      await prisma.tableParticipation.count({ where: { status: "ACTIVE" } })
    ).toBe(1)
  })

  it("concurrencia: el mismo jugador en las dos mesas a la vez → una sola participación activa", async () => {
    await openSessionTable(cashier, sessionId, t10, { idempotencyKey: key() })
    const p = await createTestPlayer()
    const results = await Promise.allSettled([
      assignSeat(cashier, sessionId, t25, 2, {
        playerId: p.id,
        idempotencyKey: key(),
      }),
      assignSeat(cashier, sessionId, t10, 2, {
        playerId: p.id,
        idempotencyKey: key(),
      }),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(
      await prisma.tableParticipation.count({
        where: { playerId: p.id, status: "ACTIVE" },
      })
    ).toBe(1)
    expect(await prisma.tableSeatAssignment.count()).toBe(1)
  })

  it("un jugador activo sin asiento (registro anterior) puede ocupar uno libre", async () => {
    const p = await createTestPlayer()
    const { participationId } = await addPlayerToTable(
      cashier,
      sessionId,
      t25,
      {
        playerId: p.id,
        idempotencyKey: key(),
      }
    )
    expect((await board()).unseated.map((u) => u.participationId)).toEqual([
      participationId,
    ])
    await assignSeat(cashier, sessionId, t25, 9, {
      participationId,
      idempotencyKey: key(),
    })
    const b = await board()
    expect(b.unseated).toHaveLength(0)
    expect(b.seats[8].occupant?.participationId).toBe(participationId)
  })
})

describe("compra inicial y recompras desde el asiento", () => {
  it("la primera compra confirmada es inicial y las siguientes recompras; el asiento lo refleja", async () => {
    const { participationId } = await sit(4)
    await cashBuy(participationId, "1000")
    let o = await seatOf(4)
    expect(o).toMatchObject({
      state: "PLAYING",
      sessionPurchases: 1,
      rebuys: 0,
      sessionNominal: "1000.00",
      nextPurchase: { purchaseType: "REBUY", rebuyNumber: 1 },
    })
    await cashBuy(participationId, "500")
    o = await seatOf(4)
    expect(o).toMatchObject({
      sessionPurchases: 2,
      rebuys: 1,
      sessionNominal: "1500.00",
      nextPurchase: { purchaseType: "REBUY", rebuyNumber: 2 },
    })
    const list = await listPurchases({
      sessionId,
      page: 1,
      pageSize: 10,
    } as Parameters<typeof listPurchases>[0])
    const types = list.items
      .map((p) => [p.purchaseType, p.rebuyNumber])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    expect(types).toEqual([
      ["INITIAL_PURCHASE", null],
      ["REBUY", 1],
    ])
  })

  it("una compra en preparación se muestra como «compra en curso» y no cuenta como confirmada", async () => {
    const { participationId } = await sit(6)
    const { purchaseId } = await createPurchase(cashier, {
      participationId,
      nominalAmount: "2000",
      idempotencyKey: key(),
    })
    const o = await seatOf(6)
    expect(o).toMatchObject({
      state: "PURCHASE_IN_PROGRESS",
      sessionPurchases: 0,
      pendingPurchase: { id: purchaseId, status: "DRAFT" },
      nextPurchase: { purchaseType: "INITIAL_PURCHASE" },
    })
  })

  it("una compra a crédito (socio + firma + entrega) aparece como deuda global y de la sesión", async () => {
    const { participationId } = await sit(7)
    await creditBuy(participationId, "3000")
    const o = await seatOf(7)
    expect(o?.debt).toEqual({
      global: "3000.00",
      session: "3000.00",
      hasDebt: true,
    })
    expect(await prisma.playerDebt.count()).toBe(1)
  })
})

describe("cambio de asiento", () => {
  it("cambia de asiento sin tocar caja, inventario ni compras y conserva el historial", async () => {
    const { participationId } = await sit(1)
    await cashBuy(participationId, "500")
    const before = await moneyAndChips()
    await changeSeat(cashier, sessionId, t25, {
      participationId,
      toSeat: 8,
      idempotencyKey: key(),
    })
    expect(await moneyAndChips()).toEqual(before)
    const b = await board()
    expect(b.seats[0].occupant).toBeNull()
    expect(b.seats[7].occupant?.participationId).toBe(participationId)
    expect(b.seats[7].occupant?.sessionPurchases).toBe(1)
    const history = await getSeatHistory(sessionId, t25)
    expect(
      history.map((h) => [h.seatNumber, h.fromSeat, h.releaseReason])
    ).toEqual([
      [8, 1, null],
      [1, null, "SEAT_CHANGE"],
    ])
    expect(await auditRows("SEAT_CHANGED")).toHaveLength(1)
  })

  it("rechaza un asiento destino ocupado (sin intercambio) y es idempotente", async () => {
    const a = await sit(1)
    await sit(2)
    await expect(
      changeSeat(cashier, sessionId, t25, {
        participationId: a.participationId,
        toSeat: 2,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/asiento ya está ocupado/)
    const k = key()
    await changeSeat(cashier, sessionId, t25, {
      participationId: a.participationId,
      toSeat: 3,
      idempotencyKey: k,
    })
    const again = await changeSeat(cashier, sessionId, t25, {
      participationId: a.participationId,
      toSeat: 3,
      idempotencyKey: k,
    })
    expect(again.replayed).toBe(true)
    expect(await auditRows("SEAT_CHANGED")).toHaveLength(1)
  })

  it("concurrencia: dos jugadores hacia el mismo asiento libre → uno lo obtiene", async () => {
    const a = await sit(1)
    const b = await sit(2)
    const results = await Promise.allSettled([
      changeSeat(cashier, sessionId, t25, {
        participationId: a.participationId,
        toSeat: 9,
        idempotencyKey: key(),
      }),
      changeSeat(cashier, sessionId, t25, {
        participationId: b.participationId,
        toSeat: 9,
        idempotencyKey: key(),
      }),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(
      await prisma.tableSeatAssignment.count({ where: { releasedAt: null } })
    ).toBe(2)
  })
})

describe("transferencia con asiento destino", () => {
  it("libera el asiento de origen, ocupa el destino y la recompra sigue la secuencia de la sesión", async () => {
    await openSessionTable(cashier, sessionId, t10, { idempotencyKey: key() })
    const { participationId, playerId } = await sit(5)
    await cashBuy(participationId, "1000")
    await cashBuy(participationId, "500")
    const before = await moneyAndChips()
    await transferPlayer(cashier, sessionId, {
      sourceParticipationId: participationId,
      destinationTableId: t10,
      destinationSeatNumber: 2,
      idempotencyKey: key(),
    })
    expect(await moneyAndChips()).toEqual(before)
    expect((await board()).seats[4].occupant).toBeNull()
    const dest = (await board(t10)).seats[1].occupant!
    expect(dest.player.id).toBe(playerId)
    expect(dest).toMatchObject({
      state: "PLAYING",
      sessionPurchases: 2,
      rebuys: 1,
      nextPurchase: { purchaseType: "REBUY", rebuyNumber: 2 },
    })
    // La recompra en la mesa destino continúa la numeración (no reinicia).
    const pid = await cashBuy(dest.participationId, "500")
    const p = await getPurchase(pid)
    expect([p.purchaseType, p.rebuyNumber, p.table.name]).toEqual([
      "REBUY",
      2,
      "Mesa 10/10",
    ])
    // Solo hubo el evento de transferencia del Módulo 07 (nada duplicado).
    expect(await auditRows("TABLE_PLAYER_TRANSFERRED")).toHaveLength(1)
  })

  it("un jugador pendiente de compra sigue pendiente después de transferirse", async () => {
    await openSessionTable(cashier, sessionId, t10, { idempotencyKey: key() })
    const { participationId } = await sit(5)
    await transferPlayer(cashier, sessionId, {
      sourceParticipationId: participationId,
      destinationTableId: t10,
      destinationSeatNumber: 7,
      idempotencyKey: key(),
    })
    const o = await seatOf(7, t10)
    expect(o).toMatchObject({
      state: "PENDING_BUY",
      nextPurchase: { purchaseType: "INITIAL_PURCHASE" },
    })
  })

  it("rechaza un asiento destino ocupado sin mover al jugador", async () => {
    await openSessionTable(cashier, sessionId, t10, { idempotencyKey: key() })
    const { participationId } = await sit(5)
    await sit(3, undefined, t10)
    await expect(
      transferPlayer(cashier, sessionId, {
        sourceParticipationId: participationId,
        destinationTableId: t10,
        destinationSeatNumber: 3,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/asiento ya está ocupado/)
    expect((await seatOf(5))?.participationId).toBe(participationId)
  })
})

describe("liquidación desde el asiento", () => {
  it("al confirmar la recepción se libera el asiento; con pago pendiente queda SETTLING sin asiento", async () => {
    const { participationId } = await sit(2)
    await cashBuy(participationId, "1000")
    const r = await settle(participationId, "800")
    expect(r.settlement.status).toBe("PENDING_PAYOUT")
    const b = await board()
    expect(b.seats[1].occupant).toBeNull()
    expect(b.settlingPayout.map((s) => s.participationId)).toEqual([
      participationId,
    ])
    const seat = await prisma.tableSeatAssignment.findFirstOrThrow({
      where: { participationId },
    })
    expect(seat.releaseReason).toBe("SETTLEMENT")
    expect(await auditRows("SEAT_RELEASED")).toHaveLength(1)
  })

  it("con liquidación en curso el asiento muestra «Liquidando»", async () => {
    const { participationId } = await sit(2)
    await cashBuy(participationId, "1000")
    await createSettlement(cashier, {
      participationId,
      returnedNominalAmount: "0",
      offsetDecision: "NO_COMPENSATE",
      idempotencyKey: key(),
    })
    expect((await seatOf(2))?.state).toBe("SETTLING")
  })
})

describe("retiro sin compra", () => {
  it("retira a un jugador que nunca recibió fichas, libera el asiento y no mueve nada", async () => {
    const { participationId } = await sit(3)
    const before = await moneyAndChips()
    await withdrawWithoutPurchase(cashier, sessionId, participationId, {
      reason: "Se fue antes de comprar",
      idempotencyKey: key(),
    })
    expect(await moneyAndChips()).toEqual(before)
    const p = await prisma.tableParticipation.findUniqueOrThrow({
      where: { id: participationId },
    })
    expect([p.status, p.exitReason]).toEqual(["WITHDRAWN", "WITHDRAWAL"])
    expect((await board()).seats[2].occupant).toBeNull()
    expect(await auditRows("TABLE_PARTICIPATION_WITHDRAWN")).toHaveLength(1)
    // Repetirlo no hace nada.
    const again = await withdrawWithoutPurchase(
      cashier,
      sessionId,
      participationId,
      {
        reason: "Se fue antes de comprar",
        idempotencyKey: key(),
      }
    )
    expect(again.replayed).toBe(true)
    // La mesa ya se puede cerrar.
    await closeSessionTable(cashier, sessionId, t25, { idempotencyKey: key() })
  })

  it("rechaza retirar a quien recibió fichas (también si las compró en la mesa de origen)", async () => {
    await openSessionTable(cashier, sessionId, t10, { idempotencyKey: key() })
    const { participationId } = await sit(3)
    await cashBuy(participationId, "500")
    await expect(
      withdrawWithoutPurchase(cashier, sessionId, participationId, {
        reason: "Intento de retiro",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/recibió fichas/)
    await transferPlayer(cashier, sessionId, {
      sourceParticipationId: participationId,
      destinationTableId: t10,
      destinationSeatNumber: 1,
      idempotencyKey: key(),
    })
    const dest = (await seatOf(1, t10))!
    await expect(
      withdrawWithoutPurchase(cashier, sessionId, dest.participationId, {
        reason: "Intento de retiro",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/recibió fichas/)
    // La base también lo impide aunque se salte el servicio.
    await prisma.tableSeatAssignment.updateMany({
      where: { participationId: dest.participationId, releasedAt: null },
      data: {
        releasedAt: new Date(),
        releasedById: cashier.id,
        releaseReason: "WITHDRAWAL",
      },
    })
    await expect(
      prisma.tableParticipation.update({
        where: { id: dest.participationId },
        data: {
          status: "WITHDRAWN",
          leftAt: new Date(),
          leftById: cashier.id,
          exitReason: "WITHDRAWAL",
        },
      })
    ).rejects.toThrow(/recibió fichas/)
  })
})

describe("garantías de la base", () => {
  it("una participación no sale de ACTIVE con su asiento ocupado, y el historial no se borra", async () => {
    const { participationId } = await sit(4)
    await expect(
      prisma.tableParticipation.update({
        where: { id: participationId },
        data: {
          status: "WITHDRAWN",
          leftAt: new Date(),
          leftById: cashier.id,
          exitReason: "WITHDRAWAL",
        },
      })
    ).rejects.toThrow(/asiento ocupado/)
    await expect(prisma.tableSeatAssignment.deleteMany()).rejects.toThrow(
      /no admite DELETE/
    )
    await expect(
      prisma.tableSeatAssignment.updateMany({ data: { seatNumber: 6 } })
    ).rejects.toThrow(/Solo se registra la liberación/)
  })

  it("un ciclo no se cierra con asientos ocupados (aunque se salte el servicio)", async () => {
    await sit(4)
    const cycle = await prisma.sessionTableCycle.findFirstOrThrow({
      where: { status: "OPEN" },
    })
    await expect(
      prisma.sessionTableCycle.update({
        where: { id: cycle.id },
        data: {
          status: "CLOSED",
          closedAt: new Date(),
          closedById: cashier.id,
          closeIdempotencyKey: key(),
        },
      })
    ).rejects.toThrow(/asientos ocupados/)
  })
})

describe("dealer como persona", () => {
  it("se registra sin cuenta de acceso, no ocupa asiento y se asigna, cambia y libera con historial", async () => {
    const usersBefore = await prisma.user.count()
    const ana = await createDealer(cashier, { name: "Ana Dealer" })
    const luis = await createDealer(cashier, {
      name: "Luis Reparte",
      nickname: "Lucho",
    })
    expect(await prisma.user.count()).toBe(usersBefore)
    const before = await moneyAndChips()
    await assignDealer(cashier, sessionId, t25, {
      dealerId: ana.id,
      idempotencyKey: key(),
    })
    let b = await board()
    expect(b.dealer?.dealer.name).toBe("Ana Dealer")
    expect(b.seats.every((s) => s.occupant === null)).toBe(true)
    await assignDealer(cashier, sessionId, t25, {
      dealerId: luis.id,
      idempotencyKey: key(),
    })
    b = await board()
    expect(b.dealer?.dealer.name).toBe("Luis Reparte")
    const history = await getDealerHistory(sessionId, t25)
    expect(history.map((h) => [h.dealer.name, h.releaseReason])).toEqual([
      ["Luis Reparte", null],
      ["Ana Dealer", "CHANGED"],
    ])
    await releaseDealer(cashier, sessionId, t25, { idempotencyKey: key() })
    expect((await board()).dealer).toBeNull()
    expect(await moneyAndChips()).toEqual(before)
    expect(await auditRows("DEALER_ASSIGNED")).toHaveLength(1)
    expect(await auditRows("DEALER_CHANGED")).toHaveLength(1)
    expect(await auditRows("DEALER_RELEASED")).toHaveLength(1)
  })

  it("un dealer no está en dos mesas a la vez; cerrar la mesa lo libera; asignado no se desactiva", async () => {
    await openSessionTable(cashier, sessionId, t10, { idempotencyKey: key() })
    const ana = await createDealer(cashier, { name: "Ana Dealer" })
    await assignDealer(cashier, sessionId, t25, {
      dealerId: ana.id,
      idempotencyKey: key(),
    })
    await expect(
      assignDealer(cashier, sessionId, t10, {
        dealerId: ana.id,
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/está asignado a la/)
    await expect(
      updateDealer(cashier, ana.id, { isActive: false })
    ).rejects.toThrow(/libéralo antes/)
    await closeSessionTable(cashier, sessionId, t25, { idempotencyKey: key() })
    const released = await prisma.dealerAssignment.findFirstOrThrow({
      where: { dealerId: ana.id },
    })
    expect(released.releaseReason).toBe("CYCLE_CLOSED")
    // Ya libre: se asigna en la otra mesa.
    await assignDealer(cashier, sessionId, t10, {
      dealerId: ana.id,
      idempotencyKey: key(),
    })
    expect((await board(t10)).dealer?.dealer.id).toBe(ana.id)
  })

  it("concurrencia: dos dealers a la misma mesa al mismo tiempo → una asignación vigente", async () => {
    const a = await createDealer(cashier, { name: "Dealer Uno" })
    const b = await createDealer(cashier, { name: "Dealer Dos" })
    await Promise.allSettled([
      assignDealer(cashier, sessionId, t25, {
        dealerId: a.id,
        idempotencyKey: key(),
      }),
      assignDealer(cashier, sessionId, t25, {
        dealerId: b.id,
        idempotencyKey: key(),
      }),
    ])
    expect(
      await prisma.dealerAssignment.count({ where: { releasedAt: null } })
    ).toBe(1)
  })
})

describe("paño configurable", () => {
  it("persiste por mesa (25/25 no cambia 10/10), se audita una vez y es idempotente", async () => {
    await openSessionTable(cashier, sessionId, t10, { idempotencyKey: key() })
    const before = await moneyAndChips()
    await setTableFeltColor(cashier, t25, "NAVY")
    await setTableFeltColor(cashier, t25, "NAVY")
    expect((await board()).table.feltColor).toBe("NAVY")
    expect((await board(t10)).table.feltColor).toBe("CASINO_GREEN")
    expect(await auditRows("TABLE_FELT_COLOR_CHANGED")).toHaveLength(1)
    expect(await moneyAndChips()).toEqual(before)
    // Se conserva al cerrar y reabrir la mesa (ciclo nuevo).
    await closeSessionTable(cashier, sessionId, t25, { idempotencyKey: key() })
    await openSessionTable(cashier, sessionId, t25, { idempotencyKey: key() })
    expect((await board()).table.feltColor).toBe("NAVY")
  })
})

describe("API: autorización, validación y búsqueda", () => {
  it("sin sesión 401; CASHIER opera; campos no previstos y colores fuera de la paleta → 400", async () => {
    const p = await createTestPlayer({ name: "José Peña" })
    const params = { id: sessionId, tableId: t25, seatNumber: "3" }
    signOut()
    expect(
      (
        await call(assignRoute.POST, {
          method: "POST",
          params,
          body: { playerId: p.id, idempotencyKey: key() },
        })
      ).status
    ).toBe(401)
    signInAs(cashier._user)
    expect(
      (
        await call(assignRoute.POST, {
          method: "POST",
          params,
          body: { playerId: p.id, idempotencyKey: key(), role: "SUPERADMIN" },
        })
      ).status
    ).toBe(400)
    expect(
      (
        await call(assignRoute.POST, {
          method: "POST",
          params: { ...params, seatNumber: "10" },
          body: { playerId: p.id, idempotencyKey: key() },
        })
      ).status
    ).toBe(400)
    const ok = await call(assignRoute.POST, {
      method: "POST",
      params,
      body: { playerId: p.id, idempotencyKey: key() },
    })
    expect(ok.status).toBe(201)
    const b = await call(boardRoute.GET, {
      params: { id: sessionId, tableId: t25 },
    })
    expect(b.status).toBe(200)
    expect(
      (
        await call(appearanceRoute.PATCH, {
          method: "PATCH",
          params: { id: t25 },
          body: { feltColor: "#ffffff" },
        })
      ).status
    ).toBe(400)
    expect(
      (
        await call(appearanceRoute.PATCH, {
          method: "PATCH",
          params: { id: t25 },
          body: { feltColor: "WINE" },
        })
      ).status
    ).toBe(200)
    expect(
      (
        await call(dealersRoute.POST, {
          method: "POST",
          body: { name: "Dealer API" },
        })
      ).status
    ).toBe(201)
    const participation = await prisma.tableParticipation.findFirstOrThrow({
      where: { playerId: p.id },
    })
    expect(
      (
        await call(withdrawRoute.POST, {
          method: "POST",
          params: { id: sessionId, participationId: participation.id },
          body: { reason: "no", idempotencyKey: key() },
        })
      ).status
    ).toBe(400)
  })

  it("la búsqueda tolera acentos y explica por qué un jugador no puede sentarse", async () => {
    const jose = await createTestPlayer({ name: "José Peña", nickname: "Pepe" })
    await createTestPlayer({ name: "Josefina Ruiz" })
    await sit(1, jose.id)
    const hits = await searchSeatCandidates(sessionId, t25, "jose pena", {
      showPhone: true,
    })
    expect(hits.map((h) => h.name)).toEqual(["José Peña"])
    expect(hits[0]).toMatchObject({
      selectable: false,
      blockedReason: "Ya está activo en esta mesa.",
    })
    signInAs(cashier._user)
    const r = await call(candidatesRoute.GET, {
      path: "/api/x?q=JOSE",
      params: { id: sessionId, tableId: t25 },
    })
    expect(r.status).toBe(200)
    expect((r.json.data as { name: string }[]).map((h) => h.name)).toEqual(
      expect.arrayContaining(["José Peña", "Josefina Ruiz"])
    )
  })
})
