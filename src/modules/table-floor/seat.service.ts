import "server-only"

import { Prisma } from "@/generated/prisma/client"
import {
  AppError,
  BusinessRuleError,
  ConflictError,
  NotFoundError,
} from "@/lib/errors"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import { appliedByReceivable } from "@/modules/credits/receivable.service"
import { nextPurchaseNumber } from "@/modules/purchases/purchase.math"
import {
  activeSettlementOf,
  addPlayerToTable,
  SETTLEMENT_IN_PROGRESS_MESSAGE,
} from "@/modules/session-tables/participation.service"
import {
  getSessionTables,
  lockOpenSession,
  lockSessionTable,
  TABLE_TX,
} from "@/modules/session-tables/session-table.service"
import { sessionCashAvailable } from "@/modules/settlements/settlement.service"
import {
  chainConfirmedPurchasesInTx,
  occupySeatInTx,
  openSeatOf,
  releaseSeatInTx,
  SEAT_TAKEN_MESSAGE,
} from "@/modules/table-floor/seat-core"
import {
  deriveSeatState,
  isValidSeatNumber,
  SEAT_NUMBERS,
  type FeltColor,
} from "@/modules/table-floor/table-floor.math"
import type {
  AssignSeatInput,
  ChangeSeatInput,
  WithdrawInput,
} from "@/modules/table-floor/table-floor.schemas"

/**
 * Mesa interactiva — asientos (rediseño operativo del Módulo 07).
 *
 * - Sentar a un jugador NO genera compra, crédito, firma, entrega de fichas
 *   ni dinero: queda «pendiente de compra» hasta su primera entrega
 *   confirmada (Módulo 08). El estado se DERIVA de compras reales.
 * - Cambiar de asiento conserva la misma participación (sin compra,
 *   liquidación ni movimiento de inventario o caja); el historial queda en
 *   filas inmutables (`previousAssignmentId`).
 * - Toda operación bloquea la sesión (FOR SHARE) y la mesa (FOR UPDATE):
 *   las operaciones de asientos de una mesa se serializan; los índices
 *   únicos parciales son la última defensa.
 */

type Tx = Prisma.TransactionClient
const dec = (v: Prisma.Decimal | string | number) => new Prisma.Decimal(v)
const ZERO = dec(0)

// ── Tablero ───────────────────────────────────────────────────────────

