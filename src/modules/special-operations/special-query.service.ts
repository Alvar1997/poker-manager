import "server-only"

import { NotFoundError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import { displayStatus } from "@/modules/corrections/correction.rules"

import { listUnappliedFunds } from "./unapplied-funds.service"
import { payableView } from "./special-payout.service"
import { fmt, payableState, ZERO } from "./special.math"

/**
 * Consultas del Módulo 16 (solo lectura). Los saldos de cada obligación se
 * DERIVAN de sus pagos; nada se lee de un campo editable.
 */

export const REDEMPTION_STATUS_LABEL: Record<string, string> = {
  REQUESTED: "Solicitado · falta validación del socio",
  VALIDATING: "Validado · pendiente de recepción física",
  REJECTED: "Rechazado",
  PAYMENT_PENDING: "Fichas recibidas · pago pendiente",
  PARTIALLY_PAID: "Pagado parcialmente",
  PAID: "Pagado",
  CANCELLED: "Cancelado",
}

export const UNAPPLIED_STATUS_LABEL: Record<string, string> = {
  PENDING_REVIEW: "Pendiente de revisión",
  PENDING_REFUND: "Devolución pendiente",
  PARTIALLY_REFUNDED: "Devuelto parcialmente",
  REFUNDED: "Devuelto",
}

export async function listRedemptions(
  q: { status?: string; playerId?: string } = {}
) {
  const rows = await prisma.lateChipRedemption.findMany({
    where: {
      ...(q.status ? { status: q.status as never } : {}),
      ...(q.playerId ? { playerId: q.playerId } : {}),
    },
    orderBy: { requestedAt: "desc" },
    take: 200,
    include: { player: { select: { id: true, name: true } } },
  })
  return rows.map((r) => ({
    id: r.id,
    folio: r.folio,
    status: r.status,
    statusLabel: REDEMPTION_STATUS_LABEL[r.status],
    presenterName: r.presenterName,
    player: r.player,
    presented: fmt(r.presentedNominal),
    accepted: r.acceptedNominal ? fmt(r.acceptedNominal) : null,
    requestedAt: r.requestedAt.toISOString(),
  }))
}

export async function listPurchaseReversals() {
  const [done, pending] = await Promise.all([
    prisma.purchaseReversal.findMany({
      orderBy: { executedAt: "desc" },
      take: 200,
      include: {
        purchase: {
          select: {
            id: true,
            folio: true,
            player: { select: { id: true, name: true } },
            session: { select: { folio: true, status: true } },
          },
        },
      },
    }),
    prisma.correctionRequest.findMany({
      where: {
        type: "PURCHASE_REVERSAL",
        status: { in: ["REQUESTED", "UNDER_REVIEW", "APPROVED", "FAILED"] },
      },
      orderBy: { requestedAt: "desc" },
      take: 200,
      select: {
        id: true,
        folio: true,
        status: true,
        type: true,
        targetId: true,
        reason: true,
      },
    }),
  ])
  const payables = await prisma.specialPayable.findMany({
    where: { kind: "PURCHASE_REFUND", sourceId: { in: done.map((d) => d.id) } },
    include: { payouts: true },
  })
  const pMap = new Map(payables.map((p) => [p.sourceId, p]))
  return {
    executed: done.map((r) => {
      const p = pMap.get(r.id)
      const s = p ? payableState(p.originalAmount, p.payouts) : null
      return {
        id: r.id,
        folio: r.folio,
        purchase: r.purchase,
        returned: fmt(r.returnedNominal),
        extinguished: fmt(r.extinguishedAmount),
        refund: fmt(r.refundAmount),
        refundPaid: fmt(s?.executed ?? ZERO),
        refundPending: fmt(s?.pending ?? ZERO),
        executedAt: r.executedAt.toISOString(),
      }
    }),
    requests: pending.map((c) => ({
      id: c.id,
      folio: c.folio,
      status: c.status,
      statusLabel: displayStatus(c.status, c.type),
      purchaseId: c.targetId,
      reason: c.reason,
    })),
  }
}

export async function listSettlementCorrections() {
  const [done, pending] = await Promise.all([
    prisma.settlementCorrection.findMany({
      orderBy: { executedAt: "desc" },
      take: 200,
      include: {
        settlement: {
          select: {
            id: true,
            folio: true,
            player: { select: { id: true, name: true } },
            session: { select: { folio: true, status: true } },
          },
        },
      },
    }),
    prisma.correctionRequest.findMany({
      where: {
        type: "SETTLEMENT_REVERSAL_WITH_PAYOUTS",
        status: { in: ["REQUESTED", "UNDER_REVIEW", "APPROVED", "FAILED"] },
      },
      orderBy: { requestedAt: "desc" },
      take: 200,
      select: {
        id: true,
        folio: true,
        status: true,
        type: true,
        targetId: true,
        reason: true,
      },
    }),
  ])
  const payables = await prisma.specialPayable.findMany({
    where: {
      kind: "SETTLEMENT_ADJUSTMENT",
      sourceId: { in: done.map((d) => d.id) },
    },
    include: { payouts: true },
  })
  const pMap = new Map(payables.map((p) => [p.sourceId, p]))
  return {
    executed: done.map((r) => {
      const p = pMap.get(r.id)
      const s = p ? payableState(p.originalAmount, p.payouts) : null
      return {
        id: r.id,
        folio: r.folio,
        kind: r.kind,
        settlement: r.settlement,
        amount: fmt(r.amount),
        paid: fmt(s?.executed ?? ZERO),
        pending: fmt(s?.pending ?? ZERO),
        executedAt: r.executedAt.toISOString(),
      }
    }),
    requests: pending.map((c) => ({
      id: c.id,
      folio: c.folio,
      status: c.status,
      statusLabel: displayStatus(c.status, c.type),
      settlementId: c.targetId,
      reason: c.reason,
    })),
  }
}

/** Resumen general: obligaciones abiertas por tipo (saldo derivado). */
export async function getSpecialOperationsOverview() {
  const [
    payables,
    redemptions,
    unapplied,
    reversalRequests,
    correctionRequests,
  ] = await Promise.all([
    prisma.specialPayable.findMany({
      where: { status: { in: ["OPEN", "PARTIALLY_PAID"] } },
      include: { payouts: true },
    }),
    prisma.lateChipRedemption.count({
      where: { status: { in: ["REQUESTED", "VALIDATING"] } },
    }),
    listUnappliedFunds(),
    prisma.correctionRequest.count({
      where: {
        type: "PURCHASE_REVERSAL",
        status: { in: ["APPROVED", "FAILED"] },
      },
    }),
    prisma.correctionRequest.count({
      where: {
        type: "SETTLEMENT_REVERSAL_WITH_PAYOUTS",
        status: { in: ["APPROVED", "FAILED"] },
      },
    }),
  ])
  const byKind: Record<
    string,
    { count: number; pending: string; inTransit: string }
  > = {}
  for (const kind of [
    "REDEMPTION",
    "PURCHASE_REFUND",
    "SETTLEMENT_ADJUSTMENT",
    "UNAPPLIED_REFUND",
  ]) {
    const list = payables.filter((p) => p.kind === kind)
    const states = list.map((p) => payableState(p.originalAmount, p.payouts))
    byKind[kind] = {
      count: list.length,
      pending: fmt(states.reduce((a, s) => a.add(s.pending), ZERO)),
      inTransit: fmt(states.reduce((a, s) => a.add(s.inTransit), ZERO)),
    }
  }
  return {
    payablesByKind: byKind,
    redemptionsAwaiting: redemptions,
    unappliedPendingReview: unapplied.filter(
      (u) => u.status === "PENDING_REVIEW"
    ).length,
    reversalsReady: reversalRequests,
    correctionsReady: correctionRequests,
  }
}

export async function getPayable(id: string) {
  const p = await prisma.specialPayable.findUnique({
    where: { id },
    include: { payouts: { orderBy: { sequence: "asc" } } },
  })
  if (!p) throw new NotFoundError("Obligación no encontrada")
  return payableView(p)
}

/** Detalle general por id (cualquiera de los cuatro procesos). */
export async function resolveSpecialOperation(id: string) {
  const [r, pr, sc, uf] = await Promise.all([
    prisma.lateChipRedemption.findUnique({
      where: { id },
      select: { id: true },
    }),
    prisma.purchaseReversal.findUnique({ where: { id }, select: { id: true } }),
    prisma.settlementCorrection.findUnique({
      where: { id },
      select: { id: true },
    }),
    prisma.unappliedPlayerFunds.findUnique({
      where: { id },
      select: { id: true },
    }),
  ])
  if (r)
    return {
      kind: "REDEMPTION" as const,
      href: `/dashboard/operaciones-especiales/canjes/${id}`,
    }
  if (pr)
    return {
      kind: "PURCHASE_REVERSAL" as const,
      href: `/dashboard/operaciones-especiales/reversos-compras/${id}`,
    }
  if (sc)
    return {
      kind: "SETTLEMENT_CORRECTION" as const,
      href: `/dashboard/operaciones-especiales/correcciones-liquidaciones/${id}`,
    }
  if (uf)
    return {
      kind: "UNAPPLIED_REFUND" as const,
      href: `/dashboard/operaciones-especiales/fondos-no-aplicados/${id}`,
    }
  throw new NotFoundError("Operación especial no encontrada")
}
