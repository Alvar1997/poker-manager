import "server-only"

import { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { getGlobalChipPosition } from "@/modules/closure/chip-circulation.service"
import { nominalFlows } from "@/modules/reports/financial-report.service"
import type { ReportFilters } from "@/modules/reports/report.filters"
import {
  businessDay,
  businessRange,
  dec,
  fmt,
} from "@/modules/reports/report.math"

/**
 * Inventario y fichas en circulación (Módulo 14). Tres conceptos que nunca
 * se confunden:
 *   - FALTANTE FÍSICO de arqueo: contado − esperado bajo custodia;
 *   - fichas NO RETORNADAS: valor nominal pendiente de retorno (no es
 *     faltante, ni ingreso, ni utilidad);
 *   - UTILIDAD: no se calcula (DEC-05).
 * La composición por denominación solo es VERIFICADA en un arqueo
 * confirmado; entre arqueos no se presenta como dato verificado. No se
 * afirma quién conserva físicamente las fichas.
 */

type Db = Prisma.TransactionClient | typeof prisma

const countSelect = {
  id: true,
  countType: true,
  status: true,
  reconciliationStatus: true,
  expectedTotal: true,
  countedTotal: true,
  differenceTotal: true,
  confirmedAt: true,
  reconciledAt: true,
  sessionId: true,
  countedBy: { select: { name: true } },
  confirmedBy: { select: { name: true } },
} satisfies Prisma.ChipStockCountSelect

type CountRow = Prisma.ChipStockCountGetPayload<{ select: typeof countSelect }>

const countView = (c: CountRow, folios: Map<string, string>) => ({
  id: c.id,
  type: c.countType,
  reconciliationStatus: c.reconciliationStatus,
  expected: fmt(dec(c.expectedTotal)),
  counted: fmt(dec(c.countedTotal)),
  difference: fmt(dec(c.differenceTotal)),
  confirmedAt: c.confirmedAt?.toISOString() ?? null,
  sessionFolio: c.sessionId ? (folios.get(c.sessionId) ?? null) : null,
  countedBy: c.countedBy?.name ?? null,
  confirmedBy: c.confirmedBy?.name ?? null,
})

export async function getChipReport(f: ReportFilters, db: Db = prisma) {
  const range = businessRange(f.from, f.to)
  const countWhere: Prisma.ChipStockCountWhereInput = {
    status: "CONFIRMED",
    ...(range && { confirmedAt: range }),
    ...(f.sessionId && { sessionId: f.sessionId }),
  }
  const [position, last, counts, countsTotal, flows, adjustments, perSession] =
    await Promise.all([
      getGlobalChipPosition(db),
      db.chipStockCount.findFirst({
        where: { status: "CONFIRMED" },
        orderBy: [{ confirmedAt: "desc" }, { id: "desc" }],
        select: {
          ...countSelect,
          details: {
            orderBy: { unitValue: "asc" },
            select: {
              unitValue: true,
              expectedQuantity: true,
              countedQuantity: true,
              differenceQuantity: true,
              denomination: { select: { name: true, color: true } },
            },
          },
        },
      }),
      db.chipStockCount.findMany({
        where: countWhere,
        orderBy: [{ confirmedAt: "desc" }, { id: "desc" }],
        skip: (f.page - 1) * f.pageSize,
        take: f.pageSize,
        select: countSelect,
      }),
      db.chipStockCount.count({ where: countWhere }),
      nominalFlows(f, db),
      db.$queryRaw<
        {
          id: string
          type: string
          reason: string | null
          createdAt: Date
          amount: string
          sessionId: string | null
          createdBy: string | null
          closureAuthorizedBy: string | null
        }[]
      >`
        SELECT o."id", o."type"::text AS "type", o."reason", o."createdAt",
          SUM(m."custodyAfter" - m."custodyBefore")::text AS "amount",
          o."sessionId", u."name" AS "createdBy", au."name" AS "closureAuthorizedBy"
        FROM "chip_inventory_operations" o
        JOIN "chip_nominal_movements" m ON m."operationId" = o."id"
        LEFT JOIN "users" u ON u."id" = o."createdById"
        LEFT JOIN "closure_adjustment_authorizations" ca ON ca."chipOperationId" = o."id"
        LEFT JOIN "users" au ON au."id" = ca."authorizedById"
        WHERE o."type" IN ('INVENTORY_ADJUSTMENT', 'COUNT_RECONCILIATION')
          ${range?.gte ? Prisma.sql`AND o."createdAt" >= ${range.gte}` : Prisma.empty}
          ${range?.lt ? Prisma.sql`AND o."createdAt" < ${range.lt}` : Prisma.empty}
          ${f.sessionId ? Prisma.sql`AND o."sessionId" = ${f.sessionId}` : Prisma.empty}
        GROUP BY o."id", u."name", au."name"
        ORDER BY o."createdAt" DESC
        LIMIT 200`,
      db.$queryRaw<
        {
          sessionId: string
          folio: string
          status: string
          operatedAt: Date
          delivered: string
          returned: string
        }[]
      >`
        SELECT m."sessionId", s."folio", s."status"::text AS "status",
          COALESCE(s."openedAt", s."createdAt") AS "operatedAt",
          COALESCE(SUM(GREATEST(m."circulationAfter" - m."circulationBefore", 0)), 0)::text AS "delivered",
          COALESCE(SUM(GREATEST(m."circulationBefore" - m."circulationAfter", 0)), 0)::text AS "returned"
        FROM "chip_nominal_movements" m JOIN "poker_sessions" s ON s."id" = m."sessionId"
        WHERE TRUE
          ${range?.gte ? Prisma.sql`AND COALESCE(s."openedAt", s."createdAt") >= ${range.gte}` : Prisma.empty}
          ${range?.lt ? Prisma.sql`AND COALESCE(s."openedAt", s."createdAt") < ${range.lt}` : Prisma.empty}
          ${f.sessionId ? Prisma.sql`AND m."sessionId" = ${f.sessionId}` : Prisma.empty}
        GROUP BY m."sessionId", s."folio", s."status", s."openedAt", s."createdAt"
        ORDER BY "operatedAt" DESC
        LIMIT 200`,
    ])
  const sessionIds = [
    ...new Set(
      [last, ...counts]
        .map((c) => c?.sessionId)
        .filter((v): v is string => Boolean(v))
    ),
  ]
  const folios = new Map(
    (
      await db.pokerSession.findMany({
        where: { id: { in: sessionIds } },
        select: { id: true, folio: true },
      })
    ).map((s) => [s.id, s.folio])
  )
  return {
    position: {
      custody: fmt(position.custody),
      reserved: fmt(position.reserved),
      circulation: fmt(position.circulation),
      ledgerConsistent: position.ledgerConsistent,
    },
    lastCount: last
      ? {
          ...countView(last, folios),
          /** Composición VERIFICADA solo en la fecha de este arqueo. */
          details: last.details.map((d) => ({
            label: d.denomination.name ?? `$${fmt(dec(d.unitValue))}`,
            unitValue: fmt(dec(d.unitValue)),
            expected: d.expectedQuantity,
            counted: d.countedQuantity,
            difference: d.differenceQuantity,
          })),
        }
      : null,
    counts: {
      page: f.page,
      pageSize: f.pageSize,
      total: countsTotal,
      items: counts.map((c) => countView(c, folios)),
    },
    flows,
    adjustments: adjustments.map((a) => ({
      id: a.id,
      type: a.type,
      reason: a.reason,
      at: a.createdAt.toISOString(),
      amount: fmt(dec(a.amount)),
      sessionId: a.sessionId,
      createdBy: a.createdBy,
      closureAuthorizedBy: a.closureAuthorizedBy,
    })),
    bySession: perSession.map((s) => ({
      session: {
        id: s.sessionId,
        folio: s.folio,
        status: s.status,
        operatedDay: businessDay(s.operatedAt),
      },
      delivered: fmt(dec(s.delivered)),
      returned: fmt(dec(s.returned)),
      netNotReturned: fmt(dec(s.delivered).sub(dec(s.returned))),
    })),
    note: "Ningún jugador se lleva fichas: al terminar entrega todas las que tiene (o confirma $0). Los resultados individuales (devuelto − comprado) se compensan entre jugadores y no son faltante. Una diferencia nominal GLOBAL de la sesión se concilia en el cierre (retorno identificado en el arqueo o diferencia autorizada); la circulación de sesiones anteriores es un registro histórico por revisar y nunca se paga sin presentación y validación física.",
  }
}
