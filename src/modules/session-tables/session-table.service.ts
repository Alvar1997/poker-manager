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
import type { HistoryQuery } from "@/modules/session-tables/session-table.schemas"

/**
 * Mesas dentro de una sesión (Módulo 07).
 *
 * - La mesa del catálogo (Módulo 02) se liga a la sesión con UNA
 *   `SessionTable`; cada apertura o reapertura crea un `SessionTableCycle`
 *   nuevo (los cerrados nunca se reabren ni se borran).
 * - Abrir/cerrar/reabrir NO mueve dinero ni fichas, no exige otro arqueo
 *   general y no cambia el estado de la sesión. Todas las mesas comparten
 *   la caja central y el inventario de fichas.
 * - Concurrencia: la sesión se bloquea con FOR SHARE (no puede pasar a
 *   cierre a la mitad) y la mesa con FOR UPDATE; además un índice único
 *   parcial impide dos ciclos OPEN. Horas siempre del servidor.
 */

export type Tx = Prisma.TransactionClient
export type Db = Tx | typeof prisma
export const TABLE_TX = { maxWait: 15_000, timeout: 20_000 } as const

export const SESSION_NOT_OPEN_MESSAGE =
  "La sesión debe estar abierta para habilitar una mesa."

/** Bloquea la sesión en modo compartido y exige que esté OPEN. */
export async function lockOpenSession(
  tx: Tx,
  sessionId: string,
  message = SESSION_NOT_OPEN_MESSAGE
) {
  const rows = await tx.$queryRaw<
    { id: string; folio: string; status: string }[]
  >`
    SELECT "id", "folio", "status"::text AS "status" FROM "poker_sessions" WHERE "id" = ${sessionId} FOR SHARE
  `
  if (rows.length === 0) throw new NotFoundError("Sesión no encontrada")
  if (rows[0].status !== "OPEN") throw new BusinessRuleError(message)
  return rows[0]
}

/** Bloquea (FOR UPDATE) la mesa de la sesión. */
export async function lockSessionTable(tx: Tx, sessionTableId: string) {
  await tx.$queryRaw`SELECT "id" FROM "session_tables" WHERE "id" = ${sessionTableId} FOR UPDATE`
  return tx.sessionTable.findUniqueOrThrow({
    where: { id: sessionTableId },
    select: {
      id: true,
      sessionId: true,
      tableId: true,
      status: true,
      table: { select: { id: true, name: true } },
      cycles: {
        where: { status: "OPEN" },
        select: { id: true, cycleNumber: true },
      },
    },
  })
}

const user = { select: { id: true, name: true } } as const

// ── Consultas ─────────────────────────────────────────────────────────