/** Vista completa de la mesa: nueve asientos, ocupantes, dealer y paño. */
export async function getTableBoard(
  sessionId: string,
  tableId: string,
  opts: { showPhone: boolean }
) {
  const [session, tables, catalog] = await Promise.all([
    prisma.pokerSession.findUnique({
      where: { id: sessionId },
      select: { id: true, folio: true, status: true },
    }),
    getSessionTables(sessionId),
    prisma.pokerTable.findUnique({
      where: { id: tableId },
      select: { id: true, feltColor: true },
    }),
  ])
  if (!session) throw new NotFoundError("Sesión no encontrada")
  const t = tables.find((x) => x.tableId === tableId)
  if (!t || !catalog)
    throw new NotFoundError("Mesa no encontrada en esta sesión")

  const openCycle = t.status === "OPEN" ? t.currentCycle : null

  const participations = t.sessionTableId
    ? await prisma.tableParticipation.findMany({
        where: { sessionTableId: t.sessionTableId, status: "ACTIVE" },
        orderBy: { joinedAt: "asc" },
        select: {
          id: true,
          joinedAt: true,
          cycleId: true,
          player: {
            select: { id: true, name: true, nickname: true, phone: true },
          },
          seats: {
            where: { releasedAt: null },
            select: { seatNumber: true, assignedAt: true },
          },
        },
      })
    : []
  const settling = t.sessionTableId
    ? await prisma.tableParticipation.findMany({
        where: { sessionTableId: t.sessionTableId, status: "SETTLING" },
        orderBy: { leftAt: "desc" },
        select: {
          id: true,
          leftAt: true,
          settlementId: true,
          player: { select: { id: true, name: true, nickname: true } },
          settlement: { select: { folio: true, status: true } },
        },
      })
    : []

  const participationIds = participations.map((p) => p.id)
  const playerIds = participations.map((p) => p.player.id)

  const [confirmed, lastSequence, pending, settlementsLive, debts, chain] =
    await Promise.all([
      prisma.chipPurchase.groupBy({
        by: ["playerId"],
        where: { sessionId, playerId: { in: playerIds }, status: "CONFIRMED" },
        _count: { _all: true },
        _sum: { nominalAmount: true },
      }),
      prisma.chipPurchase.groupBy({
        by: ["playerId"],
        where: { sessionId, playerId: { in: playerIds } },
        _max: { sequenceNumber: true },
      }),
      prisma.chipPurchase.findMany({
        where: {
          participationId: { in: participationIds },
          status: { in: ["DRAFT", "READY_FOR_DELIVERY"] },
        },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          folio: true,
          status: true,
          participationId: true,
          nominalAmount: true,
        },
      }),
      prisma.playerSettlement.findMany({
        where: {
          participationId: { in: participationIds },
          status: { in: ["DRAFT", "READY_FOR_CONFIRMATION"] },
        },
        select: { id: true, folio: true, status: true, participationId: true },
      }),
      prisma.playerDebt.findMany({
        where: { playerId: { in: playerIds } },
        select: {
          id: true,
          playerId: true,
          sessionId: true,
          originalAmount: true,
        },
      }),
      Promise.all(
        participationIds.map(
          async (id) =>
            [id, await chainConfirmedPurchasesInTx(prisma, id)] as const
        )
      ),
    ])
  const applied = await appliedByReceivable(
    prisma,
    debts.map((d) => d.id)
  )
  const debtOf = (playerId: string) => {
    let global = ZERO
    let session = ZERO
    for (const d of debts) {
      if (d.playerId !== playerId) continue
      const balance = dec(d.originalAmount).sub(applied.get(d.id) ?? ZERO)
      global = global.add(balance)
      if (d.sessionId === sessionId) session = session.add(balance)
    }
    return { global: global.toFixed(2), session: session.toFixed(2) }
  }
  const chainMap = new Map(chain)

  const occupants = participations.map((p) => {
    const c = confirmed.find((x) => x.playerId === p.player.id)
    const last = lastSequence.find((x) => x.playerId === p.player.id)
    const purchase = pending.find((x) => x.participationId === p.id) ?? null
    const settlement =
      settlementsLive.find((x) => x.participationId === p.id) ?? null
    const next = nextPurchaseNumber(last?._max.sequenceNumber ?? null)
    const chainConfirmed = chainMap.get(p.id) ?? 0
    const count = c?._count._all ?? 0
    const debt = debtOf(p.player.id)
    return {
      participationId: p.id,
      seatNumber: p.seats[0]?.seatNumber ?? null,
      seatedAt: p.seats[0]?.assignedAt.toISOString() ?? null,
      joinedAt: p.joinedAt.toISOString(),
      player: {
        id: p.player.id,
        name: p.player.name,
        nickname: p.player.nickname,
        phone: opts.showPhone ? p.player.phone : null,
      },
      state: deriveSeatState({
        chainConfirmedPurchases: chainConfirmed,
        hasPendingPurchase: purchase !== null,
        hasSettlementInProgress: settlement !== null,
      }),
      /** Compras confirmadas del jugador EN LA SESIÓN (todas las mesas). */
      sessionPurchases: count,
      rebuys: Math.max(0, count - 1),
      /** Importe nominal acumulado registrado (no son las fichas que tiene ahora). */
      sessionNominal: dec(c?._sum.nominalAmount ?? 0).toFixed(2),
      /** Lo que el servidor asignará a la siguiente entrega (Módulo 08). */
      nextPurchase: {
        purchaseType: next.purchaseType,
        rebuyNumber: next.rebuyNumber,
      },
      chainConfirmedPurchases: chainConfirmed,
      pendingPurchase: purchase
        ? {
            id: purchase.id,
            folio: purchase.folio,
            status: purchase.status,
            nominalAmount: dec(purchase.nominalAmount).toFixed(2),
          }
        : null,
      settlementInProgress: settlement
        ? {
            id: settlement.id,
            folio: settlement.folio,
            status: settlement.status,
          }
        : null,
      debt: {
        global: debt.global,
        session: debt.session,
        hasDebt: dec(debt.global).greaterThan(0),
      },
    }
  })

  const seatMap = new Map(
    occupants
      .filter((o) => o.seatNumber !== null)
      .map((o) => [o.seatNumber as number, o])
  )
  const dealer = openCycle
    ? await prisma.dealerAssignment.findFirst({
        where: { cycleId: openCycle.id, releasedAt: null },
        select: {
          id: true,
          assignedAt: true,
          assignedBy: { select: { id: true, name: true } },
          dealer: { select: { id: true, name: true, nickname: true } },
        },
      })
    : null

  const otherOpen = tables.filter(
    (x) => x.status === "OPEN" && x.tableId !== tableId && x.sessionTableId
  )
  const otherSeats = await prisma.tableSeatAssignment.findMany({
    where: {
      releasedAt: null,
      sessionTableId: { in: otherOpen.map((x) => x.sessionTableId as string) },
      cycle: { status: "OPEN" },
    },
    select: { sessionTableId: true, seatNumber: true },
  })

  return {
    session: { id: session.id, folio: session.folio, status: session.status },
    table: {
      tableId: t.tableId,
      name: t.name,
      status: t.status,
      catalogActive: t.catalogActive,
      blinds: t.blinds,
      feltColor: catalog.feltColor as FeltColor,
      cycle: openCycle ? { id: openCycle.id, number: openCycle.number } : null,
    },
    seats: SEAT_NUMBERS.map((n) => ({
      seatNumber: n,
      occupant: seatMap.get(n) ?? null,
    })),
    /** Jugadores activos sin asiento (registrados antes o desde otra pantalla). */
    unseated: occupants.filter((o) => o.seatNumber === null),
    /** Ya devolvieron fichas y falta pagarles: no ocupan asiento. */
    settlingPayout: settling.map((s) => ({
      participationId: s.id,
      player: s.player,
      settlementId: s.settlementId,
      settlementFolio: s.settlement?.folio ?? null,
      leftAt: s.leftAt?.toISOString() ?? null,
    })),
    dealer: dealer
      ? {
          assignmentId: dealer.id,
          assignedAt: dealer.assignedAt.toISOString(),
          assignedBy: dealer.assignedBy,
          dealer: dealer.dealer,
        }
      : null,
    destinations: otherOpen.map((x) => {
      const taken = new Set(
        otherSeats
          .filter((s) => s.sessionTableId === x.sessionTableId)
          .map((s) => s.seatNumber)
      )
      return {
        tableId: x.tableId,
        name: x.name,
        freeSeats: SEAT_NUMBERS.filter((n) => !taken.has(n)),
      }
    }),
    cashAvailable:
      session.status === "OPEN"
        ? await sessionCashAvailable(sessionId)
        : "0.00",
  }
}
export type TableBoard = Awaited<ReturnType<typeof getTableBoard>>
export type BoardOccupant = TableBoard["seats"][number]["occupant"] & object

