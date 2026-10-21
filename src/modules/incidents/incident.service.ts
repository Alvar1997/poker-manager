import "server-only"

import { Prisma } from "@/generated/prisma/client"
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@/lib/errors"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import { issueFolio } from "@/modules/settings/folio.service"

/**
 * Centro de incidencias (Módulo 15). Una incidencia NUNCA se borra (trigger)
 * y su historial es de solo inserción. Un hallazgo repetido no crea otra
 * incidencia mientras la anterior siga abierta: se registra la recurrencia
 * (índice único parcial por huella). Ninguna incidencia corrige datos.
 */

type Tx = Prisma.TransactionClient
type Db = Tx | typeof prisma
const TX = { maxWait: 10_000, timeout: 20_000 } as const

export type IncidentSeverityValue = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
export type IncidentStatusValue =
  "OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED"
export type IncidentSourceValue =
  "MANUAL" | "INTEGRITY" | "BACKUP" | "RESTORE" | "SECURITY"

const TRANSITIONS: Record<IncidentStatusValue, IncidentStatusValue[]> = {
  OPEN: ["IN_REVIEW", "RESOLVED", "DISMISSED"],
  IN_REVIEW: ["OPEN", "RESOLVED", "DISMISSED"],
  RESOLVED: ["OPEN"],
  DISMISSED: ["OPEN"],
}

export function incidentTransitionAllowed(
  from: IncidentStatusValue,
  to: IncidentStatusValue
) {
  return TRANSITIONS[from].includes(to)
}

export const INCIDENT_STATUS_LABEL: Record<IncidentStatusValue, string> = {
  OPEN: "Abierta",
  IN_REVIEW: "En revisión",
  RESOLVED: "Resuelta",
  DISMISSED: "Descartada",
}

export const INCIDENT_SEVERITY_LABEL: Record<IncidentSeverityValue, string> = {
  LOW: "Baja",
  MEDIUM: "Media",
  HIGH: "Alta",
  CRITICAL: "Crítica",
}

/**
 * Abre (o registra la recurrencia de) una incidencia automática, dentro de
 * la transacción del proceso que la detecta. Idempotente por huella.
 */
export async function raiseIncidentInTx(
  tx: Tx,
  input: {
    source: IncidentSourceValue
    fingerprint: string
    title: string
    description: string
    severity: IncidentSeverityValue
    entityType?: string | null
    entityId?: string | null
    findingId?: string | null
    actorId?: string | null
    requestId?: string | null
  }
): Promise<{ id: string; created: boolean }> {
  const open = await tx.operationalIncident.findFirst({
    where: {
      fingerprint: input.fingerprint,
      status: { in: ["OPEN", "IN_REVIEW"] },
    },
    select: { id: true },
  })
  if (open) {
    await tx.operationalIncident.update({
      where: { id: open.id },
      data: {
        occurrences: { increment: 1 },
        lastSeenAt: new Date(),
        ...(input.findingId && { findingId: input.findingId }),
      },
    })
    await tx.incidentHistory.create({
      data: {
        incidentId: open.id,
        kind: "REOCCURRED",
        notes: input.description.slice(0, 1000),
        actorId: input.actorId ?? null,
      },
    })
    return { id: open.id, created: false }
  }
  const folio = await issueFolio(tx, "INCIDENT")
  const created = await tx.operationalIncident.create({
    data: {
      folio,
      title: input.title.slice(0, 200),
      description: input.description.slice(0, 2000),
      severity: input.severity,
      source: input.source,
      fingerprint: input.fingerprint,
      findingId: input.findingId ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      createdById: input.actorId ?? null,
    },
    select: { id: true },
  })
  await tx.incidentHistory.create({
    data: {
      incidentId: created.id,
      kind: "CREATED",
      toStatus: "OPEN",
      notes: input.description.slice(0, 1000),
      actorId: input.actorId ?? null,
    },
  })
  await recordAudit(
    {
      action: AUDIT_ACTIONS.INCIDENT_CREATED,
      entityType: "OperationalIncident",
      entityId: created.id,
      actorUserId: input.actorId ?? null,
      requestId: input.requestId ?? null,
      metadata: {
        folio,
        source: input.source,
        severity: input.severity,
        title: input.title.slice(0, 200),
      },
    },
    tx
  )
  return { id: created.id, created: true }
}

