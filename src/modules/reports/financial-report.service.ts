import "server-only"

import { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { getGlobalChipPosition } from "@/modules/closure/chip-circulation.service"
import { getCreditSummary } from "@/modules/reports/credit-report.service"
import type { ReportFilters } from "@/modules/reports/report.filters"
import {
  businessDay,
  businessRange,
  dec,
  fmt,
  ZERO,
  type Dec,
} from "@/modules/reports/report.math"
import { sessionWhere } from "@/modules/reports/session-report.service"

/**
 * Caja y finanzas (Módulo 14). Lee el libro de partida doble del Módulo 05
 * sin escribir nada. Cuatro categorías que NUNCA se suman entre sí:
 *
 *   1. MOVIMIENTOS NOMINALES  (fichas entregadas/devueltas; no son dinero)
 *   2. MOVIMIENTOS MONETARIOS (efectivo, banco, terminal, custodia)
 *   3. CUENTAS POR COBRAR     (deudas de jugadores, derivadas)
 *   4. CUENTAS POR PAGAR      (obligaciones de liquidaciones, derivadas)
 *
 * No se calcula ni se rotula ninguna «utilidad neta»: no existe una fórmula
 * contable validada (DEC-05). Los retiros de caja no son gastos; el depósito
 * de la terminal al banco es un TRASLADO (el cobro se reconoció al aprobarse).
 */

type Db = Prisma.TransactionClient | typeof prisma

export const TRANSACTION_TYPE_LABEL: Record<string, string> = {
  CASH_CONTRIBUTION: "Aportación de capital",
  CASH_WITHDRAWAL: "Retiro de efectivo",
  CASH_TRANSFER: "Traslado entre cuentas",
  BANK_TRANSFER_RECEIPT: "Transferencia recibida (verificada)",
  BANK_TRANSFER_PAYOUT: "Transferencia enviada",
  PURCHASE_PAYMENT: "Cobro de compra",
  DEBT_PAYMENT: "Abono de deuda",
  PLAYER_SETTLEMENT: "Pago de liquidación",
  REVERSAL: "Reverso",
  CASH_RECONCILIATION_ADJUSTMENT: "Ajuste de arqueo",
  CARD_TERMINAL_SETTLEMENT: "Depósito de terminal al banco (traslado)",
}

export const ACCOUNT_LABEL: Record<string, string> = {
  CASH_ON_HAND: "Efectivo de caja (por sesión)",
  BANK: "Banco (neto registrado)",
  CASH_IN_TRANSIT: "Efectivo en tránsito al banco",
  CARD_TERMINAL_CLEARING: "Terminal por liquidar",
  ADMIN_CASH_CUSTODY: "Custodia administrativa",
}

const MONEY_KINDS = Object.keys(ACCOUNT_LABEL)

type FlowRow = {
  kind: string
  type: string
  destination: string | null
  direction: "DEBIT" | "CREDIT"
  amount: string
  count: bigint
}

/** Caja central por sesión: saldo inicial, entradas y salidas reales, final. */
export async function sessionCashBooks(f: ReportFilters, db: Db = prisma) {
  const base = sessionWhere(f)
  const where: Prisma.PokerSessionWhereInput = {
    ...base,
    status: f.status ? base.status : { notIn: ["DRAFT", "CANCELLED"] },
  }
  const [total, sessions] = await Promise.all([
    db.pokerSession.count({ where }),
    db.pokerSession.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (f.page - 1) * f.pageSize,
      take: f.pageSize,
      select: {
        id: true,
        folio: true,
        status: true,
        openedAt: true,
        createdAt: true,
        closedAt: true,
        opening: { select: { openingCashAmount: true } },
      },
    }),
  ])
  const ids = sessions.map((s) => s.id)
  const rows = ids.length
    ? await db.$queryRaw<
        {
          scopeKey: string
          type: string
          destination: string | null
          direction: "DEBIT" | "CREDIT"
          amount: string
        }[]
      >`
        SELECT e."scopeKey", t."transactionType"::text AS "type",
          t."withdrawalDestination"::text AS "destination",
          e."direction"::text AS "direction", SUM(e."amount")::text AS "amount"
        FROM "cash_transaction_entries" e
        JOIN "financial_accounts" a ON a."id" = e."accountId" AND a."kind" = 'CASH_ON_HAND'
        JOIN "cash_transactions" t ON t."id" = e."transactionId"
        WHERE e."scopeKey" IN (${Prisma.join(ids)})
        GROUP BY e."scopeKey", t."transactionType", t."withdrawalDestination", e."direction"`
    : []
  return {
    page: f.page,
    pageSize: f.pageSize,
    total,
    items: sessions.map((s) => {
      const mine = rows.filter((r) => r.scopeKey === s.id)
      const sum = (pred: (r: (typeof mine)[number]) => boolean) =>
        mine.filter(pred).reduce((acc, r) => acc.add(dec(r.amount)), ZERO)
      const inflow = sum((r) => r.direction === "DEBIT")
      const outflow = sum((r) => r.direction === "CREDIT")
      const opening = dec(s.opening?.openingCashAmount)
      return {
        session: {
          id: s.id,
          folio: s.folio,
          status: s.status,
          operatedDay: businessDay(s.openedAt ?? s.createdAt),
          closedAt: s.closedAt?.toISOString() ?? null,
        },
        /** Siempre $0.00 por regla (ZERO_OPENING_BALANCE). */
        opening: fmt(opening),
        contributions: fmt(
          sum((r) => r.direction === "DEBIT" && r.type === "CASH_CONTRIBUTION")
        ),
        purchaseCollections: fmt(
          sum((r) => r.direction === "DEBIT" && r.type === "PURCHASE_PAYMENT")
        ),
        debtPayments: fmt(
          sum((r) => r.direction === "DEBIT" && r.type === "DEBT_PAYMENT")
        ),
        settlementPayouts: fmt(
          sum((r) => r.direction === "CREDIT" && r.type === "PLAYER_SETTLEMENT")
        ),
        withdrawals: fmt(
          sum(
            (r) =>
              r.direction === "CREDIT" &&
              r.type === "CASH_WITHDRAWAL" &&
              r.destination !== "SESSION_CLOSING"
          )
        ),
        closingWithdrawal: fmt(
          sum(
            (r) =>
              r.direction === "CREDIT" &&
              r.type === "CASH_WITHDRAWAL" &&
              r.destination === "SESSION_CLOSING"
          )
        ),
        otherIn: fmt(
          sum(
            (r) =>
              r.direction === "DEBIT" &&
              ![
                "CASH_CONTRIBUTION",
                "PURCHASE_PAYMENT",
                "DEBT_PAYMENT",
              ].includes(r.type)
          )
        ),
        otherOut: fmt(
          sum(
            (r) =>
              r.direction === "CREDIT" &&
              !["PLAYER_SETTLEMENT", "CASH_WITHDRAWAL"].includes(r.type)
          )
        ),
        inflow: fmt(inflow),
        outflow: fmt(outflow),
        final: fmt(opening.add(inflow).sub(outflow)),
      }
    }),
  }
}