// ── Candidatos para un asiento ────────────────────────────────────────

/**
 * Búsqueda tolerante a acentos y mayúsculas por nombre, apodo o teléfono,
 * con la razón por la que un jugador no puede sentarse (activo en otra
 * mesa, liquidación pendiente de pago, inactivo).
 */
export async function searchSeatCandidates(
  sessionId: string,
  tableId: string,
  q: string,
  opts: { showPhone: boolean }
) {
  const digits = q.replace(/\D/g, "")
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const rows = await prisma.$queryRaw<
    {
      id: string
      name: string
      nickname: string | null
      phone: string
      isActive: boolean
    }[]
  >`
    SELECT "id", "name", "nickname", "phone", "isActive" FROM "players"
     WHERE translate(lower("name"), 'áéíóúüñàèìòù', 'aeiouunaeiou') LIKE translate(lower(${pattern}), 'áéíóúüñàèìòù', 'aeiouunaeiou')
        OR translate(lower(coalesce("nickname", '')), 'áéíóúüñàèìòù', 'aeiouunaeiou') LIKE translate(lower(${pattern}), 'áéíóúüñàèìòù', 'aeiouunaeiou')
        ${digits.length >= 3 ? Prisma.sql`OR "phone" LIKE ${`%${digits}%`}` : Prisma.empty}
     ORDER BY "isActive" DESC, "name" ASC
     LIMIT 10
  `
  const ids = rows.map((r) => r.id)
  const live = await prisma.tableParticipation.findMany({
    where: {
      sessionId,
      playerId: { in: ids },
      status: { in: ["ACTIVE", "SETTLING"] },
    },
    select: {
      playerId: true,
      status: true,
      sessionTable: {
        select: { tableId: true, table: { select: { name: true } } },
      },
    },
  })
  return rows.map((r) => {
    const active = live.find(
      (p) => p.playerId === r.id && p.status === "ACTIVE"
    )
    const settling = live.find(
      (p) => p.playerId === r.id && p.status === "SETTLING"
    )
    const blockedReason = !r.isActive
      ? "Jugador inactivo: reactívalo en Jugadores para operar."
      : settling
        ? "Tiene una liquidación pendiente de pago en esta sesión."
        : active
          ? active.sessionTable.tableId === tableId
            ? "Ya está activo en esta mesa."
            : `Está activo en la ${active.sessionTable.table.name}: usa «Mover de mesa».`
          : null
    return {
      id: r.id,
      name: r.name,
      nickname: r.nickname,
      phone: opts.showPhone ? r.phone : null,
      selectable: blockedReason === null,
      blockedReason,
    }
  })
}