/** Mesas del catálogo con su estado en la sesión (PENDING si aún no se abren). */
export async function getSessionTables(sessionId: string) {
  const session = await prisma.pokerSession.findUnique({
    where: { id: sessionId },
    select: { id: true, status: true },
  })
  if (!session) throw new NotFoundError("Sesión no encontrada")
  const [catalog, sessionTables] = await Promise.all([
    prisma.pokerTable.findMany({
      where: {
        OR: [{ isActive: true }, { sessionTables: { some: { sessionId } } }],
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: {
        id: true,
        code: true,
        name: true,
        smallBlind: true,
        bigBlind: true,
        isActive: true,
      },
    }),
    prisma.sessionTable.findMany({
      where: { sessionId },
      select: {
        id: true,
        tableId: true,
        status: true,
        cycles: {
          orderBy: { cycleNumber: "desc" },
          take: 1,
          select: {
            id: true,
            cycleNumber: true,
            status: true,
            openedAt: true,
            closedAt: true,
            openedBy: user,
            closedBy: user,
            smallBlindSnapshot: true,
            bigBlindSnapshot: true,
          },
        },
        _count: { select: { participations: { where: { status: "ACTIVE" } } } },
      },
    }),
  ])
  const lastClosed = await prisma.sessionTableCycle.groupBy({
    by: ["sessionTableId"],
    where: { sessionTable: { sessionId }, status: "CLOSED" },
    _max: { closedAt: true },
  })
  return catalog.map((t) => {
    const st = sessionTables.find((x) => x.tableId === t.id)
    const cycle = st?.cycles[0]
    return {
      tableId: t.id,
      code: t.code,
      name: t.name,
      catalogActive: t.isActive,
      blinds: {
        small: (cycle?.smallBlindSnapshot ?? t.smallBlind).toFixed(2),
        big: (cycle?.bigBlindSnapshot ?? t.bigBlind).toFixed(2),
      },
      sessionTableId: st?.id ?? null,
      status: st?.status ?? ("PENDING" as const),
      currentCycle:
        cycle && cycle.status === "OPEN"
          ? {
              id: cycle.id,
              number: cycle.cycleNumber,
              openedAt: cycle.openedAt.toISOString(),
              openedBy: cycle.openedBy,
            }
          : null,
      lastCycleNumber: cycle?.cycleNumber ?? 0,
      lastOpenedAt: cycle?.openedAt.toISOString() ?? null,
      lastClosedAt:
        lastClosed
          .find((x) => x.sessionTableId === st?.id)
          ?._max.closedAt?.toISOString() ?? null,
      activePlayers: st?._count.participations ?? 0,
      sessionStatus: session.status,
    }
  })
}
export type SessionTableSummary = Awaited<
  ReturnType<typeof getSessionTables>
>[number]

export async function getSessionTableDetail(
  sessionId: string,
  tableId: string
) {
  const tables = await getSessionTables(sessionId)
  const t = tables.find((x) => x.tableId === tableId)
  if (!t) throw new NotFoundError("Mesa no encontrada en esta sesión")
  return t
}

export async function getTableCycles(sessionId: string, tableId: string) {
  const st = await prisma.sessionTable.findUnique({
    where: { sessionId_tableId: { sessionId, tableId } },
    select: { id: true },
  })
  if (!st) {
    await getSessionTableDetail(sessionId, tableId) // 404 si la mesa no existe
    return []
  }
  const cycles = await prisma.sessionTableCycle.findMany({
    where: { sessionTableId: st.id },
    orderBy: { cycleNumber: "asc" },
    select: {
      id: true,
      cycleNumber: true,
      status: true,
      openedAt: true,
      closedAt: true,
      closingNotes: true,
      smallBlindSnapshot: true,
      bigBlindSnapshot: true,
      openedBy: user,
      closedBy: user,
      _count: { select: { participations: true } },
    },
  })
  return cycles.map((c) => ({
    ...c,
    openedAt: c.openedAt.toISOString(),
    closedAt: c.closedAt?.toISOString() ?? null,
    smallBlindSnapshot: c.smallBlindSnapshot.toFixed(2),
    bigBlindSnapshot: c.bigBlindSnapshot.toFixed(2),
    participations: c._count.participations,
  }))
}

/**
 * Historial de la mesa: ciclos, ingresos, transferencias de entrada/salida y
 * salidas liquidadas. Sin importes inventados: compras y liquidaciones se
 * mostrarán cuando existan esos módulos.
 */
export async function getTableHistory(
  sessionId: string,
  tableId: string,
  query: HistoryQuery = {}
) {
  const cycles = (await getTableCycles(sessionId, tableId)).filter(
    (c) => !query.cycle || c.cycleNumber === query.cycle
  )
  const st = await prisma.sessionTable.findUnique({
    where: { sessionId_tableId: { sessionId, tableId } },
    select: { id: true },
  })
  if (!st) return { cycles, events: [] }
  const range: Prisma.DateTimeFilter | undefined =
    query.from || query.to
      ? {
          ...(query.from
            ? { gte: new Date(`${query.from}T00:00:00.000Z`) }
            : {}),
          ...(query.to
            ? {
                lt: new Date(
                  new Date(`${query.to}T00:00:00.000Z`).getTime() + 86_400_000
                ),
              }
            : {}),
        }
      : undefined
  const cycleIds = cycles.map((c) => c.id)
  const participations = await prisma.tableParticipation.findMany({
    where: {
      sessionTableId: st.id,
      cycleId: { in: cycleIds },
      ...(range ? { joinedAt: range } : {}),
    },
    orderBy: { joinedAt: "asc" },
    select: {
      id: true,
      status: true,
      joinedAt: true,
      leftAt: true,
      exitReason: true,
      settlementId: true,
      cycle: { select: { cycleNumber: true } },
      player: { select: { id: true, name: true, nickname: true } },
      joinedBy: user,
      leftBy: user,
      transferIn: {
        select: {
          id: true,
          sourceSessionTable: { select: { table: { select: { name: true } } } },
        },
      },
      transferOut: {
        select: {
          id: true,
          destinationSessionTable: {
            select: { table: { select: { name: true } } },
          },
        },
      },
    },
  })
  type Event = {
    at: string
    kind: string
    cycle: number
    text: string
    by: string | null
  }
  const events: Event[] = []
  for (const c of cycles) {
    events.push({
      at: c.openedAt,
      kind: "CYCLE_OPENED",
      cycle: c.cycleNumber,
      text: `Ciclo ${c.cycleNumber} abierto`,
      by: c.openedBy.name,
    })
    if (c.closedAt)
      events.push({
        at: c.closedAt,
        kind: "CYCLE_CLOSED",
        cycle: c.cycleNumber,
        text: `Ciclo ${c.cycleNumber} cerrado`,
        by: c.closedBy?.name ?? null,
      })
  }
  for (const p of participations) {
    const who = p.player.nickname
      ? `${p.player.name} (${p.player.nickname})`
      : p.player.name
    events.push({
      at: p.joinedAt.toISOString(),
      kind: p.transferIn ? "TRANSFER_IN" : "PLAYER_JOINED",
      cycle: p.cycle.cycleNumber,
      text: p.transferIn
        ? `${who} llegó transferido desde ${p.transferIn.sourceSessionTable.table.name}`
        : `${who} ingresó`,
      by: p.joinedBy.name,
    })
    if (p.leftAt) {
      events.push({
        at: p.leftAt.toISOString(),
        kind: p.status === "TRANSFERRED" ? "TRANSFER_OUT" : "PLAYER_SETTLED",
        cycle: p.cycle.cycleNumber,
        text:
          p.status === "TRANSFERRED"
            ? `${who} se cambió a ${p.transferOut?.destinationSessionTable.table.name ?? "otra mesa"}`
            : `${who} salió con liquidación confirmada`,
        by: p.leftBy?.name ?? null,
      })
    }
  }
  const inRange = (at: string) => {
    if (!range) return true
    const t = new Date(at).getTime()
    return (
      (!range.gte || t >= (range.gte as Date).getTime()) &&
      (!range.lt || t < (range.lt as Date).getTime())
    )
  }
  return {
    cycles,
    events: events
      .filter((e) => inRange(e.at))
      .sort((a, b) => a.at.localeCompare(b.at)),
  }
}

// ── Abrir / reabrir ───────────────────────────────────────────────────

/**
 * Abre la mesa en la sesión (o la REABRE con un ciclo nuevo). No exige
 * arqueo, no mueve dinero ni fichas, no agrega jugadores. Idempotente por clave.
 */
export async function openSessionTable(
  actor: SessionUser,
  sessionId: string,
  tableId: string,
  input: { idempotencyKey: string },
  ctx: RequestContext = {}
) {
  const replay = async () =>
    prisma.sessionTableCycle.findUnique({
      where: { openIdempotencyKey: input.idempotencyKey },
      select: {
        id: true,
        sessionTable: { select: { sessionId: true, tableId: true } },
      },
    })
  const previous = await replay()
  if (previous) {
    if (
      previous.sessionTable.sessionId !== sessionId ||
      previous.sessionTable.tableId !== tableId
    ) {
      throw new AppError(
        "CONFLICT",
        "Esta clave de operación ya se usó para otra mesa"
      )
    }
    return {
      table: await getSessionTableDetail(sessionId, tableId),
      replayed: true,
    }
  }
  let replayedInTx = false
  try {
    await prisma.$transaction(async (tx) => {
      const session = await lockOpenSession(tx, sessionId)
      const table = await tx.pokerTable.findUnique({
        where: { id: tableId },
        select: {
          id: true,
          name: true,
          isActive: true,
          smallBlind: true,
          bigBlind: true,
        },
      })
      if (!table) throw new NotFoundError("Mesa no encontrada")
      if (!table.isActive)
        throw new BusinessRuleError(
          `La mesa ${table.name} está desactivada en el catálogo.`
        )

      await tx.$executeRaw`
        INSERT INTO "session_tables" ("id", "sessionId", "tableId", "status", "createdAt", "updatedAt")
        VALUES (${`st_${sessionId}_${tableId}`.slice(0, 100)}, ${sessionId}, ${tableId}, 'PENDING', NOW(), NOW())
        ON CONFLICT DO NOTHING
      `
      const st = await tx.sessionTable.findUniqueOrThrow({
        where: { sessionId_tableId: { sessionId, tableId } },
        select: { id: true },
      })
      const locked = await lockSessionTable(tx, st.id)
      // Reintento simultáneo con la misma clave: esperó el bloqueo → respuesta segura.
      const sameKey = await tx.sessionTableCycle.findUnique({
        where: { openIdempotencyKey: input.idempotencyKey },
        select: { sessionTableId: true },
      })
      if (sameKey?.sessionTableId === st.id) {
        replayedInTx = true
        return
      }
      if (locked.status === "OPEN" || locked.cycles.length > 0) {
        throw new ConflictError("Esta mesa ya está abierta.")
      }
      const active = await tx.tableParticipation.count({
        where: { sessionTableId: st.id, status: "ACTIVE" },
      })
      if (active > 0)
        throw new BusinessRuleError(
          "La mesa tiene participantes activos del ciclo anterior."
        )
      const last = await tx.sessionTableCycle.aggregate({
        where: { sessionTableId: st.id },
        _max: { cycleNumber: true },
      })
      const cycleNumber = (last._max.cycleNumber ?? 0) + 1
      const cycle = await tx.sessionTableCycle.create({
        data: {
          sessionTableId: st.id,
          cycleNumber,
          openedById: actor.id,
          openedAt: new Date(),
          smallBlindSnapshot: table.smallBlind,
          bigBlindSnapshot: table.bigBlind,
          openIdempotencyKey: input.idempotencyKey,
        },
        select: { id: true },
      })
      await tx.sessionTable.update({
        where: { id: st.id },
        data: { status: "OPEN" },
      })
      const metadata = {
        folio: session.folio,
        table: table.name,
        tableId,
        cycleNumber,
        cycleId: cycle.id,
      }
      await recordAudit(
        {
          action:
            cycleNumber > 1
              ? AUDIT_ACTIONS.SESSION_TABLE_REOPENED
              : AUDIT_ACTIONS.SESSION_TABLE_OPENED,
          entityType: "SessionTable",
          entityId: st.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata,
        },
        tx
      )
      await recordAudit(
        {
          action: AUDIT_ACTIONS.SESSION_TABLE_CYCLE_CREATED,
          entityType: "SessionTableCycle",
          entityId: cycle.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata,
        },
        tx
      )
    }, TABLE_TX)
  } catch (error) {
    if (isUniqueViolation(error)) {
      if (await replay())
        return {
          table: await getSessionTableDetail(sessionId, tableId),
          replayed: true,
        }
      throw new ConflictError("Esta mesa ya está abierta.")
    }
    throw error
  }
  return {
    table: await getSessionTableDetail(sessionId, tableId),
    replayed: replayedInTx,
  }
}

// ── Cerrar ────────────────────────────────────────────────────────────

/**
 * Cierra el ciclo vigente. Rechaza si hay participantes ACTIVE (deben
 * transferirse o liquidarse). No mueve dinero ni fichas, no arquea y no
 * cambia la sesión: la otra mesa sigue operando.
 */
export async function closeSessionTable(
  actor: SessionUser,
  sessionId: string,
  tableId: string,
  input: { idempotencyKey: string; notes?: string },
  ctx: RequestContext = {}
) {
  const replayed = await prisma.sessionTableCycle.findUnique({
    where: { closeIdempotencyKey: input.idempotencyKey },
    select: { sessionTable: { select: { sessionId: true, tableId: true } } },
  })
  if (replayed) {
    if (
      replayed.sessionTable.sessionId !== sessionId ||
      replayed.sessionTable.tableId !== tableId
    ) {
      throw new AppError(
        "CONFLICT",
        "Esta clave de operación ya se usó para otra mesa"
      )
    }
    return {
      table: await getSessionTableDetail(sessionId, tableId),
      replayed: true,
    }
  }
  let replayedInTx = false
  await prisma.$transaction(async (tx) => {
    const session = await lockOpenSession(
      tx,
      sessionId,
      "La sesión debe estar abierta para cerrar una mesa."
    )
    const st = await tx.sessionTable.findUnique({
      where: { sessionId_tableId: { sessionId, tableId } },
      select: { id: true },
    })
    if (!st) throw new ConflictError("Esta mesa no se ha abierto en la sesión.")
    const locked = await lockSessionTable(tx, st.id)
    const sameKey = await tx.sessionTableCycle.findUnique({
      where: { closeIdempotencyKey: input.idempotencyKey },
      select: { sessionTableId: true },
    })
    if (sameKey?.sessionTableId === st.id) {
      replayedInTx = true
      return
    }
    const cycle = locked.cycles[0]
    if (locked.status !== "OPEN" || !cycle)
      throw new ConflictError("Esta mesa no está abierta.")
    const active = await tx.tableParticipation.count({
      where: { sessionTableId: st.id, status: "ACTIVE" },
    })
    if (active > 0) {
      throw new BusinessRuleError(
        `No puedes cerrar esta mesa mientras tenga jugadores activos (${active}). Transfiérelos a otra mesa abierta o liquídalos.`
      )
    }
    // Módulo 12: tampoco con entregas de fichas o recepciones de
    // liquidación sin resolver en el ciclo (afectarían la conciliación).
    // Las participaciones SETTLING (fichas recibidas, falta pagar) sí pueden
    // quedar: su obligación sobrevive al cierre.
    const [pendingPurchases, pendingSettlements] = await Promise.all([
      tx.chipPurchase.count({
        where: {
          cycleId: cycle.id,
          status: { in: ["DRAFT", "READY_FOR_DELIVERY"] },
        },
      }),
      tx.playerSettlement.count({
        where: {
          cycleId: cycle.id,
          status: { in: ["DRAFT", "READY_FOR_CONFIRMATION"] },
        },
      }),
    ])
    if (pendingPurchases > 0) {
      throw new BusinessRuleError(
        `No puedes cerrar esta mesa: tiene ${pendingPurchases} compra(s) sin entrega resuelta. Entrégalas o cancélalas.`
      )
    }
    if (pendingSettlements > 0) {
      throw new BusinessRuleError(
        `No puedes cerrar esta mesa: tiene ${pendingSettlements} liquidación(es) sin recepción física confirmada. Confírmalas o cancélalas.`
      )
    }
    const now = new Date()
    const { count } = await tx.sessionTableCycle.updateMany({
      where: { id: cycle.id, status: "OPEN" },
      data: {
        status: "CLOSED",
        closedAt: now,
        closedById: actor.id,
        closingNotes: input.notes ?? null,
        closeIdempotencyKey: input.idempotencyKey,
      },
    })
    if (count !== 1) throw new ConflictError("La mesa cambió de estado")
    await tx.sessionTable.update({
      where: { id: st.id },
      data: { status: "CLOSED" },
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.SESSION_TABLE_CLOSED,
        entityType: "SessionTable",
        entityId: st.id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          folio: session.folio,
          table: locked.table.name,
          tableId,
          cycleNumber: cycle.cycleNumber,
          cycleId: cycle.id,
        },
      },
      tx
    )
    // Módulo 12: registro del ciclo cerrado con su actividad ATRIBUIDA
    // (no es un resultado neto de la mesa: las transferencias no cuantifican
    // las fichas que el jugador se llevó a la otra mesa).
    const summary = await getCycleActivitySummary(tx, cycle.id)
    await recordAudit(
      {
        action: AUDIT_ACTIONS.TABLE_CYCLE_CLOSED,
        entityType: "SessionTableCycle",
        entityId: cycle.id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          sessionId,
          folio: session.folio,
          table: locked.table.name,
          tableId,
          cycleNumber: cycle.cycleNumber,
          openedAt: summary.openedAt,
          closedAt: now.toISOString(),
          ...summary.metrics,
        },
      },
      tx
    )
  }, TABLE_TX)
  return {
    table: await getSessionTableDetail(sessionId, tableId),
    replayed: replayedInTx,
  }
}

