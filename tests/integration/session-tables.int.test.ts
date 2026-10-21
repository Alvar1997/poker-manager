import { randomUUID } from "node:crypto"

import { beforeEach, describe, expect, it } from "vitest"

import * as closeRoute from "@/app/api/sessions/[id]/tables/[tableId]/close/route"
import * as openTableRoute from "@/app/api/sessions/[id]/tables/[tableId]/open/route"
import * as playersRoute from "@/app/api/sessions/[id]/tables/[tableId]/players/route"
import * as participationRoute from "@/app/api/sessions/[id]/participations/[participationId]/route"
import * as tablesRoute from "@/app/api/sessions/[id]/tables/route"
import * as transfersRoute from "@/app/api/sessions/[id]/table-transfers/route"
import { prisma } from "@/lib/prisma"
import {
  confirmStockCount,
  initializeStock,
  updateStockCount,
} from "@/modules/inventory/stock-count.service"
import {
  addPlayerToTable,
  completeParticipationFromSettlementInTx,
  listParticipations,
  transferPlayer,
  validateParticipationForPurchase,
} from "@/modules/session-tables/participation.service"
import {
  closeSessionTable,
  getOpenTablesAndPendingParticipants,
  getSessionTables,
  getTableCycles,
  getTableHistory,
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
import { settlementVerifier } from "@/modules/settlements/settlement-core"
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
let sessionId: string
let t25: string
let t10: string

/** Sesión real: inventario compartido contado + caja en $0 + apertura. */
async function openRealSession(actor: Actor, open = true) {
  const s = await createSession(actor, { idempotencyKey: key() })
  await prepareSession(actor, s.id)
  if (!open) return s.id
  const { count } = await createOpeningChipCount(actor, s.id)
  await updateStockCount(actor, count.id, {
    lines: count.details.map((d) => ({
      denominationId: d.denominationId,
      countedQuantity: d.expectedQuantity,
    })),
  })
  await confirmStockCount(actor, count.id, key())
  await confirmOpeningCashCount(actor, s.id, {
    countedAmount: "0",
    physicallyVerified: true,
  })
  await openSession(actor, s.id, { idempotencyKey: key() })
  return s.id
}

beforeEach(async () => {
  await resetDatabase()
  const shared = await prisma.chipSet.findUniqueOrThrow({
    where: { code: "CHIPSET_MAIN" },
  })
  const d = await prisma.chipDenomination.create({
    data: { chipSetId: shared.id, value: "100" },
  })
  cashier = await actorFor("CASHIER")
  await initializeStock(cashier, {
    chipSetId: shared.id,
    lines: [{ denominationId: d.id, quantity: 100 }],
    idempotencyKey: key(),
  })
  sessionId = await openRealSession(cashier)
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

const open = (tableId: string, actor: Actor = cashier, k = key()) =>
  openSessionTable(actor, sessionId, tableId, { idempotencyKey: k })
const close = (tableId: string, actor: Actor = cashier, k = key()) =>
  closeSessionTable(actor, sessionId, tableId, { idempotencyKey: k })
const join = (
  tableId: string,
  playerId: string,
  actor: Actor = cashier,
  k = key()
) =>
  addPlayerToTable(actor, sessionId, tableId, { playerId, idempotencyKey: k })
const activeOf = async (playerId: string) =>
  prisma.tableParticipation.findFirstOrThrow({
    where: { sessionId, playerId, status: "ACTIVE" },
  })

async function financialAndInventorySnapshot() {
  return {
    cash: await prisma.cashTransaction.count(),
    balances: await prisma.financialAccountBalance.count(),
    chipMoves: await prisma.chipInventoryMovement.count(),
    nominalMoves: await prisma.chipNominalMovement.count(),
    reservations: await prisma.chipReservation.count(),
    cashBoxes: await prisma.cashBox.count(),
    chipSets: await prisma.chipSet.count({ where: { isActive: true } }),
  }
}

describe("apertura, cierre y reapertura de mesas", () => {
  it("abre una mesa en sesión OPEN, sin jugadores, sin dinero ni fichas, con hora del servidor", async () => {
    const before = await financialAndInventorySnapshot()
    const t0 = Date.now()
    const { table } = await open(t25)
    expect(table).toMatchObject({
      status: "OPEN",
      activePlayers: 0,
      currentCycle: { number: 1 },
      blinds: { small: "25.00", big: "25.00" },
    })
    expect(
      new Date(table.currentCycle!.openedAt).getTime()
    ).toBeGreaterThanOrEqual(t0 - 5)
    expect(await financialAndInventorySnapshot()).toEqual(before)
    expect(await auditRows("SESSION_TABLE_OPENED")).toHaveLength(1)
    // La sesión sigue OPEN; la otra mesa sigue PENDING.
    const tables = await getSessionTables(sessionId)
    expect(tables.find((t) => t.tableId === t10)?.status).toBe("PENDING")
  })

  it("una sesión puede estar OPEN con ambas mesas abiertas, sin cajas ni inventarios por mesa", async () => {
    const before = await financialAndInventorySnapshot()
    await open(t25)
    await open(t10)
    const tables = await getSessionTables(sessionId)
    expect(tables.filter((t) => t.status === "OPEN")).toHaveLength(2)
    expect(await financialAndInventorySnapshot()).toEqual(before)
  })

  it("rechaza abrir mesas si la sesión no está OPEN (preparación, cancelada)", async () => {
    await resetDatabase()
    cashier = await actorFor("CASHIER")
    sessionId = await openRealSession(cashier, false) // queda en PREPARATION
    t25 = (
      await prisma.pokerTable.findUniqueOrThrow({
        where: { code: "TABLE_25_25" },
      })
    ).id
    await expect(open(t25)).rejects.toThrow(/La sesión debe estar abierta/)
    expect(await prisma.sessionTable.count()).toBe(0)
  })

  it("cierra una mesa vacía (la otra sigue abierta) y la reabre con un ciclo nuevo conservando los anteriores", async () => {
    await open(t25)
    await open(t10)
    const { table } = await close(t25)
    expect(table).toMatchObject({ status: "CLOSED", currentCycle: null })
    expect(
      (await getSessionTables(sessionId)).find((t) => t.tableId === t10)?.status
    ).toBe("OPEN")
    expect(
      (
        await prisma.pokerSession.findUniqueOrThrow({
          where: { id: sessionId },
        })
      ).status
    ).toBe("OPEN")
    const reopened = await open(t25)
    expect(reopened.table.currentCycle?.number).toBe(2)
    const cycles = await getTableCycles(sessionId, t25)
    expect(cycles.map((c) => [c.cycleNumber, c.status])).toEqual([
      [1, "CLOSED"],
      [2, "OPEN"],
    ])
    expect(cycles[0].closedAt).not.toBeNull()
    expect(await auditRows("SESSION_TABLE_REOPENED")).toHaveLength(1)
    // El ciclo cerrado es inmutable.
    await expect(
      prisma.sessionTableCycle.update({
        where: { id: cycles[0].id },
        data: { closingNotes: "x" },
      })
    ).rejects.toThrow()
    await expect(
      prisma.sessionTableCycle.delete({ where: { id: cycles[0].id } })
    ).rejects.toThrow()
  })

  it("concurrencia: dos aperturas (o reaperturas) simultáneas crean UN solo ciclo", async () => {
    const results = await Promise.allSettled([open(t25), open(t25), open(t25)])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(await prisma.sessionTableCycle.count()).toBe(1)
    await close(t25)
    const again = await Promise.allSettled([open(t25), open(t25)])
    expect(again.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(await prisma.sessionTableCycle.count()).toBe(2)
    expect(
      await prisma.sessionTableCycle.count({ where: { status: "OPEN" } })
    ).toBe(1)
  })

  it("reintentos con la misma clave no duplican aperturas ni cierres", async () => {
    const k = key()
    const [a, b] = await Promise.all([
      open(t25, cashier, k),
      open(t25, cashier, k),
    ])
    expect([a.replayed, b.replayed].sort()).toEqual([false, true])
    const ck = key()
    await close(t25, cashier, ck)
    expect((await close(t25, cashier, ck)).replayed).toBe(true)
    expect(await prisma.sessionTableCycle.count()).toBe(1)
  })

  it("no se reabre una mesa si la sesión pasó a cierre (CLOSING)", async () => {
    await open(t25)
    await close(t25)
    await prisma.$executeRaw`UPDATE "poker_sessions" SET "status" = 'CLOSING' WHERE "id" = ${sessionId}`
    await expect(open(t25)).rejects.toThrow(/La sesión debe estar abierta/)
  })
})

describe("participantes", () => {
  it("registra un jugador activo en el ciclo vigente, sin compras, fichas, crédito ni cobro", async () => {
    await open(t25)
    const player = await createTestPlayer()
    const before = await financialAndInventorySnapshot()
    const { participationId } = await join(t25, player.id)
    const p = await prisma.tableParticipation.findUniqueOrThrow({
      where: { id: participationId },
      include: { cycle: true },
    })
    expect(p).toMatchObject({
      status: "ACTIVE",
      joinedById: cashier.id,
      playerId: player.id,
    })
    expect(p.cycle.cycleNumber).toBe(1)
    expect(await financialAndInventorySnapshot()).toEqual(before)
    expect(await auditRows("TABLE_PLAYER_JOINED")).toHaveLength(1)
  })

  it("rechaza jugadores inactivos y mesas cerradas o pendientes", async () => {
    const inactive = await createTestPlayer({ isActive: false })
    await open(t25)
    await expect(join(t25, inactive.id)).rejects.toThrow(/inactivo/)
    const player = await createTestPlayer()
    await expect(join(t10, player.id)).rejects.toThrow(
      /La mesa debe estar abierta/
    )
    await close(t25)
    await expect(join(t25, player.id)).rejects.toThrow(
      /La mesa debe estar abierta/
    )
  })

  it("un jugador no puede estar activo en dos mesas (ni dos veces en la misma)", async () => {
    await open(t25)
    await open(t10)
    const player = await createTestPlayer()
    await join(t10, player.id)
    await expect(join(t25, player.id)).rejects.toThrow(
      /activo en la Mesa 10\/10. Utiliza la opción Cambiar de mesa/
    )
    await expect(join(t10, player.id)).rejects.toThrow(
      /ya está activo en esta mesa/
    )
    signInAs(cashier._user)
    const res = await call(playersRoute.POST, {
      method: "POST",
      params: { id: sessionId, tableId: t25 },
      body: { playerId: player.id, idempotencyKey: key() },
    })
    expect(res.status).toBe(409)
  })

  it("concurrencia: altas simultáneas del mismo jugador en ambas mesas dejan UNA participación activa", async () => {
    await open(t25)
    await open(t10)
    const player = await createTestPlayer()
    const results = await Promise.allSettled([
      join(t25, player.id),
      join(t10, player.id),
      join(t25, player.id),
      join(t10, player.id),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(
      await prisma.tableParticipation.count({
        where: { playerId: player.id, status: "ACTIVE" },
      })
    ).toBe(1)
  })

  it("el cliente no puede fijar hora, responsable, estado ni ciclo", async () => {
    await open(t25)
    const player = await createTestPlayer()
    signInAs(cashier._user)
    for (const extra of [
      { joinedAt: new Date().toISOString() },
      { status: "SETTLED" },
      { sessionTableCycleId: "x" },
      { joinedById: "x" },
    ]) {
      const res = await call(playersRoute.POST, {
        method: "POST",
        params: { id: sessionId, tableId: t25 },
        body: { playerId: player.id, idempotencyKey: key(), ...extra },
      })
      expect(res.status).toBe(400)
    }
  })
})

describe("transferencias entre mesas", () => {
  it("mueve al jugador sin liquidar, sin fichas, sin dinero: origen TRANSFERRED y destino ACTIVE, en una operación", async () => {
    await open(t25)
    await open(t10)
    const player = await createTestPlayer()
    const { participationId } = await join(t10, player.id)
    const before = await financialAndInventorySnapshot()
    const result = await transferPlayer(cashier, sessionId, {
      sourceParticipationId: participationId,
      destinationTableId: t25,
      idempotencyKey: key(),
    })
    expect(result).toMatchObject({
      from: { id: t10 },
      to: { id: t25 },
      sourceParticipation: { status: "TRANSFERRED" },
      destinationParticipation: { status: "ACTIVE" },
      replayed: false,
    })
    const src = await prisma.tableParticipation.findUniqueOrThrow({
      where: { id: participationId },
    })
    expect(src).toMatchObject({
      status: "TRANSFERRED",
      exitReason: "TRANSFER",
      leftById: cashier.id,
    })
    const dest = await activeOf(player.id)
    expect(dest.sourceParticipationId).toBe(participationId)
    expect(await financialAndInventorySnapshot()).toEqual(before)
    expect(
      await prisma.chipInventoryOperation.count({
        where: {
          type: { in: ["CHIP_DELIVERY", "CHIP_RETURN", "CHIP_CONVERSION"] },
        },
      })
    ).toBe(0)
    expect(await auditRows("TABLE_PLAYER_TRANSFERRED")).toHaveLength(1)
    // Historial de ambas mesas.
    const h10 = await getTableHistory(sessionId, t10)
    expect(h10.events.map((e) => e.kind)).toContain("TRANSFER_OUT")
    const h25 = await getTableHistory(sessionId, t25)
    expect(h25.events.map((e) => e.kind)).toContain("TRANSFER_IN")
  })

  it("rechaza misma mesa, destino cerrado, origen cerrado y participación no activa", async () => {
    await open(t25)
    await open(t10)
    const player = await createTestPlayer()
    const { participationId } = await join(t25, player.id)
    const t = (destinationTableId: string, src = participationId) =>
      transferPlayer(cashier, sessionId, {
        sourceParticipationId: src,
        destinationTableId,
        idempotencyKey: key(),
      })
    await expect(t(t25)).rejects.toThrow(/mesa destino diferente/)
    // Destino cerrado.
    await close(t10)
    await expect(t(t10)).rejects.toThrow(/La mesa destino debe estar abierta/)
    await open(t10)
    // Origen sin participación activa (ya transferida).
    await t(t10)
    await expect(t(t25)).rejects.toThrow(/ya no está activo/)
  })

  it("no se puede cerrar la mesa de origen mientras el jugador sigue activo, y tras transferirlo sí", async () => {
    await open(t25)
    await open(t10)
    const player = await createTestPlayer()
    const { participationId } = await join(t25, player.id)
    await expect(close(t25)).rejects.toThrow(
      /No puedes cerrar esta mesa mientras tenga jugadores activos/
    )
    signInAs(cashier._user)
    const res = await call(closeRoute.POST, {
      method: "POST",
      params: { id: sessionId, tableId: t25 },
      body: { idempotencyKey: key() },
    })
    expect(res.status).toBe(422)
    await transferPlayer(cashier, sessionId, {
      sourceParticipationId: participationId,
      destinationTableId: t10,
      idempotencyKey: key(),
    })
    await expect(close(t25)).resolves.toMatchObject({
      table: { status: "CLOSED" },
    })
    expect(
      (await getSessionTables(sessionId)).find((t) => t.tableId === t10)
    ).toMatchObject({ status: "OPEN", activePlayers: 1 })
  })

  it("concurrencia: dos transferencias simultáneas del mismo jugador no generan estados imposibles", async () => {
    await open(t25)
    await open(t10)
    const third = await prisma.pokerTable.create({
      data: {
        code: "TABLE_50_50",
        name: "Mesa 50/50",
        smallBlind: "50",
        bigBlind: "50",
        defaultChipSetId: (
          await prisma.chipSet.findFirstOrThrow({ where: { isActive: true } })
        ).id,
      },
    })
    await open(third.id)
    const player = await createTestPlayer()
    const { participationId } = await join(t25, player.id)
    const results = await Promise.allSettled([
      transferPlayer(cashier, sessionId, {
        sourceParticipationId: participationId,
        destinationTableId: t10,
        idempotencyKey: key(),
      }),
      transferPlayer(cashier, sessionId, {
        sourceParticipationId: participationId,
        destinationTableId: third.id,
        idempotencyKey: key(),
      }),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(
      await prisma.tableParticipation.count({
        where: { playerId: player.id, status: "ACTIVE" },
      })
    ).toBe(1)
    expect(await prisma.tableTransfer.count()).toBe(1)
  })

  it("reintentar la transferencia con la misma clave no la duplica", async () => {
    await open(t25)
    await open(t10)
    const player = await createTestPlayer()
    const { participationId } = await join(t25, player.id)
    const body = {
      sourceParticipationId: participationId,
      destinationTableId: t10,
      idempotencyKey: key(),
    }
    signInAs(cashier._user)
    const [a, b] = await Promise.all([
      call(transfersRoute.POST, {
        method: "POST",
        params: { id: sessionId },
        body,
      }),
      call(transfersRoute.POST, {
        method: "POST",
        params: { id: sessionId },
        body,
      }),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 201])
    expect(await prisma.tableTransfer.count()).toBe(1)
  })

  it("las deudas e historial del jugador no cambian con la transferencia (no hay movimientos financieros)", async () => {
    await open(t25)
    await open(t10)
    const player = await createTestPlayer()
    const { participationId } = await join(t25, player.id)
    await transferPlayer(cashier, sessionId, {
      sourceParticipationId: participationId,
      destinationTableId: t10,
      idempotencyKey: key(),
    })
    expect(
      await prisma.cashTransaction.count({ where: { playerId: player.id } })
    ).toBe(0)
    expect(
      await prisma.bankTransferVerification.count({
        where: { playerId: player.id },
      })
    ).toBe(0)
    const all = await listParticipations(sessionId, {}, { showPhone: false })
    expect(all.map((p) => p.status).sort()).toEqual(["ACTIVE", "TRANSFERRED"])
  })
})

describe("salida definitiva y contratos", () => {
  it("no hay salida SETTLED sin liquidación confirmada (ni por servicio ni en la base)", async () => {
    await open(t25)
    const player = await createTestPlayer()
    const { participationId } = await join(t25, player.id)
    await expect(
      prisma.$transaction((tx) =>
        completeParticipationFromSettlementInTx(tx, cashier, {
          participationId,
          settlementId: "liq-inventada",
        })
      )
    ).rejects.toThrow(/requiere una liquidación confirmada/)
    await expect(
      prisma.tableParticipation.update({
        where: { id: participationId },
        data: { status: "SETTLED", leftAt: new Date(), leftById: cashier.id },
      })
    ).rejects.toThrow()
    expect(
      (
        await prisma.tableParticipation.findUniqueOrThrow({
          where: { id: participationId },
        })
      ).status
    ).toBe("ACTIVE")
    expect(await auditRows("TABLE_PARTICIPATION_SETTLED")).toHaveLength(0)
    expect("PATCH" in participationRoute).toBe(false)
  })

  it("con una liquidación real (Módulo 11) finaliza una sola vez; el jugador puede volver con otra participación", async () => {
    await open(t25)
    const player = await createTestPlayer()
    const { participationId } = await join(t25, player.id)
    // Liquidación de $0 firmada y recibida: participación SETTLED.
    const { settlementId } = await createSettlement(cashier, {
      participationId,
      returnedNominalAmount: "0",
      offsetDecision: "NO_COMPENSATE",
      idempotencyKey: randomUUID(),
    })
    const prepared = await prepareSettlementSignatureSummary(
      cashier,
      settlementId
    )
    await captureSettlementSignature(cashier, settlementId, {
      snapshotId: prepared.summary.snapshotId,
      payloadHash: prepared.summary.payloadHash,
      strokes: STROKES,
      idempotencyKey: randomUUID(),
    })
    const signed = await getSettlement(settlementId)
    await confirmReturn(cashier, settlementId, {
      expectedVersion: signed.version,
      chipsReceived: true,
      idempotencyKey: randomUUID(),
    })
    const again = await prisma.$transaction((tx) =>
      completeParticipationFromSettlementInTx(
        tx,
        cashier,
        { participationId, settlementId },
        settlementVerifier
      )
    )
    expect(again.replayed).toBe(true)
    const back = await join(t25, player.id)
    expect(back.participationId).not.toBe(participationId)
    await expect(close(t25)).rejects.toThrow(/jugadores activos/)
  })

  it("contrato de compras: valida participación activa en mesa y sesión abiertas", async () => {
    await open(t25)
    const player = await createTestPlayer()
    const { participationId } = await join(t25, player.id)
    await expect(
      validateParticipationForPurchase(prisma, participationId, player.id)
    ).resolves.toMatchObject({ tableId: t25, sessionId })
    const other = await createTestPlayer()
    await expect(
      validateParticipationForPurchase(prisma, participationId, other.id)
    ).rejects.toThrow(/no corresponde/)
    expect(
      await getOpenTablesAndPendingParticipants(prisma, sessionId)
    ).toMatchObject({
      activeParticipants: 1,
      openTables: [{ name: "Mesa 25/25" }],
    })
  })
})

describe("permisos", () => {
  it("los tres roles operan mesas sin autorización adicional (la regla del creador no aplica aquí)", async () => {
    let i = 0
    for (const role of ["SUPERADMIN", "PARTNER", "CASHIER"] as const) {
      const actor = await actorFor(role)
      signInAs(actor._user)
      const tableId = i++ % 2 === 0 ? t25 : t10
      const res = await call(openTableRoute.POST, {
        method: "POST",
        params: { id: sessionId, tableId },
        body: { idempotencyKey: key() },
      })
      expect([201, 409]).toContain(res.status)
      const list = await call(tablesRoute.GET, { params: { id: sessionId } })
      expect(list.status).toBe(200)
      await closeSessionTable(actor, sessionId, tableId, {
        idempotencyKey: key(),
      }).catch(() => undefined)
    }
  })

  it("401 sin sesión y 403 con credencial temporal pendiente", async () => {
    signOut()
    expect(
      (await call(tablesRoute.GET, { params: { id: sessionId } })).status
    ).toBe(401)
    expect(
      (
        await call(openTableRoute.POST, {
          method: "POST",
          params: { id: sessionId, tableId: t25 },
          body: { idempotencyKey: key() },
        })
      ).status
    ).toBe(401)
    signInAs(await createUser({ role: "CASHIER", mustChangePassword: true }))
    expect(
      (await call(tablesRoute.GET, { params: { id: sessionId } })).status
    ).toBe(403)
  })
})