// ── Ocupar asiento ────────────────────────────────────────────────────

async function lockTableForSeats(
  tx: Tx,
  sessionId: string,
  tableId: string,
  action: string
) {
  const session = await lockOpenSession(
    tx,
    sessionId,
    `La sesión debe estar abierta para ${action}.`
  )
  const st = await tx.sessionTable.findUnique({
    where: { sessionId_tableId: { sessionId, tableId } },
    select: { id: true },
  })
  if (!st) throw new BusinessRuleError("La mesa debe estar abierta.")
  const table = await lockSessionTable(tx, st.id)
  const cycle = table.cycles[0]
  if (table.status !== "OPEN" || !cycle)
    throw new BusinessRuleError("La mesa debe estar abierta.")
  return { session, table, cycle }
}

/**
 * Ocupa un asiento libre: con un jugador del directorio (crea su
 * participación ACTIVE, Módulo 07) o con un jugador ya activo en esta mesa
 * sin asiento. Idempotente por clave.
 */
export async function assignSeat(
  actor: SessionUser,
  sessionId: string,
  tableId: string,
  seatNumber: number,
  input: AssignSeatInput,
  ctx: RequestContext = {}
) {
  if (!isValidSeatNumber(seatNumber))
    throw new BusinessRuleError("Asiento inválido")
  if (input.playerId) {
    const r = await addPlayerToTable(
      actor,
      sessionId,
      tableId,
      {
        playerId: input.playerId,
        idempotencyKey: input.idempotencyKey,
        seatNumber,
      },
      ctx
    )
    return {
      participationId: r.participationId,
      seatNumber,
      replayed: r.replayed,
    }
  }
  const participationId = input.participationId as string
  const key = `seat-${input.idempotencyKey}`
  const previous = await prisma.tableSeatAssignment.findUnique({
    where: { idempotencyKey: key },
    select: { participationId: true, seatNumber: true },
  })
  if (previous) {
    if (
      previous.participationId !== participationId ||
      previous.seatNumber !== seatNumber
    )
      throw new AppError(
        "CONFLICT",
        "Esta clave de operación ya se usó para otro asiento"
      )
    return { participationId, seatNumber, replayed: true }
  }
  try {
    await prisma.$transaction(async (tx) => {
      const { session, table, cycle } = await lockTableForSeats(
        tx,
        sessionId,
        tableId,
        "asignar asientos"
      )
      await tx.$queryRaw`SELECT "id" FROM "table_participations" WHERE "id" = ${participationId} FOR UPDATE`
      const p = await tx.tableParticipation.findFirst({
        where: { id: participationId, sessionId },
        select: {
          id: true,
          status: true,
          sessionTableId: true,
          cycleId: true,
          playerId: true,
        },
      })
      if (!p) throw new NotFoundError("Participación no encontrada")
      if (p.status !== "ACTIVE" || p.sessionTableId !== table.id)
        throw new BusinessRuleError("El jugador no está activo en esta mesa.")
      if (p.cycleId !== cycle.id)
        throw new BusinessRuleError(
          "La participación es de otro ciclo de la mesa."
        )
      if (await openSeatOf(tx, p.id))
        throw new ConflictError(
          "El jugador ya tiene asiento: usa «Cambiar asiento»."
        )
      await occupySeatInTx(
        tx,
        actor,
        {
          participation: { ...p, sessionId },
          seatNumber,
          idempotencyKey: key,
          tableName: table.table.name,
          sessionFolio: session.folio,
        },
        ctx
      )
    }, TABLE_TX)
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await prisma.tableSeatAssignment.findUnique({
        where: { idempotencyKey: key },
        select: { id: true },
      })
      if (again) return { participationId, seatNumber, replayed: true }
      throw new ConflictError(SEAT_TAKEN_MESSAGE)
    }
    throw error
  }
  return { participationId, seatNumber, replayed: false }
}

