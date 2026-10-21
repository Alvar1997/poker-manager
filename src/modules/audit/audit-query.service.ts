import "server-only"

import type { Prisma } from "@/generated/prisma/client"
import { NotFoundError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import {
  AUDIT_MODULE_LABEL,
  moduleOfAction,
  type AuditModule,
} from "@/modules/audit/audit-taxonomy"
import { AUDIT_ACTIONS } from "@/modules/audit/audit.service"
import type { AuditFilters } from "@/modules/audit/audit.filters"
import { businessRange } from "@/modules/reports/report.math"

/**
 * Consulta de la auditoría transversal (Módulo 15). SOLO LECTURA: no hay
 * servicio ni endpoint que edite o borre eventos (además, trigger en BD).
 *
 * Los tres roles consultan la auditoría operativa y financiera (DEC-01..03).
 * Los eventos de SEGURIDAD (inicios de sesión, IPs) exigen
 * `audit:security-read` y los de INFRAESTRUCTURA (respaldos, recuperación)
 * `backups:read`: la autorización general no los expone.
 */

export type AuditViewer = {
  canSecurity: boolean
  canInfrastructure: boolean
}

const ALL_ACTIONS = Object.values(AUDIT_ACTIONS) as string[]
const actionsOf = (m: AuditModule) =>
  ALL_ACTIONS.filter((a) => moduleOfAction(a) === m)

/** Filtro por módulo que cubre eventos previos al Módulo 15 (sin columna). */
function moduleWhere(m: AuditModule): Prisma.AuditLogWhereInput {
  return {
    OR: [{ module: m }, { module: null, action: { in: actionsOf(m) } }],
  }
}

function restrictionWhere(v: AuditViewer): Prisma.AuditLogWhereInput[] {
  const out: Prisma.AuditLogWhereInput[] = []
  if (!v.canSecurity)
    out.push(
      { NOT: { action: { startsWith: "AUTH_" } } },
      {
        NOT: { module: "SECURITY" },
      }
    )
  if (!v.canInfrastructure) out.push({ NOT: { module: "INFRASTRUCTURE" } })
  return out
}

export function auditWhere(
  f: AuditFilters,
  viewer: AuditViewer
): Prisma.AuditLogWhereInput {
  const range = businessRange(f.from, f.to)
  const and: Prisma.AuditLogWhereInput[] = [...restrictionWhere(viewer)]
  if (f.module) and.push(moduleWhere(f.module))
  if (f.operationId)
    and.push({
      OR: [
        { entityId: f.operationId },
        { requestId: f.operationId },
        { idempotencyKey: f.operationId },
        { id: f.operationId },
      ],
    })
  return {
    ...(range && { createdAt: range }),
    ...(f.actorUserId && { actorUserId: f.actorUserId }),
    ...(f.actorRole && { actorRole: f.actorRole }),
    ...(f.action && { action: f.action }),
    ...(f.sessionId && { sessionId: f.sessionId }),
    ...(f.playerId && { playerId: f.playerId }),
    ...(f.result && { result: f.result }),
    ...(and.length && { AND: and }),
  }
}

const listSelect = {
  id: true,
  action: true,
  entityType: true,
  entityId: true,
  result: true,
  requestId: true,
  createdAt: true,
  actorRole: true,
  module: true,
  sessionId: true,
  tableCycleId: true,
  playerId: true,
  amount: true,
  actor: { select: { id: true, name: true, role: true } },
} satisfies Prisma.AuditLogSelect

type ListRow = Prisma.AuditLogGetPayload<{ select: typeof listSelect }>

async function labels(db: typeof prisma, rows: ListRow[]) {
  const sessionIds = [
    ...new Set(rows.map((r) => r.sessionId).filter(Boolean)),
  ] as string[]
  const playerIds = [
    ...new Set(rows.map((r) => r.playerId).filter(Boolean)),
  ] as string[]
  const cycleIds = [
    ...new Set(rows.map((r) => r.tableCycleId).filter(Boolean)),
  ] as string[]
  const [sessions, players, cycles] = await Promise.all([
    db.pokerSession.findMany({
      where: { id: { in: sessionIds } },
      select: { id: true, folio: true },
    }),
    db.player.findMany({
      where: { id: { in: playerIds } },
      select: { id: true, name: true },
    }),
    db.sessionTableCycle.findMany({
      where: { id: { in: cycleIds } },
      select: {
        id: true,
        cycleNumber: true,
        sessionTable: { select: { table: { select: { name: true } } } },
      },
    }),
  ])
  return {
    session: new Map(sessions.map((s) => [s.id, s.folio])),
    player: new Map(players.map((p) => [p.id, p.name])),
    cycle: new Map(
      cycles.map((c) => [
        c.id,
        `${c.sessionTable.table.name} · ciclo ${c.cycleNumber}`,
      ])
    ),
  }
}

function rowView(r: ListRow, l: Awaited<ReturnType<typeof labels>>) {
  const mod = (r.module as AuditModule | null) ?? moduleOfAction(r.action)
  return {
    id: r.id,
    occurredAt: r.createdAt.toISOString(),
    action: r.action,
    module: mod,
    moduleLabel: AUDIT_MODULE_LABEL[mod] ?? mod,
    entityType: r.entityType,
    entityId: r.entityId,
    result: r.result,
    requestId: r.requestId,
    actor: r.actor ? { id: r.actor.id, name: r.actor.name } : null,
    /** Rol AL MOMENTO del evento (eventos previos al M15: no registrado). */
    actorRole: r.actorRole,
    session: r.sessionId
      ? { id: r.sessionId, folio: l.session.get(r.sessionId) ?? null }
      : null,
    table: r.tableCycleId ? (l.cycle.get(r.tableCycleId) ?? null) : null,
    player: r.playerId
      ? { id: r.playerId, name: l.player.get(r.playerId) ?? null }
      : null,
    amount: r.amount ? r.amount.toFixed(2) : null,
  }
}

export type AuditRowView = ReturnType<typeof rowView>

export async function listAuditEvents(
  f: AuditFilters,
  viewer: AuditViewer,
  db: typeof prisma = prisma
) {
  const where = auditWhere(f, viewer)
  const [total, rows] = await Promise.all([
    db.auditLog.count({ where }),
    db.auditLog.findMany({
      where,
      select: listSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (f.page - 1) * f.pageSize,
      take: f.pageSize,
    }),
  ])
  const l = await labels(db, rows)
  return {
    page: f.page,
    pageSize: f.pageSize,
    total,
    items: rows.map((r) => rowView(r, l)),
  }
}

/** Detalle de un evento + eventos de la MISMA request (trazabilidad). */
export async function getAuditEvent(
  id: string,
  viewer: AuditViewer,
  db: typeof prisma = prisma
) {
  const restricted = restrictionWhere(viewer)
  const e = await db.auditLog.findFirst({
    where: { id, ...(restricted.length && { AND: restricted }) },
    select: {
      ...listSelect,
      metadata: true,
      idempotencyKey: true,
      reason: true,
      relatedEventId: true,
      evidenceRef: true,
    },
  })
  if (!e) throw new NotFoundError("Evento de auditoría no encontrado")
  const related = await db.auditLog.findMany({
    where: {
      id: { not: e.id },
      ...(restricted.length && { AND: restricted }),
      OR: [
        ...(e.requestId ? [{ requestId: e.requestId }] : []),
        ...(e.relatedEventId ? [{ id: e.relatedEventId }] : []),
        { relatedEventId: e.id },
      ],
    },
    select: listSelect,
    orderBy: { createdAt: "asc" },
    take: 50,
  })
  const l = await labels(db, [e, ...related])
  return {
    ...rowView(e, l),
    metadata: e.metadata,
    idempotencyKey: e.idempotencyKey,
    reason: e.reason,
    relatedEventId: e.relatedEventId,
    evidenceRef: e.evidenceRef,
    related: related.map((r) => rowView(r, l)),
  }
}

/** Opciones de filtros (actores reales y eventos conocidos). */
export async function auditFilterOptions(viewer: AuditViewer) {
  const users = await prisma.user.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  })
  const actions = ALL_ACTIONS.filter((a) => {
    const m = moduleOfAction(a)
    if (m === "SECURITY" && !viewer.canSecurity) return false
    if (m === "INFRASTRUCTURE" && !viewer.canInfrastructure) return false
    return true
  }).sort()
  return {
    users: users.map((u) => ({ id: u.id, label: u.name })),
    actions: actions.map((a) => ({ id: a, label: a })),
  }
}
