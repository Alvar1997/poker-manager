import "server-only"

import { Prisma } from "@/generated/prisma/client"
import { NotFoundError, ValidationError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import type { ReportFilters } from "@/modules/reports/report.filters"
import {
  buildCreditTree,
  businessRange,
  creditTotals,
  dec,
  filterTreeByDebtStatus,
  fmt,
  paymentTotals,
  ZERO,
  type AllocationFact,
  type DebtFact,
  type PlayerNode,
} from "@/modules/reports/report.math"

/**
 * Reportes de créditos (Módulo 14): consulta pura sobre el Módulo 10.
 * Fuente de verdad: `player_debts` (obligación con su sesión, mesa y compra
 * de ORIGEN, inmutables) + el libro `payment_allocations`. Nunca escribe.
 *
 * Toda deuda puede consultarse de forma global por jugador, desglosada por
 * sesión de origen y finalmente por cada compra o recompra. Los pagos
 * posteriores se aplican a las obligaciones originales y no trasladan la
 * deuda a la fecha o sesión del pago.
 */

type Db = Prisma.TransactionClient | typeof prisma

/** Límite de filas que una consulta completa (árbol / XLSX) puede cargar. */
export const MAX_DETAIL_ROWS = 20_000

export function debtWhere(f: ReportFilters): Prisma.PlayerDebtWhereInput {
  const createdAt = businessRange(f.debtFrom, f.debtTo)
  return {
    ...(f.playerId && { playerId: f.playerId }),
    ...(f.sessionId && { sessionId: f.sessionId }),
    ...(f.tableId && { tableId: f.tableId }),
    ...(createdAt && { createdAt }),
    ...(f.partnerId && {
      authorization: { authorizedByPartnerId: f.partnerId },
    }),
  }
}

const debtSelect = {
  id: true,
  createdAt: true,
  originalAmount: true,
  player: { select: { id: true, name: true } },
  session: {
    select: {
      id: true,
      folio: true,
      businessDate: true,
      openedAt: true,
      createdAt: true,
      status: true,
      closedAt: true,
    },
  },
  purchase: {
    select: {
      id: true,
      folio: true,
      purchaseType: true,
      rebuyNumber: true,
      nominalAmount: true,
      confirmedAt: true,
      table: { select: { id: true, name: true } },
      cycle: { select: { cycleNumber: true } },
      delivery: {
        select: {
          signature: { select: { id: true, status: true, signedAt: true } },
        },
      },
    },
  },
  authorization: {
    select: {
      authorizedByPartnerId: true,
      partnerNameSnapshot: true,
      authorizationChannel: true,
    },
  },
} satisfies Prisma.PlayerDebtSelect

const allocationSelect = {
  id: true,
  receivableId: true,
  kind: true,
  source: true,
  amount: true,
  allocatedAt: true,
  allocationOrder: true,
  reversesAllocationId: true,
  receivablePayment: {
    select: {
      id: true,
      folio: true,
      method: true,
      origin: true,
      sessionId: true,
      session: { select: { folio: true } },
      amount: true,
      status: true,
      confirmedAt: true,
    },
  },
  purchasePayment: { select: { id: true, method: true } },
  settlement: { select: { id: true, folio: true, sessionId: true } },
} satisfies Prisma.PaymentAllocationSelect

type DebtRow = Prisma.PlayerDebtGetPayload<{ select: typeof debtSelect }>
type AllocRow = Prisma.PaymentAllocationGetPayload<{
  select: typeof allocationSelect
}>

function toDebtFact(d: DebtRow): DebtFact {
  return {
    id: d.id,
    createdAt: d.createdAt,
    originalAmount: dec(d.originalAmount),
    player: d.player,
    session: {
      id: d.session.id,
      folio: d.session.folio,
      operatedAt: d.session.openedAt ?? d.session.createdAt,
      businessDate: d.session.businessDate.toISOString().slice(0, 10),
      status: d.session.status,
      closedAt: d.session.status === "CLOSED" ? d.session.closedAt : null,
    },
    table: d.purchase.table,
    cycleNumber: d.purchase.cycle?.cycleNumber ?? null,
    purchase: {
      id: d.purchase.id,
      folio: d.purchase.folio,
      type: d.purchase.purchaseType,
      rebuyNumber: d.purchase.rebuyNumber,
      nominalAmount: dec(d.purchase.nominalAmount),
      confirmedAt: d.purchase.confirmedAt,
    },
    authorization: {
      partnerId: d.authorization.authorizedByPartnerId,
      partnerName: d.authorization.partnerNameSnapshot,
      channel: d.authorization.authorizationChannel,
    },
    signature: d.purchase.delivery?.signature ?? null,
  }
}

function toAllocationFact(a: AllocRow): AllocationFact {
  const p = a.receivablePayment
  return {
    id: a.id,
    receivableId: a.receivableId,
    kind: a.kind,
    source: a.source,
    amount: dec(a.amount),
    allocatedAt: a.allocatedAt,
    allocationOrder: a.allocationOrder,
    reversesAllocationId: a.reversesAllocationId,
    payment: p
      ? {
          id: p.id,
          folio: p.folio,
          method: p.method,
          origin: p.origin,
          sessionId: p.sessionId,
          sessionFolio: p.session?.folio ?? null,
          amount: dec(p.amount),
          status: p.status,
          paidAt: p.confirmedAt,
        }
      : null,
    purchasePayment: a.purchasePayment,
    settlement: a.settlement,
  }
}

/** Hechos de crédito filtrados: DOS consultas (deudas y aplicaciones), sin N+1. */
export async function loadCreditFacts(
  where: Prisma.PlayerDebtWhereInput,
  db: Db = prisma
) {
  const count = await db.playerDebt.count({ where })
  if (count > MAX_DETAIL_ROWS)
    throw new ValidationError(
      `La consulta abarca ${count} obligaciones (máximo ${MAX_DETAIL_ROWS}). Acota los filtros.`
    )
  const [debts, allocations] = await Promise.all([
    db.playerDebt.findMany({
      where,
      select: debtSelect,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    db.paymentAllocation.findMany({
      where: { receivable: where },
      select: allocationSelect,
      orderBy: [{ allocatedAt: "asc" }, { id: "asc" }],
    }),
  ])
  return {
    debts: debts.map(toDebtFact),
    allocations: allocations.map(toAllocationFact),
  }
}

/** Árbol completo jugador → sesión → compra → aplicaciones para los filtros. */
export async function getCreditTree(f: ReportFilters, db: Db = prisma) {
  const facts = await loadCreditFacts(debtWhere(f), db)
  return filterTreeByDebtStatus(
    buildCreditTree(facts.debts, facts.allocations),
    f.status
  )
}

// ── Agregaciones SQL (listado global paginado) ────────────────────────

function sqlConditions(f: ReportFilters): Prisma.Sql {
  const conds: Prisma.Sql[] = [Prisma.sql`TRUE`]
  if (f.playerId) conds.push(Prisma.sql`d."playerId" = ${f.playerId}`)
  if (f.sessionId) conds.push(Prisma.sql`d."sessionId" = ${f.sessionId}`)
  if (f.tableId) conds.push(Prisma.sql`d."tableId" = ${f.tableId}`)
  if (f.partnerId)
    conds.push(Prisma.sql`pca."authorizedByPartnerId" = ${f.partnerId}`)
  const r = businessRange(f.debtFrom, f.debtTo)
  if (r?.gte) conds.push(Prisma.sql`d."createdAt" >= ${r.gte}`)
  if (r?.lt) conds.push(Prisma.sql`d."createdAt" < ${r.lt}`)
  return Prisma.join(conds, " AND ")
}

function statusCondition(status?: string): Prisma.Sql {
  if (status === "PAID") return Prisma.sql`("original" - "applied") <= 0`
  if (status === "OPEN")
    return Prisma.sql`("original" - "applied") > 0 AND "applied" <= 0`
  if (status === "PARTIALLY_PAID")
    return Prisma.sql`("original" - "applied") > 0 AND "applied" > 0`
  return Prisma.sql`TRUE`
}

/** CTE: una fila por deuda con sus componentes derivados del libro. */
function debtsCte(f: ReportFilters): Prisma.Sql {
  return Prisma.sql`
    WITH per_debt AS (
      SELECT d."id", d."playerId", d."sessionId", d."createdAt",
             d."originalAmount" AS "original",
             COALESCE(SUM(CASE WHEN a."kind" = 'APPLICATION' THEN a."amount" ELSE -a."amount" END), 0) AS "applied",
             COALESCE(SUM(a."amount") FILTER (WHERE a."kind" = 'APPLICATION' AND a."source" = 'RECEIVABLE_PAYMENT'), 0) AS "payments",
             COALESCE(SUM(a."amount") FILTER (WHERE a."kind" = 'APPLICATION' AND a."source" = 'PURCHASE_PAYMENT'), 0) AS "linked",
             COALESCE(SUM(a."amount") FILTER (WHERE a."kind" = 'APPLICATION' AND a."source" = 'CHIP_SETTLEMENT_OFFSET'), 0) AS "offsets",
             COALESCE(SUM(a."amount") FILTER (WHERE a."kind" = 'REVERSAL'), 0) AS "reversals",
             COALESCE(SUM(a."amount") FILTER (WHERE a."kind" = 'APPLICATION' AND a."source" = 'PURCHASE_REVERSAL'), 0) AS "extinctions",
             MAX(a."allocatedAt") AS "lastMovementAt"
      FROM "player_debts" d
      JOIN "purchase_credit_authorizations" pca ON pca."id" = d."authorizationId"
      LEFT JOIN "payment_allocations" a ON a."receivableId" = d."id"
      WHERE ${sqlConditions(f)}
      GROUP BY d."id"
    ), debts AS (
      SELECT * FROM per_debt WHERE ${statusCondition(f.status)}
    )`
}

type AggRow = {
  original: string
  payments: string
  linked: string
  offsets: string
  reversals: string
  extinctions: string
  balance: string
}

const aggView = (r: AggRow) => ({
  original: fmt(dec(r.original)),
  paymentsApplied: fmt(dec(r.payments).add(dec(r.linked))),
  payments: fmt(dec(r.payments)),
  linkedPayments: fmt(dec(r.linked)),
  offsets: fmt(dec(r.offsets)),
  reversals: fmt(dec(r.reversals)),
  extinctions: fmt(dec(r.extinctions)),
  balance: fmt(dec(r.balance)),
})

const AGG = Prisma.sql`
  SUM("original")::text AS "original", SUM("payments")::text AS "payments",
  SUM("linked")::text AS "linked", SUM("offsets")::text AS "offsets",
  SUM("reversals")::text AS "reversals",
  SUM("extinctions")::text AS "extinctions",
  SUM("original" - "applied")::text AS "balance"`

/** Resumen global de créditos para los filtros (una consulta). */
export async function getCreditSummary(f: ReportFilters, db: Db = prisma) {
  const [row] = await db.$queryRaw<
    (AggRow & {
      debts: bigint
      players: bigint
      playersWithBalance: bigint
      sessions: bigint
      oldestOpen: Date | null
    })[]
  >`
    ${debtsCte(f)}
    SELECT ${AGG},
      COUNT(*) AS "debts",
      COUNT(DISTINCT "playerId") AS "players",
      COUNT(DISTINCT "playerId") FILTER (WHERE "original" - "applied" > 0) AS "playersWithBalance",
      COUNT(DISTINCT "sessionId") FILTER (WHERE "original" - "applied" > 0) AS "sessions",
      MIN("createdAt") FILTER (WHERE "original" - "applied" > 0) AS "oldestOpen"
    FROM debts
  `
  return {
    ...aggView(row),
    debts: Number(row.debts),
    players: Number(row.players),
    playersWithBalance: Number(row.playersWithBalance),
    sessionsWithBalance: Number(row.sessions),
    oldestOpenDebtAt: row.oldestOpen?.toISOString() ?? null,
  }
}

/** Jugadores con sus totales (paginado, deudas más antiguas primero). */
export async function listCreditPlayers(f: ReportFilters, db: Db = prisma) {
  const offset = (f.page - 1) * f.pageSize
  const rows = await db.$queryRaw<
    (AggRow & {
      playerId: string
      name: string
      debts: bigint
      sessionsWithBalance: bigint
      oldestOpen: Date | null
      lastMovementAt: Date | null
      total: bigint
    })[]
  >`
    ${debtsCte(f)}
    SELECT debts."playerId", p."name", ${AGG},
      COUNT(*) AS "debts",
      COUNT(DISTINCT "sessionId") FILTER (WHERE "original" - "applied" > 0) AS "sessionsWithBalance",
      MIN(debts."createdAt") FILTER (WHERE "original" - "applied" > 0) AS "oldestOpen",
      MAX("lastMovementAt") AS "lastMovementAt",
      COUNT(*) OVER () AS "total"
    FROM debts JOIN "players" p ON p."id" = debts."playerId"
    GROUP BY debts."playerId", p."name"
    ORDER BY "oldestOpen" ASC NULLS LAST, p."name" ASC, debts."playerId" ASC
    LIMIT ${f.pageSize} OFFSET ${offset}
  `
  return {
    page: f.page,
    pageSize: f.pageSize,
    total: rows.length ? Number(rows[0].total) : 0,
    items: rows.map((r) => ({
      player: { id: r.playerId, name: r.name },
      ...aggView(r),
      debts: Number(r.debts),
      sessionsWithBalance: Number(r.sessionsWithBalance),
      oldestOpenDebtAt: r.oldestOpen?.toISOString() ?? null,
      lastMovementAt: r.lastMovementAt?.toISOString() ?? null,
    })),
  }
}

/**
 * Deudas agrupadas por SESIÓN DE ORIGEN (todas las personas), con la deuda
 * registrada en el comprobante de cierre (snapshot inmutable) para
 * compararla con la deuda actual originada allí.
 */
export async function listCreditSessions(f: ReportFilters, db: Db = prisma) {
  const offset = (f.page - 1) * f.pageSize
  const rows = await db.$queryRaw<
    (AggRow & {
      sessionId: string
      folio: string
      status: string
      operatedAt: Date
      businessDate: Date
      closedAt: Date | null
      debts: bigint
      players: bigint
      snapshotOutstanding: string | null
      total: bigint
    })[]
  >`
    ${debtsCte(f)}
    SELECT debts."sessionId", s."folio", s."status"::text AS "status",
      COALESCE(s."openedAt", s."createdAt") AS "operatedAt", s."businessDate", s."closedAt",
      ${AGG},
      COUNT(*) AS "debts",
      COUNT(DISTINCT debts."playerId") AS "players",
      MAX(cr."content" -> 'credits' ->> 'outstanding') AS "snapshotOutstanding",
      COUNT(*) OVER () AS "total"
    FROM debts
    JOIN "poker_sessions" s ON s."id" = debts."sessionId"
    LEFT JOIN "closure_reports" cr ON cr."sessionId" = s."id"
    GROUP BY debts."sessionId", s."folio", s."status", s."openedAt", s."createdAt", s."businessDate", s."closedAt"
    ORDER BY s."businessDate" ASC, "operatedAt" ASC, debts."sessionId" ASC
    LIMIT ${f.pageSize} OFFSET ${offset}
  `
  return {
    page: f.page,
    pageSize: f.pageSize,
    total: rows.length ? Number(rows[0].total) : 0,
    items: rows.map((r) => ({
      session: {
        id: r.sessionId,
        folio: r.folio,
        status: r.status,
        operatedAt: r.operatedAt.toISOString(),
        operatedDay: r.businessDate.toISOString().slice(0, 10),
        closedAt: r.closedAt?.toISOString() ?? null,
      },
      ...aggView(r),
      debts: Number(r.debts),
      players: Number(r.players),
      /** Deuda registrada en el comprobante de cierre (si existe). Histórica. */
      closureSnapshotOutstanding:
        r.snapshotOutstanding !== null ? fmt(dec(r.snapshotOutstanding)) : null,
    })),
  }
}

// ── Estado de cuenta de un jugador (3 niveles) ────────────────────────

export async function getPlayerCreditReport(
  playerId: string,
  f: ReportFilters,
  db: Db = prisma
) {
  const player = await db.player.findUnique({
    where: { id: playerId },
    select: { id: true, name: true, nickname: true, isActive: true },
  })
  if (!player) throw new NotFoundError("Jugador no encontrado")
  const tree = await getCreditTree({ ...f, playerId }, db)
  const node: PlayerNode | null = tree[0] ?? null
  const [pending, unapplied] = await Promise.all([
    db.bankTransferVerification.aggregate({
      where: {
        playerId,
        kind: "PLAYER_PAYMENT",
        status: "PENDING_VERIFICATION",
      },
      _sum: { declaredAmount: true },
      _count: true,
    }),
    db.unappliedPlayerFunds.aggregate({
      where: { playerId, status: "PENDING_RESOLUTION" },
      _sum: { amount: true },
    }),
  ])
  return {
    player,
    totals: node
      ? {
          original: node.original,
          paymentsApplied: node.paymentsApplied,
          payments: node.payments,
          linkedPayments: node.linkedPayments,
          offsets: node.offsets,
          reversals: node.reversals,
          balance: node.balance,
          sessionsWithBalance: node.sessionsWithBalance,
          debtsCount: node.debtsCount,
          oldestOpenDebtAt: node.oldestOpenDebtAt,
          lastMovementAt: node.lastMovementAt,
        }
      : {
          original: "0.00",
          paymentsApplied: "0.00",
          payments: "0.00",
          linkedPayments: "0.00",
          offsets: "0.00",
          reversals: "0.00",
          balance: "0.00",
          sessionsWithBalance: 0,
          debtsCount: 0,
          oldestOpenDebtAt: null,
          lastMovementAt: null,
        },
    /** Transferencias declaradas sin verificar: NO reducen la deuda. */
    pendingTransfers: {
      count: pending._count,
      amount: fmt(dec(pending._sum.declaredAmount)),
    },
    /** Dinero recibido sin aplicar (por devolver): NO es saldo a favor. */
    unappliedFunds: fmt(dec(unapplied._sum.amount)),
    sessions: node?.sessions ?? [],
  }
}

export async function getPlayerSessionCredit(
  playerId: string,
  sessionId: string,
  f: ReportFilters,
  db: Db = prisma
) {
  const report = await getPlayerCreditReport(playerId, { ...f, sessionId }, db)
  const session = report.sessions.find((s) => s.session.id === sessionId)
  if (!session)
    throw new NotFoundError("El jugador no tiene obligaciones en esa sesión")
  return { player: report.player, session }
}

// ── Abonos y sus aplicaciones ─────────────────────────────────────────

export function paymentWhere(
  f: ReportFilters
): Prisma.ReceivablePaymentWhereInput {
  const paidAt = businessRange(f.paymentFrom ?? f.from, f.paymentTo ?? f.to)
  return {
    ...(f.playerId && { playerId: f.playerId }),
    ...(f.method && { method: f.method }),
    ...(f.status && { status: f.status as never }),
    ...(f.operatorId && { createdById: f.operatorId }),
    ...(paidAt && {
      OR: [{ confirmedAt: paidAt }, { confirmedAt: null, createdAt: paidAt }],
    }),
    // Sesión: la de COBRO o la de ORIGEN de alguna deuda afectada.
    ...(f.sessionId && {
      AND: [
        {
          OR: [
            { sessionId: f.sessionId },
            {
              allocations: { some: { receivable: { sessionId: f.sessionId } } },
            },
          ],
        },
      ],
    }),
  }
}

const paymentSelect = {
  id: true,
  folio: true,
  amount: true,
  method: true,
  origin: true,
  status: true,
  createdAt: true,
  confirmedAt: true,
  reversedAt: true,
  externalReference: true,
  terminalReference: true,
  player: { select: { id: true, name: true } },
  session: { select: { id: true, folio: true } },
  createdBy: { select: { id: true, name: true } },
  financialTransaction: { select: { folio: true } },
  bankTransfer: { select: { bankReference: true, status: true } },
  unappliedFunds: { select: { amount: true } },
  allocations: {
    orderBy: [{ allocatedAt: "asc" }, { allocationOrder: "asc" }],
    select: {
      id: true,
      kind: true,
      amount: true,
      allocationOrder: true,
      allocatedAt: true,
      receivable: {
        select: {
          id: true,
          createdAt: true,
          session: { select: { id: true, folio: true } },
          purchase: {
            select: {
              id: true,
              folio: true,
              purchaseType: true,
              rebuyNumber: true,
              table: { select: { name: true } },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.ReceivablePaymentSelect

type PaymentRow = Prisma.ReceivablePaymentGetPayload<{
  select: typeof paymentSelect
}>

function paymentRowView(p: PaymentRow) {
  const applied = p.allocations.reduce(
    (acc, a) =>
      a.kind === "APPLICATION" ? acc.add(a.amount) : acc.sub(a.amount),
    ZERO
  )
  return {
    id: p.id,
    folio: p.folio,
    player: p.player,
    /** Fecha REAL del pago (confirmación); nunca la de la sesión de la deuda. */
    paidAt: (p.confirmedAt ?? p.createdAt).toISOString(),
    method: p.method,
    origin: p.origin,
    collectedInSession: p.session,
    /** Importe del PAGO (se suma una sola vez). */
    amount: fmt(dec(p.amount)),
    /** Importe APLICADO neto (suma de sus aplicaciones). */
    applied: fmt(applied),
    unapplied: fmt(
      p.unappliedFunds.reduce((acc, u) => acc.add(u.amount), ZERO)
    ),
    status: p.status,
    reversedAt: p.reversedAt?.toISOString() ?? null,
    operator: p.createdBy,
    financialFolio: p.financialTransaction?.folio ?? null,
    reference:
      p.bankTransfer?.bankReference ??
      p.terminalReference ??
      p.externalReference ??
      null,
    affectedSessions: [
      ...new Map(
        p.allocations.map((a) => [
          a.receivable.session.id,
          a.receivable.session,
        ])
      ).values(),
    ],
    allocations: p.allocations.map((a) => ({
      id: a.id,
      kind: a.kind,
      amount: fmt(dec(a.amount)),
      order: a.allocationOrder,
      appliedAt: a.allocatedAt.toISOString(),
      debtId: a.receivable.id,
      debtCreatedAt: a.receivable.createdAt.toISOString(),
      originSession: a.receivable.session,
      purchase: {
        id: a.receivable.purchase.id,
        folio: a.receivable.purchase.folio,
        type: a.receivable.purchase.purchaseType,
        rebuyNumber: a.receivable.purchase.rebuyNumber,
        table: a.receivable.purchase.table.name,
      },
    })),
  }
}

export type PaymentReportRow = ReturnType<typeof paymentRowView>

/** Abonos (paginado) con sus aplicaciones anidadas: un renglón por abono. */
export async function listCreditPayments(f: ReportFilters, db: Db = prisma) {
  const where = paymentWhere(f)
  const [total, rows, all] = await Promise.all([
    db.receivablePayment.count({ where }),
    db.receivablePayment.findMany({
      where,
      select: paymentSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (f.page - 1) * f.pageSize,
      take: f.pageSize,
    }),
    db.receivablePayment.findMany({
      where,
      select: {
        id: true,
        amount: true,
        status: true,
        unappliedFunds: { select: { amount: true } },
        allocations: { select: { kind: true, amount: true } },
      },
    }),
  ])
  return {
    page: f.page,
    pageSize: f.pageSize,
    total,
    totals: paymentTotals(
      all.map((p) => ({
        id: p.id,
        amount: dec(p.amount),
        status: p.status,
        unapplied: p.unappliedFunds.reduce((acc, u) => acc.add(u.amount), ZERO),
        allocations: p.allocations.map((a) => ({
          kind: a.kind,
          amount: dec(a.amount),
        })),
      }))
    ),
    items: rows.map(paymentRowView),
  }
}

/** Todos los abonos de los filtros (exportación). */
export async function listAllCreditPayments(f: ReportFilters, db: Db = prisma) {
  const where = paymentWhere(f)
  const count = await db.receivablePayment.count({ where })
  if (count > MAX_DETAIL_ROWS)
    throw new ValidationError(
      `La consulta abarca ${count} abonos (máximo ${MAX_DETAIL_ROWS}). Acota los filtros.`
    )
  const rows = await db.receivablePayment.findMany({
    where,
    select: paymentSelect,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })
  return rows.map(paymentRowView)
}

// ── Compensaciones con fichas (Módulo 11) ─────────────────────────────

/**
 * Compensaciones registradas en liquidaciones: decisión, importe y deudas
 * afectadas con su sesión de origen. NO son abonos de efectivo ni ingresos
 * bancarios, y nunca se netean contra cuentas por pagar.
 */
export async function listSettlementOffsets(f: ReportFilters, db: Db = prisma) {
  const allocs = await db.paymentAllocation.findMany({
    where: {
      source: "CHIP_SETTLEMENT_OFFSET",
      ...(f.playerId && { playerId: f.playerId }),
      ...(f.sessionId && {
        OR: [
          { settlement: { sessionId: f.sessionId } },
          { receivable: { sessionId: f.sessionId } },
        ],
      }),
    },
    orderBy: [{ allocatedAt: "asc" }, { id: "asc" }],
    take: MAX_DETAIL_ROWS,
    select: {
      id: true,
      kind: true,
      amount: true,
      allocatedAt: true,
      settlement: {
        select: {
          id: true,
          folio: true,
          offsetDecision: true,
          offsetAmount: true,
          returnedNominalAmount: true,
          debtBalanceSnapshot: true,
          session: { select: { id: true, folio: true } },
        },
      },
      receivable: {
        select: {
          id: true,
          session: { select: { id: true, folio: true } },
          purchase: { select: { folio: true } },
        },
      },
      player: { select: { id: true, name: true } },
    },
  })
  return allocs.map((a) => ({
    id: a.id,
    kind: a.kind,
    amount: fmt(dec(a.amount)),
    appliedAt: a.allocatedAt.toISOString(),
    player: a.player,
    settlement: a.settlement
      ? {
          id: a.settlement.id,
          folio: a.settlement.folio,
          decision: a.settlement.offsetDecision,
          offsetAmount: fmt(dec(a.settlement.offsetAmount)),
          returnedNominal: fmt(dec(a.settlement.returnedNominalAmount)),
          debtBefore:
            a.settlement.debtBalanceSnapshot !== null
              ? fmt(dec(a.settlement.debtBalanceSnapshot))
              : null,
          debtAfter:
            a.settlement.debtBalanceSnapshot !== null
              ? fmt(
                  dec(a.settlement.debtBalanceSnapshot).sub(
                    dec(a.settlement.offsetAmount)
                  )
                )
              : null,
          session: a.settlement.session,
        }
      : null,
    originSession: a.receivable.session,
    purchaseFolio: a.receivable.purchase.folio,
  }))
}

/** Opciones de filtros de créditos (socios autorizadores reales). */
export async function creditFilterOptions(db: Db = prisma) {
  const partners = await db.purchaseCreditAuthorization.findMany({
    where: { debt: { isNot: null } },
    distinct: ["authorizedByPartnerId"],
    select: { authorizedByPartnerId: true, partnerNameSnapshot: true },
    orderBy: { partnerNameSnapshot: "asc" },
  })
  return {
    partners: partners.map((p) => ({
      id: p.authorizedByPartnerId,
      name: p.partnerNameSnapshot,
    })),
  }
}

export { creditTotals }
