import "server-only"

import { Prisma } from "@/generated/prisma/client"
import { appConfig } from "@/config/app.config"
import { prisma } from "@/lib/prisma"
import type { ClosureReportContent } from "@/modules/closure/closure-report.content"
import type { ReportFilters } from "@/modules/reports/report.filters"
import { businessRange, dec, fmt } from "@/modules/reports/report.math"
import { listAllSessionReports } from "@/modules/reports/session-report.service"

/**
 * Comparativos históricos (Módulo 14). Cada serie declara su UNIDAD, su
 * PERIODO y su DEFINICIÓN. No hay utilidad neta ni resultados exactos por
 * mesa (con transferencias no se registra el valor trasladado).
 */

type Db = Prisma.TransactionClient | typeof prisma

export type SeriesPoint = { key: string; label: string; value: string }
export type Series = {
  id: string
  title: string
  unit: "MXN" | "MXN nominal" | "jugadores" | "compras"
  period: string
  definition: string
  points: SeriesPoint[]
}

/** Sesiones del periodo (o las últimas 12 con actividad si no hay periodo). */
async function sessionsFor(f: ReportFilters, db: Db) {
  const all = await listAllSessionReports(
    { ...f, status: f.status ?? "CLOSED" },
    db,
    f.from || f.to ? 200 : 5_000
  )
  return f.from || f.to ? all : all.slice(-12)
}

export async function getComparisons(f: ReportFilters, db: Db = prisma) {
  const sessions = await sessionsFor(f, db)
  const ids = sessions.map((s) => s.id)
  const [reports, byTable, monthly] = await Promise.all([
    db.closureReport.findMany({
      where: { sessionId: { in: ids } },
      select: { sessionId: true, content: true },
    }),
    ids.length
      ? db.$queryRaw<{ sessionId: string; table: string; nominal: string }[]>`
          SELECT pu."sessionId", t."name" AS "table", SUM(pu."nominalAmount")::text AS "nominal"
          FROM "chip_purchases" pu JOIN "poker_tables" t ON t."id" = pu."tableId"
          WHERE pu."status" = 'CONFIRMED' AND pu."sessionId" IN (${Prisma.join(ids)})
          GROUP BY pu."sessionId", t."name" ORDER BY t."name"`
      : [],
    monthlyMoney(f, db),
  ])
  const snapshot = new Map(
    reports.map((r) => [r.sessionId, r.content as ClosureReportContent])
  )
  const label = (s: (typeof sessions)[number]) =>
    `${s.folio} · ${s.operatedDay}`
  const per = (
    pick: (s: (typeof sessions)[number]) => string | null | undefined
  ): SeriesPoint[] =>
    sessions.map((s) => ({
      key: s.id,
      label: label(s),
      value: fmt(dec(pick(s) ?? 0)),
    }))
  const periodLabel =
    f.from || f.to
      ? `Sesiones del ${f.from ?? "inicio"} al ${f.to ?? "hoy"}`
      : "Últimas 12 sesiones cerradas"

  const tables = [...new Set(byTable.map((r) => r.table))]
  const series: Series[] = [
    {
      id: "initial",
      title: "Compras iniciales por sesión",
      unit: "MXN nominal",
      period: periodLabel,
      definition:
        "Valor nominal de compras iniciales confirmadas (entregadas).",
      points: per((s) => s.metrics.initialNominal),
    },
    {
      id: "rebuys",
      title: "Recompras por sesión",
      unit: "MXN nominal",
      period: periodLabel,
      definition: "Valor nominal de recompras confirmadas (entregadas).",
      points: per((s) => s.metrics.rebuyNominal),
    },
    {
      id: "players",
      title: "Jugadores distintos por sesión",
      unit: "jugadores",
      period: periodLabel,
      definition: "Jugadores con al menos una participación en la sesión.",
      points: sessions.map((s) => ({
        key: s.id,
        label: label(s),
        value: String(s.metrics.players),
      })),
    },
    {
      id: "credit-at-close",
      title: "Créditos pendientes al cierre",
      unit: "MXN",
      period: periodLabel,
      definition:
        "Deuda originada en la sesión pendiente al cerrarla (comprobante inmutable).",
      points: per((s) => snapshot.get(s.id)?.credits.outstanding),
    },
    {
      id: "credit-now",
      title: "Créditos pendientes hoy (originados en cada sesión)",
      unit: "MXN",
      period: periodLabel,
      definition:
        "Saldo actual de las deudas nacidas en cada sesión (libro vigente de aplicaciones).",
      points: per((s) => s.metrics.creditsOutstandingNow),
    },
    {
      id: "payables-now",
      title: "Obligaciones por pagar hoy (originadas en cada sesión)",
      unit: "MXN",
      period: periodLabel,
      definition:
        "Cuentas por pagar de liquidaciones aún no pagadas (original − pagos ejecutados).",
      points: per((s) => s.metrics.payables.pending),
    },
    {
      id: "circulation",
      title: "Fichas globales en circulación al cierre",
      unit: "MXN nominal",
      period: periodLabel,
      definition:
        "Circulación global registrada en el comprobante de cierre. No es faltante ni utilidad.",
      points: per((s) => snapshot.get(s.id)?.inventory.globalCirculation),
    },
    {
      id: "differences",
      title: "Diferencias de arqueo de fichas al cierre",
      unit: "MXN nominal",
      period: periodLabel,
      definition: "Contado − esperado bajo custodia en el arqueo final.",
      points: per((s) => snapshot.get(s.id)?.inventory.physicalDifference),
    },
    ...tables.map((t): Series => ({
      id: `table-${t}`,
      title: `Actividad de la mesa ${t}`,
      unit: "MXN nominal",
      period: periodLabel,
      definition:
        "Valor nominal entregado en compras originadas en la mesa. No es resultado de la mesa.",
      points: sessions.map((s) => ({
        key: s.id,
        label: label(s),
        value: fmt(
          dec(
            byTable.find((r) => r.sessionId === s.id && r.table === t)?.nominal
          )
        ),
      })),
    })),
    ...monthly,
  ]
  return {
    period: periodLabel,
    sessions: sessions.map((s) => ({
      id: s.id,
      folio: s.folio,
      day: s.operatedDay,
    })),
    series,
    note: "No se declara utilidad neta ni ganancias por mesa. Cada serie indica unidad, periodo y definición.",
  }
}

