import "server-only"

import { Prisma } from "@/generated/prisma/client"
import { ValidationError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import { MAX_DETAIL_ROWS } from "@/modules/reports/credit-report.service"
import type { ReportFilters } from "@/modules/reports/report.filters"
import { summarizePayments } from "@/modules/purchases/purchase.math"
import {
  businessRange,
  dec,
  fmt,
  purchaseTypeLabel,
  ZERO,
} from "@/modules/reports/report.math"

/**
 * Compras y recompras (Módulo 14), solo por IMPORTE NOMINAL: nunca se
 * muestran denominaciones. Cada pago mixto aporta sus componentes una sola
 * vez (efectivo, transferencia verificada, terminal aprobada); una
 * transferencia pendiente NO es cobro y el crédito es la deuda originada.
 * Una compra cancelada no cuenta como entrega; los reversos se distinguen.
 */

type Db = Prisma.TransactionClient | typeof prisma

export function purchaseWhere(f: ReportFilters): Prisma.ChipPurchaseWhereInput {
  const range = businessRange(f.from, f.to)
  return {
    ...(f.sessionId && { sessionId: f.sessionId }),
    ...(f.tableId && { tableId: f.tableId }),
    ...(f.playerId && { playerId: f.playerId }),
    ...(f.status && { status: f.status as never }),
    ...(f.operatorId && {
      OR: [{ createdById: f.operatorId }, { confirmedById: f.operatorId }],
    }),
    ...(f.method && { payments: { some: { method: f.method } } }),
    ...(f.partnerId && {
      debt: { authorization: { authorizedByPartnerId: f.partnerId } },
    }),
    ...(range && {
      AND: [
        {
          OR: [{ confirmedAt: range }, { confirmedAt: null, createdAt: range }],
        },
      ],
    }),
  }
}

const purchaseSelect = {
  id: true,
  folio: true,
  status: true,
  purchaseType: true,
  sequenceNumber: true,
  rebuyNumber: true,
  nominalAmount: true,
  createdAt: true,
  confirmedAt: true,
  cancelledAt: true,
  player: { select: { id: true, name: true } },
  session: { select: { id: true, folio: true } },
  table: { select: { id: true, name: true } },
  cycle: { select: { cycleNumber: true } },
  createdBy: { select: { id: true, name: true } },
  confirmedBy: { select: { id: true, name: true } },
  payments: {
    select: {
      id: true,
      method: true,
      amount: true,
      status: true,
      bankTransfer: { select: { status: true, confirmedAmount: true } },
    },
  },
  debt: {
    select: {
      originalAmount: true,
      authorization: { select: { partnerNameSnapshot: true } },
    },
  },
  reversalRequests: { select: { id: true } },
} satisfies Prisma.ChipPurchaseSelect

type PurchaseRow = Prisma.ChipPurchaseGetPayload<{
  select: typeof purchaseSelect
}>

function purchaseRowView(p: PurchaseRow) {
  // Misma fórmula que el Módulo 08 (summarizePayments): una transferencia
  // cuenta como cobro solo cuando su verificación manual está CONFIRMADA.
  const f = summarizePayments(
    dec(p.nominalAmount),
    p.payments.map((x) => ({
      id: x.id,
      method: x.method,
      amount: dec(x.amount),
      status: x.status,
      transferStatus: x.bankTransfer?.status ?? null,
      transferConfirmedAmount: x.bankTransfer?.confirmedAmount
        ? dec(x.bankTransfer.confirmedAmount)
        : null,
    }))
  )
  const cash = f.confirmedCash
  const transfer = f.verifiedBankTransfers
  const card = f.approvedCardDebit.add(f.approvedCardCredit)
  const transferPending = f.pendingTransfers
  return {
    id: p.id,
    folio: p.folio,
    player: p.player,
    session: p.session,
    table: p.table,
    cycleNumber: p.cycle.cycleNumber,
    type: p.purchaseType,
    typeLabel: purchaseTypeLabel(p.purchaseType, p.rebuyNumber),
    rebuyNumber: p.rebuyNumber,
    nominalAmount: fmt(dec(p.nominalAmount)),
    cashConfirmed: fmt(cash),
    transferConfirmed: fmt(transfer),
    cardApproved: fmt(card),
    transferPending: fmt(transferPending),
    creditOriginated: fmt(dec(p.debt?.originalAmount)),
    creditPartner: p.debt?.authorization.partnerNameSnapshot ?? null,
    status: p.status,
    /** Entrega efectiva: CONFIRMED, o REVERSED (se entregó y después se
     *  revirtió con devolución física — Módulo 16; el reverso se ve aparte). */
    delivered: p.status === "CONFIRMED" || p.status === "REVERSED",
    reversed: p.status === "REVERSED",
    reversalRequested: p.reversalRequests.length > 0,
    at: (p.confirmedAt ?? p.createdAt).toISOString(),
    operator: p.confirmedBy ?? p.createdBy,
  }
}

export type PurchaseReportRow = ReturnType<typeof purchaseRowView>

/** Totales de los filtros con agregaciones en la base (sin cargar filas). */
export async function purchaseTotals(f: ReportFilters, db: Db = prisma) {
  const where = purchaseWhere(f)
  const delivered: Prisma.ChipPurchaseWhereInput = {
    AND: [where, { status: { in: ["CONFIRMED", "REVERSED"] } }],
  }
  const livePayment = {
    purchase: delivered,
    status: { not: "CANCELLED" },
  } as const
  const [byType, byStatus, cashAgg, cardAgg, verified, pending, credit] =
    await Promise.all([
      db.chipPurchase.groupBy({
        by: ["purchaseType"],
        where: delivered,
        _sum: { nominalAmount: true },
        _count: true,
      }),
      db.chipPurchase.groupBy({
        by: ["status"],
        where,
        _count: true,
        _sum: { nominalAmount: true },
      }),
      db.purchasePayment.aggregate({
        where: { purchase: delivered, method: "CASH", status: "CONFIRMED" },
        _sum: { amount: true },
      }),
      db.purchasePayment.aggregate({
        where: {
          purchase: delivered,
          method: { in: ["CARD_DEBIT", "CARD_CREDIT"] },
          status: "APPROVED",
        },
        _sum: { amount: true },
      }),
      db.bankTransferVerification.aggregate({
        where: { status: "CONFIRMED", purchasePayment: { is: livePayment } },
        _sum: { confirmedAmount: true },
      }),
      db.bankTransferVerification.aggregate({
        where: {
          status: "PENDING_VERIFICATION",
          purchasePayment: { is: livePayment },
        },
        _sum: { declaredAmount: true },
      }),
      db.playerDebt.aggregate({
        where: { purchase: delivered },
        _sum: { originalAmount: true },
      }),
    ])
  const initial = byType.filter((t) => t.purchaseType !== "REBUY")
  const rebuy = byType.find((t) => t.purchaseType === "REBUY")
  return {
    initialCount: initial.reduce((acc, t) => acc + t._count, 0),
    initialNominal: fmt(
      initial.reduce((acc, t) => acc.add(dec(t._sum.nominalAmount)), ZERO)
    ),
    rebuyCount: rebuy?._count ?? 0,
    rebuyNominal: fmt(dec(rebuy?._sum.nominalAmount)),
    deliveredNominal: fmt(
      byType.reduce((acc, t) => acc.add(dec(t._sum.nominalAmount)), ZERO)
    ),
    cashConfirmed: fmt(dec(cashAgg._sum.amount)),
    transferConfirmed: fmt(dec(verified._sum.confirmedAmount)),
    cardApproved: fmt(dec(cardAgg._sum.amount)),
    transferPending: fmt(dec(pending._sum.declaredAmount)),
    creditOriginated: fmt(dec(credit._sum.originalAmount)),
    byStatus: byStatus.map((s) => ({
      status: s.status,
      count: s._count,
      nominal: fmt(dec(s._sum.nominalAmount)),
    })),
  }
}

export async function listPurchaseReports(f: ReportFilters, db: Db = prisma) {
  const where = purchaseWhere(f)
  const [total, rows, totals] = await Promise.all([
    db.chipPurchase.count({ where }),
    db.chipPurchase.findMany({
      where,
      select: purchaseSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (f.page - 1) * f.pageSize,
      take: f.pageSize,
    }),
    purchaseTotals(f, db),
  ])
  return {
    page: f.page,
    pageSize: f.pageSize,
    total,
    totals,
    items: rows.map(purchaseRowView),
  }
}

export async function listAllPurchaseReports(
  f: ReportFilters,
  db: Db = prisma
) {
  const where = purchaseWhere(f)
  const count = await db.chipPurchase.count({ where })
  if (count > MAX_DETAIL_ROWS)
    throw new ValidationError(
      `La consulta abarca ${count} compras (máximo ${MAX_DETAIL_ROWS}). Acota los filtros.`
    )
  const rows = await db.chipPurchase.findMany({
    where,
    select: purchaseSelect,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })
  return rows.map(purchaseRowView)
}

// ── Liquidaciones ─────────────────────────────────────────────────────

export function settlementWhere(
  f: ReportFilters
): Prisma.PlayerSettlementWhereInput {
  const range = businessRange(f.from, f.to)
  return {
    ...(f.sessionId && { sessionId: f.sessionId }),
    ...(f.tableId && { tableId: f.tableId }),
    ...(f.playerId && { playerId: f.playerId }),
    ...(f.status && { status: f.status as never }),
    ...(f.operatorId && {
      OR: [{ createdById: f.operatorId }, { receivedById: f.operatorId }],
    }),
    ...(f.method && f.method !== "CARD_DEBIT" && f.method !== "CARD_CREDIT"
      ? { payouts: { some: { method: f.method } } }
      : {}),
    ...(range && {
      AND: [
        {
          OR: [{ receivedAt: range }, { receivedAt: null, createdAt: range }],
        },
      ],
    }),
  }
}

const settlementSelect = {
  id: true,
  folio: true,
  status: true,
  returnedNominalAmount: true,
  offsetDecision: true,
  offsetAmount: true,
  netPayoutAmount: true,
  createdAt: true,
  receivedAt: true,
  completedAt: true,
  player: { select: { id: true, name: true } },
  session: { select: { id: true, folio: true, status: true } },
  table: { select: { id: true, name: true } },
  cycle: { select: { cycleNumber: true } },
  receivedBy: { select: { id: true, name: true } },
  payable: { select: { originalAmount: true, status: true } },
  payouts: {
    orderBy: { sequence: "asc" },
    select: {
      method: true,
      amount: true,
      status: true,
      executedAt: true,
      createdAt: true,
    },
  },
} satisfies Prisma.PlayerSettlementSelect

type SettlementRow = Prisma.PlayerSettlementGetPayload<{
  select: typeof settlementSelect
}>

function settlementRowView(s: SettlementRow) {
  let cash = ZERO
  let transferExecuted = ZERO
  let transferPending = ZERO
  let lastPayoutAt: Date | null = null
  for (const p of s.payouts) {
    const v = dec(p.amount)
    if (p.status === "EXECUTED") {
      if (p.method === "CASH") cash = cash.add(v)
      else transferExecuted = transferExecuted.add(v)
      if (p.executedAt && (!lastPayoutAt || p.executedAt > lastPayoutAt))
        lastPayoutAt = p.executedAt
    } else if (p.status === "PENDING") transferPending = transferPending.add(v)
  }
  const original = dec(s.payable?.originalAmount)
  const pending = original.sub(cash).sub(transferExecuted)
  return {
    id: s.id,
    folio: s.folio,
    player: s.player,
    session: s.session,
    table: s.table,
    cycleNumber: s.cycle.cycleNumber,
    returnedNominal: fmt(dec(s.returnedNominalAmount)),
    offsetDecision: s.offsetDecision,
    offsetAmount: fmt(dec(s.offsetAmount)),
    netPayout: s.netPayoutAmount !== null ? fmt(dec(s.netPayoutAmount)) : null,
    cashPaid: fmt(cash),
    transferExecuted: fmt(transferExecuted),
    /** Transferencias solicitadas sin ejecutar: NO descuentan la obligación. */
    transferPending: fmt(transferPending),
    payablePending: fmt(
      s.payable && s.payable.status !== "VOIDED" ? pending : ZERO
    ),
    payableStatus: s.payable?.status ?? null,
    status: s.status,
    receivedAt: s.receivedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    lastPayoutAt: lastPayoutAt?.toISOString() ?? null,
    operator: s.receivedBy,
  }
}

export type SettlementReportRow = ReturnType<typeof settlementRowView>

export async function settlementTotals(f: ReportFilters, db: Db = prisma) {
  const where = settlementWhere(f)
  const received: Prisma.PlayerSettlementWhereInput = {
    AND: [where, { status: { in: ["PENDING_PAYOUT", "COMPLETED"] } }],
  }
  const [agg, payouts, payable] = await Promise.all([
    db.playerSettlement.aggregate({
      where: received,
      _sum: {
        returnedNominalAmount: true,
        offsetAmount: true,
        netPayoutAmount: true,
      },
      _count: true,
    }),
    db.settlementPayout.groupBy({
      by: ["method", "status"],
      where: { settlement: received },
      _sum: { amount: true },
    }),
    db.settlementPayable.aggregate({
      where: { settlement: received, status: { not: "VOIDED" } },
      _sum: { originalAmount: true },
    }),
  ])
  const pick = (method: string, status: string) =>
    dec(
      payouts.find((p) => p.method === method && p.status === status)?._sum
        .amount
    )
  const executed = pick("CASH", "EXECUTED").add(
    pick("BANK_TRANSFER", "EXECUTED")
  )
  return {
    count: agg._count,
    returnedNominal: fmt(dec(agg._sum.returnedNominalAmount)),
    offsets: fmt(dec(agg._sum.offsetAmount)),
    netPayout: fmt(dec(agg._sum.netPayoutAmount)),
    cashPaid: fmt(pick("CASH", "EXECUTED")),
    transferExecuted: fmt(pick("BANK_TRANSFER", "EXECUTED")),
    transferPending: fmt(pick("BANK_TRANSFER", "PENDING")),
    payablePending: fmt(dec(payable._sum.originalAmount).sub(executed)),
  }
}

export async function listSettlementReports(f: ReportFilters, db: Db = prisma) {
  const where = settlementWhere(f)
  const [total, rows, totals] = await Promise.all([
    db.playerSettlement.count({ where }),
    db.playerSettlement.findMany({
      where,
      select: settlementSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (f.page - 1) * f.pageSize,
      take: f.pageSize,
    }),
    settlementTotals(f, db),
  ])
  return {
    page: f.page,
    pageSize: f.pageSize,
    total,
    totals,
    items: rows.map(settlementRowView),
  }
}

export async function listAllSettlementReports(
  f: ReportFilters,
  db: Db = prisma
) {
  const where = settlementWhere(f)
  const count = await db.playerSettlement.count({ where })
  if (count > MAX_DETAIL_ROWS)
    throw new ValidationError(
      `La consulta abarca ${count} liquidaciones (máximo ${MAX_DETAIL_ROWS}). Acota los filtros.`
    )
  const rows = await db.playerSettlement.findMany({
    where,
    select: settlementSelect,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })
  return rows.map(settlementRowView)
}