export type SessionCashBookRow = Awaited<
  ReturnType<typeof sessionCashBooks>
>["items"][number]

/** Flujos monetarios por cuenta y tipo en el periodo (fecha real del asiento). */
export async function monetaryFlows(f: ReportFilters, db: Db = prisma) {
  const range = businessRange(f.from, f.to)
  const conds: Prisma.Sql[] = [
    Prisma.sql`a."kind"::text IN (${Prisma.join(MONEY_KINDS)})`,
  ]
  if (range?.gte) conds.push(Prisma.sql`t."confirmedAt" >= ${range.gte}`)
  if (range?.lt) conds.push(Prisma.sql`t."confirmedAt" < ${range.lt}`)
  if (f.sessionId) conds.push(Prisma.sql`t."sessionId" = ${f.sessionId}`)
  const rows = await db.$queryRaw<FlowRow[]>`
    SELECT a."kind"::text AS "kind", t."transactionType"::text AS "type",
      t."withdrawalDestination"::text AS "destination",
      e."direction"::text AS "direction", SUM(e."amount")::text AS "amount",
      COUNT(DISTINCT t."id") AS "count"
    FROM "cash_transaction_entries" e
    JOIN "financial_accounts" a ON a."id" = e."accountId"
    JOIN "cash_transactions" t ON t."id" = e."transactionId"
    WHERE ${Prisma.join(conds, " AND ")}
    GROUP BY a."kind", t."transactionType", t."withdrawalDestination", e."direction"
    ORDER BY a."kind", t."transactionType"`
  const byAccount = new Map<
    string,
    {
      kind: string
      label: string
      inflow: Dec
      outflow: Dec
      lines: {
        type: string
        label: string
        direction: "DEBIT" | "CREDIT"
        amount: string
        count: number
      }[]
    }
  >()
  for (const r of rows) {
    const acc = byAccount.get(r.kind) ?? {
      kind: r.kind,
      label: ACCOUNT_LABEL[r.kind] ?? r.kind,
      inflow: ZERO,
      outflow: ZERO,
      lines: [],
    }
    byAccount.set(r.kind, acc)
    const v = dec(r.amount)
    if (r.direction === "DEBIT") acc.inflow = acc.inflow.add(v)
    else acc.outflow = acc.outflow.add(v)
    acc.lines.push({
      type: r.type,
      label:
        r.type === "CASH_WITHDRAWAL" && r.destination === "SESSION_CLOSING"
          ? "Retiro final de cierre"
          : (TRANSACTION_TYPE_LABEL[r.type] ?? r.type),
      direction: r.direction,
      amount: fmt(v),
      count: Number(r.count),
    })
  }
  const accounts = MONEY_KINDS.filter((k) => byAccount.has(k)).map((k) => {
    const a = byAccount.get(k)!
    return {
      kind: a.kind,
      label: a.label,
      inflow: fmt(a.inflow),
      outflow: fmt(a.outflow),
      net: fmt(a.inflow.sub(a.outflow)),
      lines: a.lines,
    }
  })
  const line = (kind: string, type: string, dir: "DEBIT" | "CREDIT") =>
    dec(
      rows
        .filter(
          (r) => r.kind === kind && r.type === type && r.direction === dir
        )
        .reduce((acc, r) => acc.add(dec(r.amount)), ZERO)
    )
  return {
    accounts,
    highlights: {
      /** Transferencias de jugadores verificadas (cobro bancario real). */
      bankCollectionsConfirmed: fmt(
        line("BANK", "BANK_TRANSFER_RECEIPT", "DEBIT")
          .add(line("BANK", "PURCHASE_PAYMENT", "DEBIT"))
          .add(line("BANK", "DEBT_PAYMENT", "DEBIT"))
      ),
      /** Cobros con terminal APROBADOS (se reconocen una sola vez, al aprobar). */
      cardApproved: fmt(
        line("CARD_TERMINAL_CLEARING", "PURCHASE_PAYMENT", "DEBIT").add(
          line("CARD_TERMINAL_CLEARING", "DEBT_PAYMENT", "DEBIT")
        )
      ),
      /** Depósitos del adquirente: traslado terminal → banco (no es cobro nuevo). */
      cardSettledToBank: fmt(line("BANK", "CARD_TERMINAL_SETTLEMENT", "DEBIT")),
      bankPayouts: fmt(
        line("BANK", "BANK_TRANSFER_PAYOUT", "CREDIT").add(
          line("BANK", "PLAYER_SETTLEMENT", "CREDIT")
        )
      ),
      contributions: fmt(
        line("CASH_ON_HAND", "CASH_CONTRIBUTION", "DEBIT").add(
          line("ADMIN_CASH_CUSTODY", "CASH_CONTRIBUTION", "DEBIT")
        )
      ),
      withdrawals: fmt(line("CASH_ON_HAND", "CASH_WITHDRAWAL", "CREDIT")),
    },
  }
}