// ── Cambiar asiento ───────────────────────────────────────────────────

/**
 * Mueve al jugador a un asiento LIBRE de la misma mesa y ciclo. Misma
 * participación: no hay compra, liquidación, inventario ni caja. Sin
 * intercambios automáticos con asientos ocupados.
 */
export async function changeSeat(
  actor: SessionUser,
  sessionId: string,
  tableId: string,
  input: ChangeSeatInput,
  ctx: RequestContext = {}
) {
  const key = `seat-change-${input.idempotencyKey}`
  const previous = await prisma.tableSeatAssignment.findUnique({
    where: { idempotencyKey: key },
    select: { participationId: true, seatNumber: true },
  })
  if (previous) {
    if (
      previous.participationId !== input.participationId ||
      previous.seatNumber !== input.toSeat
    )
      throw new AppError(
        "CONFLICT",
        "Esta clave de operación ya se usó para otro cambio de asiento"
      )
    return { seatNumber: input.toSeat, replayed: true }
  }
  try {
    await prisma.$transaction(async (tx) => {
      const { session, table, cycle } = await lockTableForSeats(
        tx,
        sessionId,
        tableId,
        "cambiar de asiento"
      )
      await tx.$queryRaw`SELECT "id" FROM "table_participations" WHERE "id" = ${input.participationId} FOR UPDATE`
      const p = await tx.tableParticipation.findFirst({
        where: { id: input.participationId, sessionId },
        select: {
          id: true,
          status: true,
          sessionTableId: true,
          cycleId: true,
          playerId: true,
        },
      })
      if (!p) throw new NotFoundError("Participación no encontrada")
      if (
        p.status !== "ACTIVE" ||
        p.sessionTableId !== table.id ||
        p.cycleId !== cycle.id
      )
        throw new BusinessRuleError("El jugador no está activo en esta mesa.")
      const current = await openSeatOf(tx, p.id)
      if (!current)
        throw new BusinessRuleError(
          "El jugador no tiene asiento: asígnale uno libre."
        )
      if (current.seatNumber === input.toSeat)
        throw new BusinessRuleError("El jugador ya está en ese asiento.")
      const taken = await tx.tableSeatAssignment.findFirst({
        where: {
          cycleId: cycle.id,
          seatNumber: input.toSeat,
          releasedAt: null,
        },
        select: { id: true },
      })
      if (taken) throw new ConflictError(SEAT_TAKEN_MESSAGE)
      await releaseSeatInTx(tx, actor, p.id, "SEAT_CHANGE", ctx)
      const seat = await occupySeatInTx(
        tx,
        actor,
        {
          participation: { ...p, sessionId },
          seatNumber: input.toSeat,
          idempotencyKey: key,
          previousAssignmentId: current.id,
          tableName: table.table.name,
          sessionFolio: session.folio,
        },
        ctx
      )
      await recordAudit(
        {
          action: AUDIT_ACTIONS.SEAT_CHANGED,
          entityType: "TableSeatAssignment",
          entityId: seat.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            sessionId,
            folio: session.folio,
            cycleId: cycle.id,
            playerId: p.playerId,
            participationId: p.id,
            table: table.table.name,
            fromSeat: current.seatNumber,
            toSeat: input.toSeat,
            previousAssignmentId: current.id,
          },
        },
        tx
      )
    }, TABLE_TX)
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await prisma.tableSeatAssignment.findUnique({
        where: { idempotencyKey: key },
        select: { id: true },
      })
      if (again) return { seatNumber: input.toSeat, replayed: true }
      throw new ConflictError(SEAT_TAKEN_MESSAGE)
    }
    throw error
  }
  return { seatNumber: input.toSeat, replayed: false }
}

// ── Retiro sin compra ─────────────────────────────────────────────────

export const WITHDRAW_HAS_CHIPS_MESSAGE =
  "El jugador ya recibió fichas: su salida requiere una liquidación."

/**
 * El jugador se sentó pero NUNCA recibió fichas (sin compra confirmada en su
 * cadena de participaciones): deja la mesa sin liquidación, con motivo y
 * auditoría. Si recibió fichas, debe liquidarse (Módulo 11). Idempotente:
 * repetirlo sobre una participación ya retirada no hace nada.
 */
