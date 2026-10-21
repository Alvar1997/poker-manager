import "server-only"

import type { Prisma } from "@/generated/prisma/client"
import {
  AppError,
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
import type {
  CreateSessionInput,
  SessionsQuery,
} from "@/modules/sessions/session.schemas"
import {
  canManagePreparation,
  canTransition,
  isSuperadminIntervention,
  PREPARATION_FORBIDDEN_MESSAGE,
  SESSION_STATUS_LABEL,
  type SessionStatusValue,
} from "@/modules/sessions/session.state"

/**
 * Ciclo de vida de una sesión hasta su apertura (Módulo 06).
 *
 * - Una sola sesión vigente (índice único parcial en PostgreSQL): dos
 *   creaciones simultáneas → una gana, la otra recibe 409.
 * - Folio por `issueFolio` dentro de la misma transacción (sin huecos si
 *   la creación falla). Creador, folio y fechas los fija el servidor.
 * - Toda transición pasa por `transitionInTx`: bloqueo FOR UPDATE +
 *   actualización condicional sobre el estado de origen + historial +
 *   auditoría (la base vuelve a validar la transición con un trigger).
 * - La apertura vive en `opening.service.ts`; el cierre, en el Módulo 12.
 */

export type Tx = Prisma.TransactionClient
export const SESSION_TX = { maxWait: 15_000, timeout: 20_000 } as const

const actorSel = {
  select: { id: true, name: true, role: true, isActive: true },
} as const

const sessionSelect = {
  id: true,
  folio: true,
  status: true,
  notes: true,
  createdAt: true,
  preparationStartedAt: true,
  openedAt: true,
  closingStartedAt: true,
  closedAt: true,
  cancelledAt: true,
  cancellationReason: true,
  createdById: true,
  createdBy: actorSel,
  openedBy: actorSel,
  cancelledBy: actorSel,
  opening: {
    select: {
      id: true,
      confirmedAt: true,
      inventoryVersion: true,
      openingCashAmount: true,
      superadminIntervention: true,
      chipStockCountId: true,
      cashReconciliationId: true,
      confirmedBy: actorSel,
    },
  },
} satisfies Prisma.PokerSessionSelect

type SessionRecord = Prisma.PokerSessionGetPayload<{
  select: typeof sessionSelect
}>

function toView(s: SessionRecord, viewer?: { id: string; role: string }) {
  const iso = (d: Date | null) => d?.toISOString() ?? null
  const actor = (u: { id: string; name: string } | null) =>
    u ? { id: u.id, name: u.name } : null
  return {
    id: s.id,
    folio: s.folio,
    status: s.status,
    statusLabel: SESSION_STATUS_LABEL[s.status],
    notes: s.notes,
    createdAt: s.createdAt.toISOString(),
    preparationStartedAt: iso(s.preparationStartedAt),
    openedAt: iso(s.openedAt),
    closingStartedAt: iso(s.closingStartedAt),
    closedAt: iso(s.closedAt),
    cancelledAt: iso(s.cancelledAt),
    cancellationReason: s.cancellationReason,
    createdBy: { ...actor(s.createdBy)!, isActive: s.createdBy.isActive },
    openedBy: actor(s.openedBy),
    cancelledBy: actor(s.cancelledBy),
    opening: s.opening
      ? {
          id: s.opening.id,
          confirmedAt: s.opening.confirmedAt.toISOString(),
          inventoryVersion: s.opening.inventoryVersion,
          openingCashAmount: s.opening.openingCashAmount.toFixed(2),
          superadminIntervention: s.opening.superadminIntervention,
          chipStockCountId: s.opening.chipStockCountId,
          cashReconciliationId: s.opening.cashReconciliationId,
          confirmedBy: actor(s.opening.confirmedBy),
        }
      : null,
    /** El usuario que consulta puede continuar la preparación (creador o SUPERADMIN). */
    canManagePreparation: viewer ? canManagePreparation(viewer, s) : false,
  }
}
export type SessionView = ReturnType<typeof toView>

// ── Bloqueo y transiciones ────────────────────────────────────────────

export async function lockSession(tx: Tx, sessionId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "poker_sessions" WHERE "id" = ${sessionId} FOR UPDATE
  `
  if (rows.length === 0) throw new NotFoundError("Sesión no encontrada")
  return tx.pokerSession.findUniqueOrThrow({
    where: { id: sessionId },
    select: { id: true, folio: true, status: true, createdById: true },
  })
}

/**
 * Única forma de cambiar el estado. Condicional sobre el estado de origen:
 * dos solicitudes simultáneas no pueden aplicar la misma transición dos veces.
 */
export async function transitionInTx(
  tx: Tx,
  session: { id: string; folio: string; status: SessionStatusValue },
  to: SessionStatusValue,
  actor: SessionUser,
  data: Prisma.PokerSessionUncheckedUpdateManyInput = {},
  reason: string | null = null
) {
  if (!canTransition(session.status, to)) {
    throw new ConflictError(
      `La sesión ${session.folio} está ${SESSION_STATUS_LABEL[session.status].toLowerCase()}: no puede pasar a ${SESSION_STATUS_LABEL[to].toLowerCase()}.`
    )
  }
  const { count } = await tx.pokerSession.updateMany({
    where: { id: session.id, status: session.status },
    data: { ...data, status: to },
  })
  if (count !== 1)
    throw new ConflictError(
      "La sesión cambió de estado: recarga e intenta de nuevo"
    )
  await tx.sessionStatusHistory.create({
    data: {
      sessionId: session.id,
      fromStatus: session.status,
      toStatus: to,
      changedById: actor.id,
      reason,
    },
  })
}

async function auditIntervention(
  tx: Tx,
  actor: SessionUser,
  session: { id: string; folio: string; createdById: string },
  action: string,
  ctx: RequestContext
) {
  if (!isSuperadminIntervention(actor, session)) return
  await recordAudit(
    {
      action: AUDIT_ACTIONS.SESSION_SUPERADMIN_INTERVENTION,
      entityType: "PokerSession",
      entityId: session.id,
      actorUserId: actor.id,
      requestId: ctx.requestId,
      metadata: {
        folio: session.folio,
        action,
        creatorId: session.createdById,
      },
    },
    tx
  )
}

// ── Crear ─────────────────────────────────────────────────────────────

export async function createSession(
  actor: SessionUser,
  input: CreateSessionInput,
  ctx: RequestContext = {}
): Promise<SessionView & { replayed: boolean }> {
  const replay = async () => {
    const existing = await prisma.pokerSession.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: sessionSelect,
    })
    if (!existing) return null
    if (existing.createdById !== actor.id) {
      throw new AppError(
        "CONFLICT",
        "Esta clave de operación ya se usó para otra sesión"
      )
    }
    return { ...toView(existing, actor), replayed: true }
  }
  const previous = await replay()
  if (previous) return previous

  try {
    const id = await prisma.$transaction(async (tx) => {
      const cashBox = await tx.cashBox.findUnique({
        where: { code: "MAIN" },
        select: { id: true },
      })
      if (!cashBox)
        throw new BusinessRuleError(
          "No existe la caja central. Ejecuta `npm run db:seed`."
        )
      const folio = await issueFolio(tx, "SESSION")
      const created = await tx.pokerSession.create({
        data: {
          folio,
          cashBoxId: cashBox.id,
          createdById: actor.id,
          notes: input.notes ?? null,
          idempotencyKey: input.idempotencyKey,
        },
        select: { id: true },
      })
      await tx.sessionStatusHistory.create({
        data: {
          sessionId: created.id,
          fromStatus: null,
          toStatus: "DRAFT",
          changedById: actor.id,
        },
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.SESSION_CREATED,
          entityType: "PokerSession",
          entityId: created.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: { folio },
        },
        tx
      )
      return created.id
    }, SESSION_TX)
    const session = await prisma.pokerSession.findUniqueOrThrow({
      where: { id },
      select: sessionSelect,
    })
    return { ...toView(session, actor), replayed: false }
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await replay()
      if (again) return again
      const active = await getActiveSessionRecord()
      throw new AppError(
        "CONFLICT",
        active
          ? `Ya existe una sesión vigente (${active.folio}, ${SESSION_STATUS_LABEL[active.status].toLowerCase()}). Termínala o cancélala antes de crear otra.`
          : "Ya existe una sesión vigente.",
        { activeSessionId: active?.id ?? null }
      )
    }
    throw error
  }
}

// ── Consultas ─────────────────────────────────────────────────────────

async function getActiveSessionRecord() {
  return prisma.pokerSession.findFirst({
    where: { status: { in: ["DRAFT", "PREPARATION", "OPEN", "CLOSING"] } },
    select: sessionSelect,
  })
}

export async function getActiveSession(viewer?: { id: string; role: string }) {
  const s = await getActiveSessionRecord()
  return s ? toView(s, viewer) : null
}

export async function getSession(
  id: string,
  viewer?: { id: string; role: string }
) {
  const s = await prisma.pokerSession.findUnique({
    where: { id },
    select: sessionSelect,
  })
  if (!s) throw new NotFoundError("Sesión no encontrada")
  return toView(s, viewer)
}

export async function listSessions(
  query: SessionsQuery,
  viewer?: { id: string; role: string }
) {
  const where: Prisma.PokerSessionWhereInput = {}
  if (query.status) where.status = query.status
  if (query.q) where.folio = { contains: query.q.toUpperCase() }
  if (query.from || query.to) {
    where.createdAt = {
      ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
      ...(query.to
        ? {
            lt: new Date(
              new Date(`${query.to}T00:00:00.000Z`).getTime() + 86_400_000
            ),
          }
        : {}),
    }
  }
  const [total, rows] = await prisma.$transaction([
    prisma.pokerSession.count({ where }),
    prisma.pokerSession.findMany({
      where,
      orderBy: [{ createdAt: query.sort }, { id: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: sessionSelect,
    }),
  ])
  return {
    items: rows.map((s) => toView(s, viewer)),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  }
}

export async function getStatusHistory(sessionId: string) {
  const exists = await prisma.pokerSession.findUnique({
    where: { id: sessionId },
    select: { id: true },
  })
  if (!exists) throw new NotFoundError("Sesión no encontrada")
  const rows = await prisma.sessionStatusHistory.findMany({
    where: { sessionId },
    orderBy: { changedAt: "asc" },
    select: {
      id: true,
      fromStatus: true,
      toStatus: true,
      changedAt: true,
      reason: true,
      changedBy: { select: { id: true, name: true } },
    },
  })
  return rows.map((r) => ({ ...r, changedAt: r.changedAt.toISOString() }))
}

// ── Preparar ──────────────────────────────────────────────────────────

/** DRAFT → PREPARATION. Solo el creador o SUPERADMIN. Idempotente. */
export async function prepareSession(
  actor: SessionUser,
  sessionId: string,
  ctx: RequestContext = {}
) {
  await prisma.$transaction(async (tx) => {
    const session = await lockSession(tx, sessionId)
    if (!canManagePreparation(actor, session))
      throw new ForbiddenError(PREPARATION_FORBIDDEN_MESSAGE)
    if (session.status === "PREPARATION") return
    await transitionInTx(tx, session, "PREPARATION", actor, {
      preparationStartedAt: new Date(),
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.SESSION_PREPARATION_STARTED,
        entityType: "PokerSession",
        entityId: session.id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: { folio: session.folio },
      },
      tx
    )
    await auditIntervention(tx, actor, session, "prepare", ctx)
  }, SESSION_TX)
  return getSession(sessionId, actor)
}

// ── Cancelar ──────────────────────────────────────────────────────────

/**
 * Cancela una sesión DRAFT o PREPARATION (nunca OPEN por esta vía).
 * No borra nada: cancela borradores propios de la preparación y exige
 * resolver antes las diferencias de arqueo pendientes. Los ajustes reales
 * de inventario ya aplicados NO se revierten (siguen en el libro).
 */
export async function cancelSession(
  actor: SessionUser,
  sessionId: string,
  input: { reason: string },
  ctx: RequestContext = {}
) {
  await prisma.$transaction(async (tx) => {
    const session = await lockSession(tx, sessionId)
    if (session.status === "CANCELLED") return
    if (!canManagePreparation(actor, session)) {
      throw new ForbiddenError(
        "Solo quien creó la sesión o un superadministrador pueden cancelarla."
      )
    }
    if (session.status !== "DRAFT" && session.status !== "PREPARATION") {
      throw new ConflictError(
        `Una sesión ${SESSION_STATUS_LABEL[session.status].toLowerCase()} no se cancela: ${session.status === "OPEN" ? "se cierra con el proceso de cierre." : "es definitiva."}`
      )
    }
    const pendingDifferences = await tx.chipStockCount.count({
      where: {
        sessionId,
        status: "CONFIRMED",
        reconciliationStatus: "PENDING",
      },
    })
    if (pendingDifferences > 0) {
      throw new BusinessRuleError(
        "El arqueo de fichas de esta sesión tiene diferencias sin conciliar: concílialas antes de cancelar."
      )
    }
    const moneyMovements = await tx.cashTransaction.count({
      where: { sessionId },
    })
    if (moneyMovements > 0) {
      throw new BusinessRuleError(
        "La sesión tiene movimientos de dinero: no puede cancelarse."
      )
    }
    const draftCounts = await tx.chipStockCount.findMany({
      where: { sessionId, status: "DRAFT" },
      select: { id: true },
    })
    for (const c of draftCounts) {
      await tx.chipStockCount.update({
        where: { id: c.id },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.CHIP_COUNT_CANCELLED,
          entityType: "ChipStockCount",
          entityId: c.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: { sessionId, reason: "Sesión cancelada" },
        },
        tx
      )
    }
    await tx.cashReconciliation.updateMany({
      where: { sessionId, status: "DRAFT" },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    })
    const now = new Date()
    await transitionInTx(
      tx,
      session,
      "CANCELLED",
      actor,
      {
        cancelledAt: now,
        cancelledById: actor.id,
        cancellationReason: input.reason,
      },
      input.reason
    )
    await recordAudit(
      {
        action: AUDIT_ACTIONS.SESSION_CANCELLED,
        entityType: "PokerSession",
        entityId: session.id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          folio: session.folio,
          from: session.status,
          reason: input.reason,
        },
      },
      tx
    )
    await auditIntervention(tx, actor, session, "cancel", ctx)
  }, SESSION_TX)
  return getSession(sessionId, actor)
}
