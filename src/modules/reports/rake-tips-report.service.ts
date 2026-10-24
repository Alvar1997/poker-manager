import "server-only"

import { prisma } from "@/lib/prisma"
import { getSessionChipReconciliation } from "@/modules/closure/chip-circulation.service"
import { getTableRake } from "@/modules/rake/rake.service"
import type { ReportFilters } from "@/modules/reports/report.filters"
import { sessionWhere } from "@/modules/reports/session-report.service"
import { getSessionTips } from "@/modules/staff-tips/tips.service"

/**
 * Reportes del Módulo 18 (SOLO LECTURA): rake por mesa, propinas por
 * empleado y consolidado nominal. Reutilizan los MISMOS servicios de las
 * pantallas (sin fórmulas duplicadas). Rake y propinas son cuentas
 * distintas; el dinero pendiente al staff no es efectivo en caja.
 */

const MAX_SESSIONS = 200

async function sessionsFor(f: ReportFilters) {
  return prisma.pokerSession.findMany({
    where: {
      ...sessionWhere({ ...f, playerId: undefined }),
      status: { not: "HISTORICAL" },
    },
    orderBy: [{ businessDate: "desc" }, { sequenceNumber: "desc" }],
    take: MAX_SESSIONS,
    select: {
      id: true,
      folio: true,
      businessDate: true,
      status: true,
      tables: { select: { tableId: true } },
    },
  })
}

export async function getRakeReport(f: ReportFilters) {
  const sessions = await sessionsFor(f)
  const cycles = []
  const movements = []
  for (const s of sessions)
    for (const t of s.tables) {
      if (f.tableId && t.tableId !== f.tableId) continue
      const r = await getTableRake(s.id, t.tableId)
      for (const c of r.cycles) {
        cycles.push({
          sessionFolio: s.folio,
          day: s.businessDate.toISOString().slice(0, 10),
          table: r.table.name,
          cycle: c.cycleNumber,
          mode: c.mode,
          registered: c.registered,
          corrected: c.corrected,
          recognized: c.recognized,
          counted: c.counted,
          difference: c.difference,
          status: c.rakeStatus,
        })
        for (const m of c.movements)
          movements.push({
            sessionFolio: s.folio,
            table: r.table.name,
            cycle: c.cycleNumber,
            kind: m.kind,
            amount: m.amount,
            cumulative: m.cumulative,
            effectiveAt: m.effectiveAt,
            recordedAt: m.recordedAt,
            recordedBy: m.recordedBy,
            reason: m.reason ?? m.notes,
          })
      }
    }
  return { cycles, movements }
}

export async function getTipsReport(f: ReportFilters) {
  const sessions = await sessionsFor(f)
  const rows = []
  for (const s of sessions) {
    const t = await getSessionTips(s.id)
    for (const r of t.staff)
      rows.push({
        sessionFolio: s.folio,
        day: s.businessDate.toISOString().slice(0, 10),
        staff: r.staff.name,
        position: r.staff.position,
        state: r.state,
        partials: r.partials,
        confirmedCount: r.confirmedCount,
        corrections: r.corrections,
        recognized: r.recognized,
      })
  }
  return { rows }
}

/** Consolidado nominal por sesión: entregado = jugadores + rake + propinas + otros + diferencia. */
export async function getNominalConsolidated(f: ReportFilters) {
  const sessions = await sessionsFor(f)
  const rows = []
  for (const s of sessions) {
    const r = await getSessionChipReconciliation(prisma, s.id)
    const lastClosingCount = await prisma.chipStockCount.findFirst({
      where: { sessionId: s.id, countType: "CLOSING", status: "CONFIRMED" },
      orderBy: { confirmedAt: "desc" },
      select: {
        expectedTotal: true,
        countedTotal: true,
        differenceTotal: true,
      },
    })
    rows.push({
      sessionFolio: s.folio,
      day: s.businessDate.toISOString().slice(0, 10),
      status: s.status,
      delivered: r.delivered.toFixed(2),
      players: r.breakdown.players.toFixed(2),
      rake: r.breakdown.rake.toFixed(2),
      tips: r.breakdown.tips.toFixed(2),
      other: r.breakdown.other.toFixed(2),
      authorizedUnrecovered: r.authorizedUnrecovered.toFixed(2),
      difference: r.difference.toFixed(2),
      reconciliation: r.status,
      physicalExpected: lastClosingCount?.expectedTotal.toFixed(2) ?? null,
      physicalCounted: lastClosingCount?.countedTotal.toFixed(2) ?? null,
      physicalDifference: lastClosingCount?.differenceTotal.toFixed(2) ?? null,
    })
  }
  return { rows }
}
