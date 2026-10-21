import "server-only"

import { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import type { ReportFilters } from "@/modules/reports/report.filters"
import { dec, fmt } from "@/modules/reports/report.math"

/**
 * Estadísticas por jugador (Módulo 14). El «balance nominal observado»
 * (comprado − devuelto en liquidaciones) NO es la utilidad real del
 * jugador: entre jugadores pueden cambiar de manos fichas sin registro. La
 * deuda global se deriva del libro de aplicaciones; el desglose por sesión
 * vive en el reporte de créditos.
 */

type Db = Prisma.TransactionClient | typeof prisma

type StatRow = {
  playerId: string
  name: string
  isActive: boolean
  sessions: bigint
  tables: bigint
  initialCount: bigint
  rebuyCount: bigint
  bought: string
  returned: string
  credits: string
  payments: string
  offsets: string
  debt: string
  settlements: bigint
  payablePending: string
  lastParticipation: Date | null
  total: bigint
}

export async function listPlayerStats(f: ReportFilters, db: Db = prisma) {
  const offset = (f.page - 1) * f.pageSize
  const playerCond = f.playerId
    ? Prisma.sql`p."id" = ${f.playerId}`
    : Prisma.sql`TRUE`
  const sessionCond = f.sessionId
    ? Prisma.sql`AND "sessionId" = ${f.sessionId}`
    : Prisma.empty
  const rows = await db.$queryRaw<StatRow[]>`
    WITH part AS (
      SELECT tp."playerId", COUNT(DISTINCT tp."sessionId") AS "sessions",
        COUNT(DISTINCT st."tableId") AS "tables", MAX(tp."joinedAt") AS "last"
      FROM "table_participations" tp JOIN "session_tables" st ON st."id" = tp."sessionTableId"
      WHERE TRUE ${f.sessionId ? Prisma.sql`AND tp."sessionId" = ${f.sessionId}` : Prisma.empty}
      GROUP BY tp."playerId"
    ), buys AS (
      SELECT "playerId",
        COUNT(*) FILTER (WHERE "purchaseType" = 'INITIAL_PURCHASE') AS "initialCount",
        COUNT(*) FILTER (WHERE "purchaseType" = 'REBUY') AS "rebuyCount",
        SUM("nominalAmount") AS "bought"
      FROM "chip_purchases" WHERE "status" IN ('CONFIRMED', 'REVERSED') ${sessionCond}
      GROUP BY "playerId"
    ), sett AS (
      SELECT "playerId", COUNT(*) AS "settlements", SUM("returnedNominalAmount") AS "returned"
      FROM "player_settlements" WHERE "status" IN ('PENDING_PAYOUT', 'COMPLETED') ${sessionCond}
      GROUP BY "playerId"
    ), debts AS (
      SELECT d."playerId", SUM(d."originalAmount") AS "credits",
        SUM(d."originalAmount" - COALESCE(a."applied", 0)) AS "debt",
        SUM(COALESCE(a."offsets", 0)) AS "offsets"
      FROM "player_debts" d
      LEFT JOIN (
        SELECT "receivableId",
          SUM(CASE WHEN "kind" = 'APPLICATION' THEN "amount" ELSE -"amount" END) AS "applied",
          SUM(CASE WHEN "source" = 'CHIP_SETTLEMENT_OFFSET' THEN (CASE WHEN "kind" = 'APPLICATION' THEN "amount" ELSE -"amount" END) ELSE 0 END) AS "offsets"
        FROM "payment_allocations" GROUP BY "receivableId"
      ) a ON a."receivableId" = d."id"
      WHERE TRUE ${f.sessionId ? Prisma.sql`AND d."sessionId" = ${f.sessionId}` : Prisma.empty}
      GROUP BY d."playerId"
    ), pays AS (
      SELECT "playerId", SUM("amount") AS "payments"
      FROM "receivable_payments" WHERE "status" = 'CONFIRMED'
      GROUP BY "playerId"
    ), payables AS (
      SELECT sp."playerId", SUM(sp."originalAmount" - COALESCE(x."executed", 0)) AS "pending"
      FROM "settlement_payables" sp
      LEFT JOIN (
        SELECT "payableId", SUM("amount") FILTER (WHERE "status" = 'EXECUTED') AS "executed"
        FROM "settlement_payouts" GROUP BY "payableId"
      ) x ON x."payableId" = sp."id"
      WHERE sp."status" <> 'VOIDED'
      GROUP BY sp."playerId"
    )
    SELECT p."id" AS "playerId", p."name", p."isActive",
      COALESCE(part."sessions", 0) AS "sessions", COALESCE(part."tables", 0) AS "tables",
      COALESCE(buys."initialCount", 0) AS "initialCount", COALESCE(buys."rebuyCount", 0) AS "rebuyCount",
      COALESCE(buys."bought", 0)::text AS "bought", COALESCE(sett."returned", 0)::text AS "returned",
      COALESCE(debts."credits", 0)::text AS "credits", COALESCE(pays."payments", 0)::text AS "payments",
      COALESCE(debts."offsets", 0)::text AS "offsets", COALESCE(debts."debt", 0)::text AS "debt",
      COALESCE(sett."settlements", 0) AS "settlements",
      COALESCE(payables."pending", 0)::text AS "payablePending",
      part."last" AS "lastParticipation",
      COUNT(*) OVER () AS "total"
    FROM "players" p
    JOIN part ON part."playerId" = p."id"
    LEFT JOIN buys ON buys."playerId" = p."id"
    LEFT JOIN sett ON sett."playerId" = p."id"
    LEFT JOIN debts ON debts."playerId" = p."id"
    LEFT JOIN pays ON pays."playerId" = p."id"
    LEFT JOIN payables ON payables."playerId" = p."id"
    WHERE ${playerCond}
    ORDER BY part."last" DESC NULLS LAST, p."name" ASC, p."id" ASC
    LIMIT ${f.pageSize} OFFSET ${offset}`
  return {
    page: f.page,
    pageSize: f.pageSize,
    total: rows.length ? Number(rows[0].total) : 0,
    note: "El balance nominal observado (comprado − devuelto) no es la utilidad real del jugador: puede haber intercambio de fichas entre jugadores sin registro.",
    items: rows.map((r) => ({
      player: { id: r.playerId, name: r.name, isActive: r.isActive },
      sessions: Number(r.sessions),
      tables: Number(r.tables),
      initialCount: Number(r.initialCount),
      rebuyCount: Number(r.rebuyCount),
      bought: fmt(dec(r.bought)),
      returned: fmt(dec(r.returned)),
      observedNominalBalance: fmt(dec(r.returned).sub(dec(r.bought))),
      credits: fmt(dec(r.credits)),
      payments: fmt(dec(r.payments)),
      offsets: fmt(dec(r.offsets)),
      debt: fmt(dec(r.debt)),
      settlements: Number(r.settlements),
      payablePending: fmt(dec(r.payablePending)),
      lastParticipation: r.lastParticipation?.toISOString() ?? null,
    })),
  }
}

export type PlayerStatRow = Awaited<
  ReturnType<typeof listPlayerStats>
>["items"][number]