/** Cobros confirmados y pagos ejecutados por MES (fecha real del asiento). */
async function monthlyMoney(f: ReportFilters, db: Db): Promise<Series[]> {
  const range = businessRange(f.from, f.to)
  const since = range?.gte ?? new Date(Date.now() - 365 * 24 * 3600 * 1000)
  const until = range?.lt ?? new Date(Date.now() + 24 * 3600 * 1000)
  const tz = appConfig.timezone
  const rows = await db.$queryRaw<
    { month: string; collections: string; payouts: string }[]
  >`
    SELECT to_char(date_trunc('month', t."confirmedAt" AT TIME ZONE ${tz}), 'YYYY-MM') AS "month",
      COALESCE(SUM(e."amount") FILTER (WHERE e."direction" = 'DEBIT' AND t."transactionType" IN ('PURCHASE_PAYMENT', 'DEBT_PAYMENT', 'BANK_TRANSFER_RECEIPT')), 0)::text AS "collections",
      COALESCE(SUM(e."amount") FILTER (WHERE e."direction" = 'CREDIT' AND t."transactionType" IN ('PLAYER_SETTLEMENT', 'BANK_TRANSFER_PAYOUT')), 0)::text AS "payouts"
    FROM "cash_transaction_entries" e
    JOIN "financial_accounts" a ON a."id" = e."accountId" AND a."isMoney" = TRUE
    JOIN "cash_transactions" t ON t."id" = e."transactionId"
    WHERE t."confirmedAt" >= ${since} AND t."confirmedAt" < ${until}
      AND t."transactionType" <> 'REVERSAL'
      AND NOT EXISTS (SELECT 1 FROM "cash_transactions" r WHERE r."reversesTransactionId" = t."id")
    GROUP BY 1 ORDER BY 1`
  const period =
    f.from || f.to
      ? `Meses del ${f.from ?? "inicio"} al ${f.to ?? "hoy"}`
      : "Últimos 12 meses"
  return [
    {
      id: "collections-month",
      title: "Cobros confirmados por mes",
      unit: "MXN",
      period,
      definition:
        "Dinero real recibido (efectivo, transferencias verificadas y terminal aprobada) por compras y abonos. Excluye créditos, transferencias pendientes, reversos y depósitos de terminal (traslados).",
      points: rows.map((r) => ({
        key: r.month,
        label: r.month,
        value: fmt(dec(r.collections)),
      })),
    },
    {
      id: "payouts-month",
      title: "Pagos a jugadores ejecutados por mes",
      unit: "MXN",
      period,
      definition:
        "Desembolsos de liquidaciones ejecutados (efectivo entregado y transferencias ejecutadas).",
      points: rows.map((r) => ({
        key: r.month,
        label: r.month,
        value: fmt(dec(r.payouts)),
      })),
    },
  ]
}
