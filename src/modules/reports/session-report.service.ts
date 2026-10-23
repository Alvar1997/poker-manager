import "server-only"

import { Prisma } from "@/generated/prisma/client"
import { NotFoundError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import type { ClosureReportContent } from "@/modules/closure/closure-report.content"
import {
  getCreditSummary,
  listCreditPlayers,
} from "@/modules/reports/credit-report.service"
import type { ReportFilters } from "@/modules/reports/report.filters"
import {
  businessRange,
  dec,
  fmt,
  ZERO,
  type Dec,
} from "@/modules/reports/report.math"

/**
 * Reportes por sesión y por mesa (Módulo 14). Solo lectura.
 *
 * Las métricas se calculan POR LOTE de sesiones (una consulta agrupada por
 * métrica, nunca una por sesión). La vista HISTÓRICA del cierre sale del
 * comprobante inmutable (`closure_reports.content`); la vista ACTUAL de las
 * obligaciones originadas en la sesión se deriva de los movimientos
 * vigentes. Ambas se muestran separadas y nunca se mezclan.
 */

type Db = Prisma.TransactionClient | typeof prisma

const inList = (ids: string[]) => Prisma.join(ids.map((i) => Prisma.sql`${i}`))

export type SessionMetrics = {
  tablesUsed: number
  cycles: number
  players: number
  initialCount: number
  initialNominal: string
  rebuyCount: number
  rebuyNominal: string
  deliveredNominal: string
  returnedNominal: string
  netNotReturned: string
  creditsOriginated: string
  creditsOutstandingNow: string
  collections: {
    cash: string
    transferConfirmed: string
    cardApproved: string
    total: string
    transferPending: string
  }
  debtPaymentsInSession: { count: number; amount: string }
  payables: {
    original: string
    executed: string
    pending: string
    inTransit: string
    settlementsCompleted: number
    settlementsPendingPayout: number
  }
}

function emptyMetrics(): SessionMetrics {
  return {
    tablesUsed: 0,
    cycles: 0,
    players: 0,
    initialCount: 0,
    initialNominal: "0.00",
    rebuyCount: 0,
    rebuyNominal: "0.00",
    deliveredNominal: "0.00",
    returnedNominal: "0.00",
    netNotReturned: "0.00",
    creditsOriginated: "0.00",
    creditsOutstandingNow: "0.00",
    collections: {
      cash: "0.00",
      transferConfirmed: "0.00",
      cardApproved: "0.00",
      total: "0.00",
      transferPending: "0.00",
    },
    debtPaymentsInSession: { count: 0, amount: "0.00" },
    payables: {
      original: "0.00",
      executed: "0.00",
      pending: "0.00",
      inTransit: "0.00",
      settlementsCompleted: 0,
      settlementsPendingPayout: 0,
    },
  }
}

/** Métricas de varias sesiones con un número FIJO de consultas agrupadas. */
export async function sessionMetrics(
  db: Db,
  sessionIds: string[]
): Promise<Map<string, SessionMetrics>> {
  const map = new Map<string, SessionMetrics>()
  for (const id of sessionIds) map.set(id, emptyMetrics())
  if (sessionIds.length === 0) return map
  const ids = inList(sessionIds)

  const [
    cycles,
    players,
    purchases,
    chips,
    credits,
    collections,
    pendingTransfers,
    debtPayments,
    payables,
    settlements,
  ] = await Promise.all([
    db.$queryRaw<{ sessionId: string; tables: bigint; cycles: bigint }[]>`
      SELECT st."sessionId", COUNT(DISTINCT st."id") AS "tables", COUNT(c."id") AS "cycles"
      FROM "session_tables" st JOIN "session_table_cycles" c ON c."sessionTableId" = st."id"
      WHERE st."sessionId" IN (${ids}) GROUP BY st."sessionId"`,
    db.$queryRaw<{ sessionId: string; players: bigint }[]>`
      SELECT "sessionId", COUNT(DISTINCT "playerId") AS "players"
      FROM "table_participations" WHERE "sessionId" IN (${ids}) GROUP BY "sessionId"`,
    db.chipPurchase.groupBy({
      by: ["sessionId", "purchaseType"],
      where: { sessionId: { in: sessionIds }, status: "CONFIRMED" },
      _sum: { nominalAmount: true },
      _count: true,
    }),
    db.$queryRaw<{ sessionId: string; delivered: string; returned: string }[]>`
      SELECT "sessionId",
        COALESCE(SUM(GREATEST("circulationAfter" - "circulationBefore", 0)), 0)::text AS "delivered",
        COALESCE(SUM(GREATEST("circulationBefore" - "circulationAfter", 0)), 0)::text AS "returned"
      FROM "chip_nominal_movements" WHERE "sessionId" IN (${ids}) GROUP BY "sessionId"`,
    db.$queryRaw<{ sessionId: string; original: string; balance: string }[]>`
      SELECT d."sessionId", SUM(d."originalAmount")::text AS "original",
        SUM(d."originalAmount" - COALESCE(a."applied", 0))::text AS "balance"
      FROM "player_debts" d
      LEFT JOIN (
        SELECT "receivableId", SUM(CASE WHEN "kind" = 'APPLICATION' THEN "amount" ELSE -"amount" END) AS "applied"
        FROM "payment_allocations" GROUP BY "receivableId"
      ) a ON a."receivableId" = d."id"
      WHERE d."sessionId" IN (${ids}) GROUP BY d."sessionId"`,
    // Cobros REALES de compras ENTREGADAS, con la misma regla del Módulo 08
    // (summarizePayments): efectivo CONFIRMED, terminal APPROVED y
    // transferencia solo con su verificación manual CONFIRMADA (por el
    // importe confirmado). Una transferencia pendiente no es cobro.
    db.$queryRaw<{ sessionId: string; method: string; amount: string }[]>`
      SELECT pu."sessionId", pp."method"::text AS "method",
        SUM(CASE WHEN pp."method" = 'BANK_TRANSFER' THEN COALESCE(b."confirmedAmount", pp."amount") ELSE pp."amount" END)::text AS "amount"
      FROM "purchase_payments" pp
      JOIN "chip_purchases" pu ON pu."id" = pp."purchaseId"
      LEFT JOIN "bank_transfer_verifications" b ON b."id" = pp."bankTransferId"
      WHERE pu."sessionId" IN (${ids}) AND pu."status" = 'CONFIRMED'
        AND (
          (pp."method" = 'CASH' AND pp."status" = 'CONFIRMED')
          OR (pp."method" IN ('CARD_DEBIT', 'CARD_CREDIT') AND pp."status" = 'APPROVED')
          OR (pp."method" = 'BANK_TRANSFER' AND pp."status" <> 'CANCELLED' AND b."status" = 'CONFIRMED')
        )
      GROUP BY pu."sessionId", pp."method"`,
    db.$queryRaw<{ sessionId: string; amount: string }[]>`
      SELECT pu."sessionId", SUM(pp."amount")::text AS "amount"
      FROM "purchase_payments" pp
      JOIN "chip_purchases" pu ON pu."id" = pp."purchaseId"
      JOIN "bank_transfer_verifications" b ON b."id" = pp."bankTransferId"
      WHERE pu."sessionId" IN (${ids}) AND pu."status" = 'CONFIRMED'
        AND pp."method" = 'BANK_TRANSFER' AND pp."status" <> 'CANCELLED'
        AND b."status" = 'PENDING_VERIFICATION'
      GROUP BY pu."sessionId"`,
    db.receivablePayment.groupBy({
      by: ["sessionId"],
      where: { sessionId: { in: sessionIds }, status: "CONFIRMED" },
      _sum: { amount: true },
      _count: true,
    }),
    db.$queryRaw<
      {
        sessionId: string
        original: string
        executed: string
        inTransit: string
      }[]
    >`
      SELECT sp."sourceSessionId" AS "sessionId", SUM(sp."originalAmount")::text AS "original",
        COALESCE(SUM(x."executed"), 0)::text AS "executed",
        COALESCE(SUM(x."inTransit"), 0)::text AS "inTransit"
      FROM "settlement_payables" sp
      LEFT JOIN (
        SELECT "payableId",
          SUM("amount") FILTER (WHERE "status" = 'EXECUTED') AS "executed",
          SUM("amount") FILTER (WHERE "status" = 'PENDING') AS "inTransit"
        FROM "settlement_payouts" GROUP BY "payableId"
      ) x ON x."payableId" = sp."id"
      WHERE sp."sourceSessionId" IN (${ids}) AND sp."status" <> 'VOIDED'
      GROUP BY sp."sourceSessionId"`,
    db.playerSettlement.groupBy({
      by: ["sessionId", "status"],
      where: {
        sessionId: { in: sessionIds },
        status: { in: ["COMPLETED", "PENDING_PAYOUT"] },
      },
      _count: true,
    }),
  ])

  for (const r of cycles) {
    const m = map.get(r.sessionId)!
    m.tablesUsed = Number(r.tables)
    m.cycles = Number(r.cycles)
  }
  for (const r of players) map.get(r.sessionId)!.players = Number(r.players)
  for (const r of purchases) {
    const m = map.get(r.sessionId)!
    const nominal = fmt(dec(r._sum.nominalAmount))
    if (r.purchaseType === "REBUY") {
      m.rebuyCount = r._count
      m.rebuyNominal = nominal
    } else {
      m.initialCount += r._count
      m.initialNominal = fmt(dec(m.initialNominal).add(dec(nominal)))
    }
  }
  for (const r of chips) {
    const m = map.get(r.sessionId)!
    m.deliveredNominal = fmt(dec(r.delivered))
    m.returnedNominal = fmt(dec(r.returned))
    m.netNotReturned = fmt(dec(r.delivered).sub(dec(r.returned)))
  }
  for (const r of credits) {
    const m = map.get(r.sessionId)!
    m.creditsOriginated = fmt(dec(r.original))
    m.creditsOutstandingNow = fmt(dec(r.balance))
  }
  for (const r of collections) {
    const c = map.get(r.sessionId)!.collections
    const v = dec(r.amount)
    if (r.method === "CASH") c.cash = fmt(dec(c.cash).add(v))
    else if (r.method === "BANK_TRANSFER")
      c.transferConfirmed = fmt(dec(c.transferConfirmed).add(v))
    else c.cardApproved = fmt(dec(c.cardApproved).add(v))
    c.total = fmt(dec(c.total).add(v))
  }
  for (const r of pendingTransfers)
    map.get(r.sessionId)!.collections.transferPending = fmt(dec(r.amount))
  for (const r of debtPayments) {
    if (!r.sessionId) continue
    map.get(r.sessionId)!.debtPaymentsInSession = {
      count: r._count,
      amount: fmt(dec(r._sum.amount)),
    }
  }
  for (const r of payables) {
    const p = map.get(r.sessionId)!.payables
    p.original = fmt(dec(r.original))
    p.executed = fmt(dec(r.executed))
    p.pending = fmt(dec(r.original).sub(dec(r.executed)))
    p.inTransit = fmt(dec(r.inTransit))
  }
  for (const r of settlements) {
    const p = map.get(r.sessionId)!.payables
    if (r.status === "COMPLETED") p.settlementsCompleted = r._count
    else p.settlementsPendingPayout = r._count
  }
  return map
}

export function sessionWhere(f: ReportFilters): Prisma.PokerSessionWhereInput {
  // Por JORNADA: fecha operativa de la sesión (columna DATE), no la fecha
  // de captura ni la de movimientos posteriores.
  const range =
    f.from || f.to
      ? {
          ...(f.from && { gte: new Date(`${f.from}T00:00:00.000Z`) }),
          ...(f.to && { lte: new Date(`${f.to}T00:00:00.000Z`) }),
        }
      : undefined
  return {
    ...(f.sessionId && { id: f.sessionId }),
    ...(f.status && { status: f.status as never }),
    ...(f.operatorId && { createdById: f.operatorId }),
    ...(range && { businessDate: range }),
    ...(f.tableId && { tables: { some: { tableId: f.tableId } } }),
    ...(f.playerId && { participations: { some: { playerId: f.playerId } } }),
  }
}

const closureSelect = {
  closureReport: {
    select: { id: true, folio: true, content: true, createdAt: true },
  },
  closures: {
    where: { status: "COMPLETED" as const },
    select: {
      approval: {
        select: {
          approvedAt: true,
          approvedBy: { select: { id: true, name: true } },
        },
      },
      withdrawal: {
        select: {
          amount: true,
          recipientName: true,
          withdrawalAt: true,
          withdrawnBy: { select: { name: true } },
        },
      },
      discrepancies: {
        select: {
          kind: true,
          differenceAmount: true,
          status: true,
          resolution: true,
        },
      },
      adjustments: { select: { amount: true, reason: true } },
    },
  },
} satisfies Prisma.PokerSessionSelect

type ClosureRow = Prisma.PokerSessionGetPayload<{
  select: typeof closureSelect
}>

function closureSummary(s: ClosureRow) {
  const closure = s.closures[0]
  const content = s.closureReport?.content as ClosureReportContent | undefined
  if (!closure && !content) return null
  const adjustments = (closure?.adjustments ?? []).reduce(
    (acc, a) => acc.add(a.amount),
    ZERO as Dec
  )
  return {
    reportFolio: s.closureReport?.folio ?? null,
    kind: content?.kind ?? null,
    approvedBy: closure?.approval?.approvedBy ?? null,
    approvedAt: closure?.approval?.approvedAt?.toISOString() ?? null,
    chipCount: content
      ? {
          expected: content.inventory.expectedCustody,
          counted: content.inventory.countedCustody,
          difference: content.inventory.physicalDifference,
        }
      : null,
    cashCount: content
      ? {
          expected: content.cash.expected,
          counted: content.cash.counted,
          difference: content.cash.difference,
          final: content.cash.final,
        }
      : null,
    withdrawal: closure?.withdrawal
      ? {
          amount: fmt(dec(closure.withdrawal.amount)),
          recipientName: closure.withdrawal.recipientName,
          withdrawnBy: closure.withdrawal.withdrawnBy.name,
          at: closure.withdrawal.withdrawalAt.toISOString(),
        }
      : null,
    discrepancies: (closure?.discrepancies ?? []).map((d) => ({
      kind: d.kind,
      difference: fmt(dec(d.differenceAmount)),
      status: d.status,
      resolution: d.resolution,
    })),
    adjustmentsTotal: fmt(adjustments),
    /** Deuda originada pendiente AL CIERRE (snapshot inmutable). */
    creditsOutstandingAtClosure: content?.credits.outstanding ?? null,
    payablesPendingAtClosure: content?.settlements.pendingAmount ?? null,
    adjustmentsCount: closure?.adjustments.length ?? 0,
  }
}

const sessionListSelect = {
  id: true,
  folio: true,
  previousFolio: true,
  businessDate: true,
  isHistorical: true,
  status: true,
  createdAt: true,
  openedAt: true,
  closedAt: true,
  closingStartedAt: true,
  createdBy: { select: { id: true, name: true } },
  ...closureSelect,
} satisfies Prisma.PokerSessionSelect

type SessionListRow = Prisma.PokerSessionGetPayload<{
  select: typeof sessionListSelect
}>

function sessionHeader(s: SessionListRow) {
  return {
    id: s.id,
    folio: s.folio,
    /** Folio en el formato anterior (SES-000001), para conciliar. */
    previousFolio: s.previousFolio,
    isHistorical: s.isHistorical,
    status: s.status,
    /** Fecha operativa de la sesión (businessDate), no la de captura. */
    operatedDay: s.businessDate.toISOString().slice(0, 10),
    openedAt: s.openedAt?.toISOString() ?? null,
    closedAt: s.closedAt?.toISOString() ?? null,
    createdBy: s.createdBy,
  }
}

/** Reporte por sesiones (paginado, más recientes primero). */
export async function listSessionReports(f: ReportFilters, db: Db = prisma) {
  const where = sessionWhere(f)
  const [total, rows] = await Promise.all([
    db.pokerSession.count({ where }),
    db.pokerSession.findMany({
      where,
      select: sessionListSelect,
      orderBy: [{ businessDate: "desc" }, { sequenceNumber: "desc" }],
      skip: (f.page - 1) * f.pageSize,
      take: f.pageSize,
    }),
  ])
  const metrics = await sessionMetrics(
    db,
    rows.map((r) => r.id)
  )
  return {
    page: f.page,
    pageSize: f.pageSize,
    total,
    items: rows.map((s) => ({
      ...sessionHeader(s),
      metrics: metrics.get(s.id)!,
      closure: closureSummary(s),
    })),
  }
}

/** Todas las sesiones de los filtros (exportación / comparativos). */
export async function listAllSessionReports(
  f: ReportFilters,
  db: Db = prisma,
  limit = 5_000
) {
  const rows = await db.pokerSession.findMany({
    where: sessionWhere(f),
    select: sessionListSelect,
    orderBy: [{ businessDate: "asc" }, { sequenceNumber: "asc" }],
    take: limit,
  })
  const metrics = await sessionMetrics(
    db,
    rows.map((r) => r.id)
  )
  return rows.map((s) => ({
    ...sessionHeader(s),
    metrics: metrics.get(s.id)!,
    closure: closureSummary(s),
  }))
}

export type SessionReportRow = Awaited<
  ReturnType<typeof listAllSessionReports>
>[number]

/**
 * Detalle de una sesión con DOS vistas separadas:
 *   - `historical`: el comprobante de cierre tal como se guardó (no cambia);
 *   - `current`: obligaciones originadas en la sesión con sus saldos HOY.
 */
export async function getSessionReport(sessionId: string, db: Db = prisma) {
  const s = await db.pokerSession.findUnique({
    where: { id: sessionId },
    select: sessionListSelect,
  })
  if (!s) throw new NotFoundError("Sesión no encontrada")
  const metrics = (await sessionMetrics(db, [s.id])).get(s.id)!
  const filters = { page: 1, pageSize: 100, sessionId: s.id }
  const [creditSummary, creditPlayers, tables] = await Promise.all([
    getCreditSummary(filters, db),
    listCreditPlayers(filters, db),
    listTableCycles({ ...filters, sessionId: s.id }, db),
  ])
  const content = s.closureReport?.content as ClosureReportContent | undefined
  return {
    ...sessionHeader(s),
    metrics,
    closure: closureSummary(s),
    historical: content
      ? {
          reportFolio: s.closureReport!.folio,
          createdAt: s.closureReport!.createdAt.toISOString(),
          creditsOriginated: content.credits.originated,
          creditsOutstandingAtClosure: content.credits.outstanding,
          payablesPendingAtClosure: content.settlements.pendingAmount,
          payablesPlayersAtClosure: content.settlements.pendingPlayers,
          sessionNetNotReturned: content.inventory.sessionNetNotReturned,
          globalCirculationAtClosure: content.inventory.globalCirculation,
          cashFinal: content.cash.final,
        }
      : null,
    current: {
      creditsOriginated: creditSummary.original,
      creditsOutstanding: creditSummary.balance,
      paymentsAppliedSinceOrigin: creditSummary.paymentsApplied,
      offsets: creditSummary.offsets,
      reversals: creditSummary.reversals,
      playersWithBalance: creditSummary.playersWithBalance,
      players: creditPlayers.items,
      payablesPending: metrics.payables.pending,
      payablesInTransit: metrics.payables.inTransit,
    },
    tables: tables.items,
  }
}

// ── Mesas: un renglón por CICLO ───────────────────────────────────────

export async function listTableCycles(f: ReportFilters, db: Db = prisma) {
  const range = businessRange(f.from, f.to)
  const where: Prisma.SessionTableCycleWhereInput = {
    ...(f.status && { status: f.status as never }),
    ...(range && { openedAt: range }),
    sessionTable: {
      ...(f.sessionId && { sessionId: f.sessionId }),
      ...(f.tableId && { tableId: f.tableId }),
    },
    ...(f.playerId && { participations: { some: { playerId: f.playerId } } }),
  }
  const [total, cycles] = await Promise.all([
    db.sessionTableCycle.count({ where }),
    db.sessionTableCycle.findMany({
      where,
      orderBy: [{ openedAt: "desc" }, { id: "desc" }],
      skip: (f.page - 1) * f.pageSize,
      take: f.pageSize,
      select: {
        id: true,
        cycleNumber: true,
        status: true,
        openedAt: true,
        closedAt: true,
        smallBlindSnapshot: true,
        bigBlindSnapshot: true,
        openedBy: { select: { name: true } },
        closedBy: { select: { name: true } },
        sessionTable: {
          select: {
            id: true,
            table: { select: { id: true, name: true } },
            session: { select: { id: true, folio: true } },
          },
        },
      },
    }),
  ])
  const ids = cycles.map((c) => c.id)
  const [participants, purchases, settlements, transfers] = await Promise.all([
    ids.length
      ? db.$queryRaw<{ cycleId: string; players: bigint }[]>`
          SELECT "cycleId", COUNT(DISTINCT "playerId") AS "players"
          FROM "table_participations" WHERE "cycleId" IN (${inList(ids)}) GROUP BY "cycleId"`
      : [],
    db.chipPurchase.groupBy({
      by: ["cycleId", "purchaseType"],
      where: { cycleId: { in: ids }, status: "CONFIRMED" },
      _sum: { nominalAmount: true },
      _count: true,
    }),
    db.playerSettlement.groupBy({
      by: ["cycleId"],
      where: {
        cycleId: { in: ids },
        status: { in: ["PENDING_PAYOUT", "COMPLETED"] },
      },
      _sum: { returnedNominalAmount: true },
      _count: true,
    }),
    db.tableTransfer.findMany({
      where: {
        OR: [
          { sourceParticipation: { cycleId: { in: ids } } },
          { destinationParticipation: { cycleId: { in: ids } } },
        ],
      },
      select: {
        sourceParticipation: { select: { cycleId: true } },
        destinationParticipation: { select: { cycleId: true } },
      },
    }),
  ])
  return {
    page: f.page,
    pageSize: f.pageSize,
    total,
    /**
     * No se calcula un resultado neto por mesa: con transferencias de mesa el
     * importe nominal trasladado no se registra (Módulo 07) y la caja es
     * central.
     */
    note: "Las compras conservan su mesa de origen y las liquidaciones la mesa final. Con transferencias entre mesas no se registra el valor trasladado, así que no se atribuyen resultados exactos por mesa. La caja es central.",
    items: cycles.map((c) => {
      const ps = purchases.filter((p) => p.cycleId === c.id)
      const initial = ps.filter((p) => p.purchaseType !== "REBUY")
      const rebuy = ps.find((p) => p.purchaseType === "REBUY")
      const st = settlements.find((x) => x.cycleId === c.id)
      const delivered = ps.reduce(
        (acc, p) => acc.add(dec(p._sum.nominalAmount)),
        ZERO
      )
      return {
        id: c.id,
        table: c.sessionTable.table,
        blinds: `${fmt(dec(c.smallBlindSnapshot))}/${fmt(dec(c.bigBlindSnapshot))}`,
        session: c.sessionTable.session,
        cycleNumber: c.cycleNumber,
        status: c.status,
        openedAt: c.openedAt.toISOString(),
        closedAt: c.closedAt?.toISOString() ?? null,
        openedBy: c.openedBy.name,
        closedBy: c.closedBy?.name ?? null,
        participants: Number(
          participants.find((p) => p.cycleId === c.id)?.players ?? 0
        ),
        initialCount: initial.reduce((acc, p) => acc + p._count, 0),
        initialNominal: fmt(
          initial.reduce((acc, p) => acc.add(dec(p._sum.nominalAmount)), ZERO)
        ),
        rebuyCount: rebuy?._count ?? 0,
        rebuyNominal: fmt(dec(rebuy?._sum.nominalAmount)),
        deliveredNominal: fmt(delivered),
        settlementsCount: st?._count ?? 0,
        returnedNominal: fmt(dec(st?._sum.returnedNominalAmount)),
        transfersIn: transfers.filter(
          (t) =>
            t.destinationParticipation.cycleId === c.id &&
            t.sourceParticipation.cycleId !== c.id
        ).length,
        transfersOut: transfers.filter(
          (t) =>
            t.sourceParticipation.cycleId === c.id &&
            t.destinationParticipation.cycleId !== c.id
        ).length,
      }
    }),
  }
}

export type TableCycleRow = Awaited<
  ReturnType<typeof listTableCycles>
>["items"][number]