export async function withdrawWithoutPurchase(
  actor: SessionUser,
  sessionId: string,
  participationId: string,
  input: WithdrawInput,
  ctx: RequestContext = {}
) {
  const head = await prisma.tableParticipation.findFirst({
    where: { id: participationId, sessionId },
    select: {
      status: true,
      exitReason: true,
      sessionTable: { select: { tableId: true } },
    },
  })
  if (!head) throw new NotFoundError("Participación no encontrada")
  if (head.status === "WITHDRAWN") return { replayed: true }
  let replayed = false
  await prisma.$transaction(async (tx) => {
    const { session, table } = await lockTableForSeats(
      tx,
      sessionId,
      head.sessionTable.tableId,
      "retirar jugadores"
    )
    await tx.$queryRaw`SELECT "id" FROM "table_participations" WHERE "id" = ${participationId} FOR UPDATE`
    const p = await tx.tableParticipation.findUniqueOrThrow({
      where: { id: participationId },
      select: { id: true, status: true, playerId: true, cycleId: true },
    })
    if (p.status === "WITHDRAWN") {
      replayed = true
      return
    }
    if (p.status !== "ACTIVE")
      throw new ConflictError("El jugador ya no está activo en esta mesa.")
    if (await activeSettlementOf(tx, p.id))
      throw new ConflictError(SETTLEMENT_IN_PROGRESS_MESSAGE)
    const preparing = await tx.chipPurchase.count({
      where: {
        participationId: p.id,
        status: { in: ["DRAFT", "READY_FOR_DELIVERY"] },
      },
    })
    if (preparing > 0)
      throw new BusinessRuleError(
        "El jugador tiene una compra en preparación: entrégala o cancélala antes de retirarlo."
      )
    if ((await chainConfirmedPurchasesInTx(tx, p.id)) > 0)
      throw new BusinessRuleError(WITHDRAW_HAS_CHIPS_MESSAGE)
    const seat = await releaseSeatInTx(tx, actor, p.id, "WITHDRAWAL", ctx)
    const { count } = await tx.tableParticipation.updateMany({
      where: { id: p.id, status: "ACTIVE" },
      data: {
        status: "WITHDRAWN",
        leftAt: new Date(),
        leftById: actor.id,
        exitReason: "WITHDRAWAL",
      },
    })
    if (count !== 1)
      throw new ConflictError("La participación cambió de estado")
    await recordAudit(
      {
        action: AUDIT_ACTIONS.TABLE_PARTICIPATION_WITHDRAWN,
        entityType: "TableParticipation",
        entityId: p.id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          sessionId,
          folio: session.folio,
          cycleId: p.cycleId,
          playerId: p.playerId,
          table: table.table.name,
          seatNumber: seat?.seatNumber ?? null,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
        },
      },
      tx
    )
  }, TABLE_TX)
  return { replayed }
}

// ── Historial de asientos ─────────────────────────────────────────────

/** Historial inmutable de asientos de la mesa en la sesión (todos los ciclos). */
export async function getSeatHistory(sessionId: string, tableId: string) {
  const st = await prisma.sessionTable.findUnique({
    where: { sessionId_tableId: { sessionId, tableId } },
    select: { id: true },
  })
  if (!st) return []
  const rows = await prisma.tableSeatAssignment.findMany({
    where: { sessionTableId: st.id },
    orderBy: { assignedAt: "desc" },
    take: 200,
    select: {
      id: true,
      seatNumber: true,
      assignedAt: true,
      releasedAt: true,
      releaseReason: true,
      participationId: true,
      previous: { select: { seatNumber: true } },
      cycle: { select: { cycleNumber: true } },
      player: { select: { id: true, name: true, nickname: true } },
      assignedBy: { select: { id: true, name: true } },
      releasedBy: { select: { id: true, name: true } },
    },
  })
  return rows.map((r) => ({
    id: r.id,
    seatNumber: r.seatNumber,
    fromSeat: r.previous?.seatNumber ?? null,
    cycleNumber: r.cycle.cycleNumber,
    participationId: r.participationId,
    player: r.player,
    assignedAt: r.assignedAt.toISOString(),
    assignedBy: r.assignedBy,
    releasedAt: r.releasedAt?.toISOString() ?? null,
    releasedBy: r.releasedBy,
    releaseReason: r.releaseReason,
  }))
}
