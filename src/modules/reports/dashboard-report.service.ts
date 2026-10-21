import "server-only"

import { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { getGlobalChipPosition } from "@/modules/closure/chip-circulation.service"
import { getCreditSummary } from "@/modules/reports/credit-report.service"
import { currentPositions } from "@/modules/reports/financial-report.service"
import { dec, fmt } from "@/modules/reports/report.math"
import { sessionMetrics } from "@/modules/reports/session-report.service"

/**
 * Dashboard general (Módulo 14). Cada indicador declara su PERIODO: «sesión
 * vigente» o «global (a la fecha)». Nunca se suman cifras de periodos
 * distintos. Una compra a crédito no es ingreso de efectivo, la circulación
 * no es utilidad y los depósitos de terminal no se suman otra vez.
 */

type Db = Prisma.TransactionClient | typeof prisma

export type Kpi = {
  id: string
  label: string
  value: string
  unit: "MXN" | "MXN nominal" | "count" | "text"
  period: "SESSION" | "GLOBAL"
  hint?: string
}

export const PERIOD_LABEL: Record<Kpi["period"], string> = {
  SESSION: "Sesión vigente",
  GLOBAL: "Global, a la fecha",
}

export async function getDashboard(db: Db = prisma) {
  const active = await db.pokerSession.findFirst({
    where: { status: { in: ["DRAFT", "PREPARATION", "OPEN", "CLOSING"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, folio: true, status: true, openedAt: true },
  })
  const [metrics, tablesOpen, activePlayers, positions, credits, chips] =
    await Promise.all([
      active ? sessionMetrics(db, [active.id]) : null,
      active
        ? db.sessionTable.count({
            where: { sessionId: active.id, status: "OPEN" },
          })
        : 0,
      active
        ? db.tableParticipation.count({
            where: { sessionId: active.id, status: "ACTIVE" },
          })
        : 0,
      currentPositions(db),
      getCreditSummary({ page: 1, pageSize: 25 }, db),
      getGlobalChipPosition(db),
    ])
  const m = active ? metrics!.get(active.id)! : null
  const cashOnHand =
    active && positions.openSession?.id === active.id
      ? positions.cashOnHand
      : null

  const session: Kpi[] = [
    {
      id: "session",
      label: "Sesión actual",
      value: active ? active.folio : "Sin sesión vigente",
      unit: "text",
      period: "SESSION",
    },
    {
      id: "session-status",
      label: "Estado de la sesión",
      value: active?.status ?? "—",
      unit: "text",
      period: "SESSION",
    },
    {
      id: "tables-open",
      label: "Mesas abiertas",
      value: String(tablesOpen),
      unit: "count",
      period: "SESSION",
    },
    {
      id: "active-players",
      label: "Jugadores activos",
      value: String(activePlayers),
      unit: "count",
      period: "SESSION",
    },
    {
      id: "initial-nominal",
      label: "Compras iniciales",
      value: m?.initialNominal ?? "0.00",
      unit: "MXN nominal",
      period: "SESSION",
      hint: `${m?.initialCount ?? 0} entregadas. Valor nominal (incluye crédito).`,
    },
    {
      id: "rebuy-nominal",
      label: "Recompras",
      value: m?.rebuyNominal ?? "0.00",
      unit: "MXN nominal",
      period: "SESSION",
      hint: `${m?.rebuyCount ?? 0} entregadas. Valor nominal (incluye crédito).`,
    },
    {
      id: "cash-on-hand",
      label: "Efectivo físico de caja",
      value: cashOnHand ?? "0.00",
      unit: "MXN",
      period: "SESSION",
      hint: cashOnHand === null ? "Sin sesión abierta o en cierre." : undefined,
    },
    {
      id: "collections",
      label: "Cobros confirmados de compras",
      value: m?.collections.total ?? "0.00",
      unit: "MXN",
      period: "SESSION",
      hint: m
        ? `Efectivo ${m.collections.cash} · transferencias verificadas ${m.collections.transferConfirmed} · terminal aprobada ${m.collections.cardApproved}. El crédito no es cobro.`
        : undefined,
    },
    {
      id: "session-credit",
      label: "Créditos originados",
      value: m?.creditsOriginated ?? "0.00",
      unit: "MXN",
      period: "SESSION",
      hint: "Deuda de jugadores; no es dinero recibido.",
    },
  ]
  const global: Kpi[] = [
    {
      id: "pending-transfers",
      label: "Transferencias pendientes de verificar",
      value: positions.pendingIncomingTransfers.amount,
      unit: "MXN",
      period: "GLOBAL",
      hint: `${positions.pendingIncomingTransfers.count} transferencia(s). No son cobro hasta verificarse.`,
    },
    {
      id: "card-pending",
      label: "Terminal pendiente de liquidar",
      value: positions.cardPendingSettlement,
      unit: "MXN",
      period: "GLOBAL",
      hint: "Cobros aprobados aún no depositados por el adquirente.",
    },
    {
      id: "receivables",
      label: "Deudas por cobrar",
      value: credits.balance,
      unit: "MXN",
      period: "GLOBAL",
      hint: `${credits.playersWithBalance} jugador(es) en ${credits.sessionsWithBalance} sesión(es) de origen.`,
    },
    {
      id: "payables",
      label: "Obligaciones por pagar",
      value: positions.payables.pending,
      unit: "MXN",
      period: "GLOBAL",
      hint: `${positions.payables.players} jugador(es). Transferencias en curso: ${positions.payables.inTransit}.`,
    },
    {
      id: "chips-custody",
      label: "Fichas bajo custodia",
      value: fmt(chips.custody),
      unit: "MXN nominal",
      period: "GLOBAL",
    },
    {
      id: "chips-circulation",
      label: "Fichas en circulación",
      value: fmt(chips.circulation),
      unit: "MXN nominal",
      period: "GLOBAL",
      hint: "Pendiente de retorno. No es faltante ni utilidad.",
    },
    {
      id: "admin-custody",
      label: "Custodia administrativa de efectivo",
      value: positions.adminCustody,
      unit: "MXN",
      period: "GLOBAL",
      hint: "Efectivo de abonos fuera de sesión; no es caja de juego.",
    },
  ]
  return {
    generatedAt: new Date().toISOString(),
    session: active
      ? {
          id: active.id,
          folio: active.folio,
          status: active.status,
          openedAt: active.openedAt?.toISOString() ?? null,
        }
      : null,
    sessionKpis: session,
    globalKpis: global,
    ledgerConsistent: chips.ledgerConsistent,
    oldestDebtAt: credits.oldestOpenDebtAt,
    hasCredit: dec(credits.balance).greaterThan(0),
  }
}

export type DashboardReport = Awaited<ReturnType<typeof getDashboard>>