// ── Contratos para el cierre de sesión (Módulo 12) ────────────────────

/**
 * Actividad ATRIBUIDA a un ciclo de mesa (compras, recompras, devoluciones
 * por liquidación, jugadores que terminaron o se transfirieron). Son
 * movimientos registrados con esa mesa, NO un resultado neto: con
 * transferencias, las fichas viajan con el jugador sin cuantificarse.
 */
export async function getCycleActivitySummary(db: Db, cycleId: string) {
  const cycle = await db.sessionTableCycle.findUniqueOrThrow({
    where: { id: cycleId },
    select: {
      id: true,
      cycleNumber: true,
      status: true,
      openedAt: true,
      closedAt: true,
      openedBy: { select: { id: true, name: true } },
      closedBy: { select: { id: true, name: true } },
      sessionTable: { select: { table: { select: { name: true } } } },
    },
  })
  const [purchases, settlements, participations] = await Promise.all([
    db.chipPurchase.groupBy({
      by: ["purchaseType"],
      where: { cycleId, status: "CONFIRMED" },
      _count: { _all: true },
      _sum: { nominalAmount: true },
    }),
    db.playerSettlement.groupBy({
      by: ["status"],
      where: {
        cycleId,
        status: { in: ["PENDING_PAYOUT", "COMPLETED"] },
      },
      _count: { _all: true },
      _sum: { returnedNominalAmount: true },
    }),
    db.tableParticipation.groupBy({
      by: ["status"],
      where: { cycleId },
      _count: { _all: true },
    }),
  ])
  const fmt2 = (v: Prisma.Decimal | null | undefined) =>
    new Prisma.Decimal(v ?? 0).toFixed(2)
  const p = (type: "INITIAL_PURCHASE" | "REBUY") =>
    purchases.find((x) => x.purchaseType === type)
  const sOf = (status: "PENDING_PAYOUT" | "COMPLETED") =>
    settlements.find((x) => x.status === status)
  const partOf = (status: string) =>
    participations.find((x) => x.status === status)?._count._all ?? 0
  const returned = settlements.reduce(
    (acc, x) => acc.add(x._sum.returnedNominalAmount ?? 0),
    new Prisma.Decimal(0)
  )
  return {
    cycleId: cycle.id,
    table: cycle.sessionTable.table.name,
    cycleNumber: cycle.cycleNumber,
    status: cycle.status,
    openedAt: cycle.openedAt.toISOString(),
    closedAt: cycle.closedAt?.toISOString() ?? null,
    openedBy: cycle.openedBy,
    closedBy: cycle.closedBy,
    metrics: {
      initialPurchases: p("INITIAL_PURCHASE")?._count._all ?? 0,
      initialPurchasesNominal: fmt2(p("INITIAL_PURCHASE")?._sum.nominalAmount),
      rebuys: p("REBUY")?._count._all ?? 0,
      rebuysNominal: fmt2(p("REBUY")?._sum.nominalAmount),
      returnedNominal: returned.toFixed(2),
      playersFinished: partOf("SETTLED") + partOf("SETTLING"),
      playersTransferred: partOf("TRANSFERRED"),
      playersActive: partOf("ACTIVE"),
      settlementsCompleted: sOf("COMPLETED")?._count._all ?? 0,
      settlementsPendingPayout: sOf("PENDING_PAYOUT")?._count._all ?? 0,
    },
  }
}

/** Mesas abiertas y participantes activos que impiden cerrar la sesión. */
export async function getOpenTablesAndPendingParticipants(
  db: Db,
  sessionId: string
) {
  const [openTables, activeParticipants] = await Promise.all([
    db.sessionTable.findMany({
      where: { sessionId, status: "OPEN" },
      select: { id: true, table: { select: { name: true } } },
    }),
    db.tableParticipation.count({ where: { sessionId, status: "ACTIVE" } }),
  ])
  return {
    openTables: openTables.map((t) => ({ id: t.id, name: t.table.name })),
    activeParticipants,
  }
}
