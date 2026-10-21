import "server-only"

import { prisma } from "@/lib/prisma"
import { creditFilterOptions } from "@/modules/reports/credit-report.service"
import { businessDay } from "@/modules/reports/report.math"

/** Opciones de los selectores de filtros (catálogos reales; solo lectura). */
export async function getReportFilterOptions() {
  const [sessions, tables, players, users, credit] = await Promise.all([
    prisma.pokerSession.findMany({
      where: { status: { not: "CANCELLED" } },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { id: true, folio: true, openedAt: true, createdAt: true },
    }),
    prisma.pokerTable.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true },
    }),
    prisma.player.findMany({
      orderBy: { name: "asc" },
      take: 2_000,
      select: { id: true, name: true },
    }),
    prisma.user.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    creditFilterOptions(),
  ])
  return {
    sessions: sessions.map((s) => ({
      id: s.id,
      label: `${s.folio} · ${businessDay(s.openedAt ?? s.createdAt)}`,
    })),
    tables: tables.map((t) => ({ id: t.id, label: t.name })),
    players: players.map((p) => ({ id: p.id, label: p.name })),
    operators: users.map((u) => ({ id: u.id, label: u.name })),
    partners: credit.partners.map((p) => ({ id: p.id, label: p.name })),
  }
}

export type ReportFilterOptions = Awaited<
  ReturnType<typeof getReportFilterOptions>
>