/** Fuera de una transacción (procesos de infraestructura); tolera carreras. */
export async function raiseIncident(
  input: Parameters<typeof raiseIncidentInTx>[1]
) {
  try {
    return await prisma.$transaction((tx) => raiseIncidentInTx(tx, input), TX)
  } catch (error) {
    if (isUniqueViolation(error))
      return prisma.$transaction((tx) => raiseIncidentInTx(tx, input), TX)
    throw error
  }
}

export async function createManualIncident(
  actor: SessionUser,
  input: {
    title: string
    description: string
    severity: IncidentSeverityValue
    entityType?: string
    entityId?: string
  },
  ctx: RequestContext = {}
) {
  return prisma.$transaction(async (tx) => {
    const folio = await issueFolio(tx, "INCIDENT")
    const created = await tx.operationalIncident.create({
      data: {
        folio,
        title: input.title,
        description: input.description,
        severity: input.severity,
        source: "MANUAL",
        entityType: input.entityType || null,
        entityId: input.entityId || null,
        createdById: actor.id,
      },
      select: { id: true, folio: true },
    })
    await tx.incidentHistory.create({
      data: {
        incidentId: created.id,
        kind: "CREATED",
        toStatus: "OPEN",
        notes: input.description.slice(0, 1000),
        actorId: actor.id,
      },
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.INCIDENT_CREATED,
        entityType: "OperationalIncident",
        entityId: created.id,
        actorUserId: actor.id,
        actorRole: actor.role,
        requestId: ctx.requestId,
        metadata: { folio, source: "MANUAL", severity: input.severity },
      },
      tx
    )
    return created
  }, TX)
}

/**
 * Cambia estado, asigna, comenta o agrega evidencia. Resolver o descartar
 * exige `incidents:resolve` (PARTNER/SUPERADMIN) y una resolución escrita.
 */