/** Saldos vigentes (proyecciones del libro) y pendientes, separados. */
export async function currentPositions(db: Db = prisma) {
  const [balances, custody, pendingIn, open, payables, inTransitPayouts] =
    await Promise.all([
      db.financialAccountBalance.findMany({
        where: { scopeKey: "GLOBAL" },
        select: { balance: true, account: { select: { kind: true } } },
      }),
      db.financialAccountBalance.aggregate({
        where: { account: { kind: "ADMIN_CASH_CUSTODY" } },
        _sum: { balance: true },
      }),
      db.bankTransferVerification.aggregate({
        where: { kind: "PLAYER_PAYMENT", status: "PENDING_VERIFICATION" },
        _sum: { declaredAmount: true },
        _count: true,
      }),
      db.pokerSession.findFirst({
        where: { status: { in: ["OPEN", "CLOSING"] } },
        select: { id: true, folio: true, status: true },
      }),
      db.$queryRaw<
        {
          original: string | null
          executed: string | null
          count: bigint
          players: bigint
        }[]
      >`
        SELECT SUM(sp."originalAmount")::text AS "original",
          SUM(COALESCE(x."executed", 0))::text AS "executed",
          COUNT(*) FILTER (WHERE sp."originalAmount" - COALESCE(x."executed", 0) > 0) AS "count",
          COUNT(DISTINCT sp."playerId") FILTER (WHERE sp."originalAmount" - COALESCE(x."executed", 0) > 0) AS "players"
        FROM "settlement_payables" sp
        LEFT JOIN (
          SELECT "payableId", SUM("amount") FILTER (WHERE "status" = 'EXECUTED') AS "executed"
          FROM "settlement_payouts" GROUP BY "payableId"
        ) x ON x."payableId" = sp."id"
        WHERE sp."status" <> 'VOIDED'`,
      db.settlementPayout.aggregate({
        where: { status: "PENDING" },
        _sum: { amount: true },
        _count: true,
      }),
    ])
  const g = (kind: string) =>
    fmt(dec(balances.find((b) => b.account.kind === kind)?.balance))
  const cash = open
    ? await db.financialAccountBalance.findFirst({
        where: { scopeKey: open.id, account: { kind: "CASH_ON_HAND" } },
        select: { balance: true },
      })
    : null
  const p = payables[0]
  // Módulo 16: obligaciones especiales (canjes, reembolsos, correcciones,
  // devoluciones). Saldo derivado de pagos EXECUTED; no son ingresos ni gastos.
  const special = await db.$queryRaw<
    {
      kind: string
      n: bigint
      original: Prisma.Decimal | null
      paid: Prisma.Decimal | null
    }[]
  >(Prisma.sql`
    SELECT p."kind"::text AS kind, COUNT(*) AS n, SUM(p."originalAmount") AS original,
      SUM(COALESCE((SELECT SUM(x."amount") FROM "special_payouts" x
        WHERE x."payableId" = p."id" AND x."status" = 'EXECUTED'), 0)) AS paid
    FROM "special_payables" p WHERE p."status" <> 'PAID' GROUP BY p."kind"`)
  return {
    specialPayables: special.map((r) => ({
      kind: r.kind,
      count: Number(r.n),
      pending: fmt(dec(r.original).sub(dec(r.paid))),
    })),
    openSession: open,
    cashOnHand: open ? fmt(dec(cash?.balance)) : null,
    bankKnownNet: g("BANK"),
    cashInTransit: g("CASH_IN_TRANSIT"),
    cardPendingSettlement: g("CARD_TERMINAL_CLEARING"),
    unappliedFunds: g("UNAPPLIED_PLAYER_FUNDS"),
    adminCustody: fmt(dec(custody._sum.balance)),
    pendingIncomingTransfers: {
      count: pendingIn._count,
      amount: fmt(dec(pendingIn._sum.declaredAmount)),
    },
    payables: {
      pending: fmt(dec(p?.original).sub(dec(p?.executed))),
      count: Number(p?.count ?? 0),
      players: Number(p?.players ?? 0),
      inTransit: fmt(dec(inTransitPayouts._sum.amount)),
      inTransitCount: inTransitPayouts._count,
    },
  }
}

/** Movimientos nominales del periodo (fichas; nunca dinero). */
export async function nominalFlows(f: ReportFilters, db: Db = prisma) {
  const range = businessRange(f.from, f.to)
  const conds: Prisma.Sql[] = [Prisma.sql`TRUE`]
  if (range?.gte) conds.push(Prisma.sql`"createdAt" >= ${range.gte}`)
  if (range?.lt) conds.push(Prisma.sql`"createdAt" < ${range.lt}`)
  if (f.sessionId) conds.push(Prisma.sql`"sessionId" = ${f.sessionId}`)
  if (f.tableId) conds.push(Prisma.sql`"tableId" = ${f.tableId}`)
  const [row] = await db.$queryRaw<
    { delivered: string; returned: string; adjustments: string }[]
  >`
    SELECT
      COALESCE(SUM(GREATEST("circulationAfter" - "circulationBefore", 0)), 0)::text AS "delivered",
      COALESCE(SUM(GREATEST("circulationBefore" - "circulationAfter", 0)), 0)::text AS "returned",
      COALESCE(SUM("custodyAfter" - "custodyBefore") FILTER (WHERE "movementType" = 'INVENTORY_ADJUSTMENT'), 0)::text AS "adjustments"
    FROM "chip_nominal_movements" WHERE ${Prisma.join(conds, " AND ")}`
  return {
    delivered: fmt(dec(row.delivered)),
    returned: fmt(dec(row.returned)),
    netNotReturned: fmt(dec(row.delivered).sub(dec(row.returned))),
    custodyAdjustments: fmt(dec(row.adjustments)),
  }
}

/** Reporte financiero completo con las cuatro categorías separadas. */
export async function getFinancialReport(f: ReportFilters, db: Db = prisma) {
  const [cashBooks, flows, positions, nominal, receivables, chips] =
    await Promise.all([
      sessionCashBooks(f, db),
      monetaryFlows(f, db),
      currentPositions(db),
      nominalFlows(f, db),
      getCreditSummary({ page: 1, pageSize: 25 }, db),
      getGlobalChipPosition(db),
    ])
  return {
    period: { from: f.from ?? null, to: f.to ?? null },
    nominal: {
      ...nominal,
      custodyNow: fmt(chips.custody),
      circulationNow: fmt(chips.circulation),
      ledgerConsistent: chips.ledgerConsistent,
    },
    monetary: { flows, positions, cashBooks },
    receivables,
    payables: positions.payables,
    note: "Las cuatro categorías se presentan por separado y no se suman. No se calcula utilidad neta: no existe una fórmula contable validada. Los retiros de caja no son gastos y los depósitos de terminal son traslados.",
  }
}