export async function updateIncident(
  actor: SessionUser,
  id: string,
  input: {
    expectedVersion: number
    status?: IncidentStatusValue
    assignedToId?: string | null
    comment?: string
    evidence?: string
    resolution?: string
  },
  opts: { canResolve: boolean },
  ctx: RequestContext = {}
) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "operational_incidents" WHERE "id" = ${id} FOR UPDATE`
    if (!rows.length) throw new NotFoundError("Incidencia no encontrada")
    const inc = await tx.operationalIncident.findUniqueOrThrow({
      where: { id },
    })
    if (inc.version !== input.expectedVersion)
      throw new ConflictError(
        "La incidencia cambió mientras la editabas. Vuelve a cargarla."
      )
    const data: Prisma.OperationalIncidentUncheckedUpdateInput = {
      version: { increment: 1 },
    }
    const history: Prisma.IncidentHistoryUncheckedCreateInput[] = []
    if (input.status && input.status !== inc.status) {
      if (!incidentTransitionAllowed(inc.status, input.status))
        throw new BusinessRuleError(
          `No se puede pasar de ${inc.status} a ${input.status}.`
        )
      const closing =
        input.status === "RESOLVED" || input.status === "DISMISSED"
      if (closing) {
        if (!opts.canResolve)
          throw new ForbiddenError(
            "Solo PARTNER o SUPERADMIN resuelven o descartan incidencias."
          )
        if (!input.resolution || input.resolution.trim().length < 5)
          throw new BusinessRuleError(
            "Escribe la resolución (mínimo 5 caracteres)."
          )
        data.resolution = input.resolution.trim()
        data.resolvedById = actor.id
        data.resolvedAt = new Date()
      } else if (input.status === "OPEN") {
        data.resolvedAt = null
        data.resolvedById = null
      }
      data.status = input.status
      history.push({
        incidentId: id,
        kind: "STATUS_CHANGED",
        fromStatus: inc.status,
        toStatus: input.status,
        notes: closing ? input.resolution : (input.comment ?? null),
        actorId: actor.id,
      })
    }
    if (
      input.assignedToId !== undefined &&
      input.assignedToId !== inc.assignedToId
    ) {
      if (input.assignedToId) {
        const u = await tx.user.findUnique({
          where: { id: input.assignedToId },
          select: { isActive: true },
        })
        if (!u?.isActive)
          throw new BusinessRuleError(
            "El responsable debe ser un usuario activo."
          )
      }
      data.assignedToId = input.assignedToId
      history.push({
        incidentId: id,
        kind: "ASSIGNED",
        notes: input.assignedToId ?? "sin responsable",
        actorId: actor.id,
      })
    }
    if (input.comment && !input.status)
      history.push({
        incidentId: id,
        kind: "COMMENT",
        notes: input.comment,
        actorId: actor.id,
      })
    if (input.evidence)
      history.push({
        incidentId: id,
        kind: "EVIDENCE",
        notes: input.evidence,
        actorId: actor.id,
      })
    if (history.length === 0)
      throw new BusinessRuleError("No hay cambios que registrar.")
    await tx.operationalIncident.update({ where: { id }, data })
    await tx.incidentHistory.createMany({ data: history })
    await recordAudit(
      {
        action:
          input.status === "RESOLVED" || input.status === "DISMISSED"
            ? AUDIT_ACTIONS.INCIDENT_RESOLVED
            : AUDIT_ACTIONS.INCIDENT_UPDATED,
        entityType: "OperationalIncident",
        entityId: id,
        actorUserId: actor.id,
        actorRole: actor.role,
        requestId: ctx.requestId,
        reason: input.resolution ?? null,
        metadata: {
          folio: inc.folio,
          changes: history.map((h) => h.kind),
          to: input.status ?? null,
        },
      },
      tx
    )
    return { id }
  }, TX)
}

// ── Consultas ─────────────────────────────────────────────────────────

export async function listIncidents(q: {
  status?: IncidentStatusValue
  severity?: IncidentSeverityValue
  source?: IncidentSourceValue
  page: number
  pageSize: number
}) {
  const where: Prisma.OperationalIncidentWhereInput = {
    ...(q.status && { status: q.status }),
    ...(q.severity && { severity: q.severity }),
    ...(q.source && { source: q.source }),
  }
  const [total, rows, open] = await Promise.all([
    prisma.operationalIncident.count({ where }),
    prisma.operationalIncident.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      select: {
        id: true,
        folio: true,
        title: true,
        severity: true,
        status: true,
        source: true,
        occurrences: true,
        createdAt: true,
        lastSeenAt: true,
        assignedTo: { select: { id: true, name: true } },
      },
    }),
    prisma.operationalIncident.groupBy({
      by: ["severity"],
      where: { status: { in: ["OPEN", "IN_REVIEW"] } },
      _count: true,
    }),
  ])
  return {
    page: q.page,
    pageSize: q.pageSize,
    total,
    openBySeverity: Object.fromEntries(open.map((o) => [o.severity, o._count])),
    items: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
    })),
  }
}

export async function getIncident(id: string, db: Db = prisma) {
  const r = await db.operationalIncident.findUnique({
    where: { id },
    include: {
      assignedTo: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
      resolvedBy: { select: { id: true, name: true } },
      finding: {
        select: {
          id: true,
          runId: true,
          checkCode: true,
          expected: true,
          actual: true,
          difference: true,
          explanation: true,
        },
      },
      history: {
        orderBy: { createdAt: "asc" },
        include: { actor: { select: { id: true, name: true } } },
      },
    },
  })
  if (!r) throw new NotFoundError("Incidencia no encontrada")
  return {
    id: r.id,
    folio: r.folio,
    title: r.title,
    description: r.description,
    severity: r.severity,
    status: r.status,
    source: r.source,
    entityType: r.entityType,
    entityId: r.entityId,
    occurrences: r.occurrences,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    resolution: r.resolution,
    assignedTo: r.assignedTo,
    createdBy: r.createdBy,
    resolvedBy: r.resolvedBy,
    finding: r.finding,
    history: r.history.map((h) => ({
      id: h.id,
      kind: h.kind,
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      notes: h.notes,
      createdAt: h.createdAt.toISOString(),
      actor: h.actor,
    })),
  }
}

export type IncidentDetail = Awaited<ReturnType<typeof getIncident>>

export async function assignableUsers() {
  return prisma.user.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, role: true },
  })
}
