import "server-only"

import type { Prisma } from "@/generated/prisma/client"
import {
  AppError,
  BusinessRuleError,
  ConflictError,
  NotFoundError,
} from "@/lib/errors"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import {
  AUDIT_ACTIONS,
  diffChanges,
  recordAudit,
} from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import {
  lockOpenSession,
  lockSessionTable,
  TABLE_TX,
} from "@/modules/session-tables/session-table.service"
import { releaseDealerOfCycleInTx } from "@/modules/table-floor/dealer-core"
import type {
  AssignDealerInput,
  CreateDealerInput,
  UpdateDealerInput,
} from "@/modules/table-floor/table-floor.schemas"

/**
 * Dealers (mesa interactiva). El dealer es una PERSONA registrada: sin
 * cuenta de acceso, sin rol, sin asiento, sin compras, deudas ni
 * liquidaciones por su función. No hay botón «D» ni rotación: esa lógica
 * de juego no está definida todavía.
 *
 * Asignación por ciclo de mesa: una vigente por ciclo y una mesa vigente
 * por dealer (índices parciales). Cambiar de dealer libera la asignación
 * anterior (CHANGED) y crea otra; el historial nunca se borra.
 */

const user = { select: { id: true, name: true } } as const

function dealerView(d: {
  id: string
  name: string
  nickname: string | null
  isActive: boolean
  createdAt: Date
  assignments?: {
    id: string
    sessionTable: { table: { name: string } }
  }[]
}) {
  const current = d.assignments?.[0]
  return {
    id: d.id,
    name: d.name,
    nickname: d.nickname,
    isActive: d.isActive,
    createdAt: d.createdAt.toISOString(),
    /** Mesa donde está asignado ahora (o null). */
    assignedTo: current ? current.sessionTable.table.name : null,
  }
}
export type DealerView = ReturnType<typeof dealerView>

const dealerSelect = {
  id: true,
  name: true,
  nickname: true,
  isActive: true,
  createdAt: true,
  assignments: {
    where: { releasedAt: null },
    select: {
      id: true,
      sessionTable: { select: { table: { select: { name: true } } } },
    },
  },
} as const

export async function listDealers(status: "active" | "inactive" | "all") {
  const rows = await prisma.dealer.findMany({
    where:
      status === "all" ? {} : { isActive: status === "active" ? true : false },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    select: dealerSelect,
  })
  return rows.map(dealerView)
}

export async function createDealer(
  actor: SessionUser,
  input: CreateDealerInput,
  ctx: RequestContext = {}
) {
  return prisma.$transaction(async (tx) => {
    const d = await tx.dealer.create({
      data: {
        name: input.name,
        nickname: input.nickname || null,
        createdById: actor.id,
      },
      select: dealerSelect,
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.DEALER_CREATED,
        entityType: "Dealer",
        entityId: d.id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: { name: d.name, nickname: d.nickname },
      },
      tx
    )
    return dealerView(d)
  })
}

export async function updateDealer(
  actor: SessionUser,
  id: string,
  input: UpdateDealerInput,
  ctx: RequestContext = {}
) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "dealers" WHERE "id" = ${id} FOR UPDATE`
    const before = await tx.dealer.findUnique({
      where: { id },
      select: { name: true, nickname: true, isActive: true },
    })
    if (!before) throw new NotFoundError("Dealer no encontrado")
    const data = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.nickname !== undefined
        ? { nickname: input.nickname || null }
        : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    }
    const changes = diffChanges(before, data)
    if (!changes) {
      const d = await tx.dealer.findUniqueOrThrow({
        where: { id },
        select: dealerSelect,
      })
      return dealerView(d)
    }
    if (data.isActive === false) {
      const assigned = await tx.dealerAssignment.count({
        where: { dealerId: id, releasedAt: null },
      })
      if (assigned > 0)
        throw new BusinessRuleError(
          "El dealer está asignado a una mesa: libéralo antes de desactivarlo."
        )
    }
    const d = await tx.dealer.update({
      where: { id },
      data: { ...data, updatedById: actor.id },
      select: dealerSelect,
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.DEALER_UPDATED,
        entityType: "Dealer",
        entityId: id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: { changes },
      },
      tx
    )
    return dealerView(d)
  })
}

// ── Asignación ────────────────────────────────────────────────────────

async function tableCycle(
  tx: Prisma.TransactionClient,
  sessionId: string,
  tableId: string
) {
  const session = await lockOpenSession(
    tx,
    sessionId,
    "La sesión debe estar abierta para asignar dealer."
  )
  const st = await tx.sessionTable.findUnique({
    where: { sessionId_tableId: { sessionId, tableId } },
    select: { id: true },
  })
  if (!st) throw new BusinessRuleError("La mesa debe estar abierta.")
  const table = await lockSessionTable(tx, st.id)
  const cycle = table.cycles[0]
  if (table.status !== "OPEN" || !cycle)
    throw new BusinessRuleError("La mesa debe estar abierta.")
  return { session, table, cycle }
}

/**
 * Asigna un dealer al ciclo vigente de la mesa. Si ya había otro, lo
 * reemplaza (CHANGED) en la misma transacción. Idempotente por clave.
 */
export async function assignDealer(
  actor: SessionUser,
  sessionId: string,
  tableId: string,
  input: AssignDealerInput,
  ctx: RequestContext = {}
) {
  const previous = await prisma.dealerAssignment.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, dealerId: true, sessionId: true },
  })
  if (previous) {
    if (
      previous.dealerId !== input.dealerId ||
      previous.sessionId !== sessionId
    )
      throw new AppError(
        "CONFLICT",
        "Esta clave de operación ya se usó para otra asignación"
      )
    return { assignmentId: previous.id, replayed: true }
  }
  try {
    const id = await prisma.$transaction(async (tx) => {
      const { session, table, cycle } = await tableCycle(tx, sessionId, tableId)
      await tx.$queryRaw`SELECT "id" FROM "dealers" WHERE "id" = ${input.dealerId} FOR UPDATE`
      const dealer = await tx.dealer.findUnique({
        where: { id: input.dealerId },
        select: { id: true, name: true, isActive: true },
      })
      if (!dealer) throw new NotFoundError("Dealer no encontrado")
      if (!dealer.isActive)
        throw new BusinessRuleError("El dealer está inactivo.")
      const elsewhere = await tx.dealerAssignment.findFirst({
        where: { dealerId: dealer.id, releasedAt: null },
        select: {
          cycleId: true,
          sessionTable: { select: { table: { select: { name: true } } } },
        },
      })
      if (elsewhere?.cycleId === cycle.id)
        throw new ConflictError(`${dealer.name} ya es el dealer de esta mesa.`)
      if (elsewhere)
        throw new ConflictError(
          `${dealer.name} está asignado a la ${elsewhere.sessionTable.table.name}: libéralo allí primero.`
        )
      const replaced = await releaseDealerOfCycleInTx(
        tx,
        actor,
        cycle.id,
        "CHANGED",
        ctx
      )
      const created = await tx.dealerAssignment.create({
        data: {
          dealerId: dealer.id,
          sessionId,
          sessionTableId: table.id,
          cycleId: cycle.id,
          assignedById: actor.id,
          assignedAt: new Date(),
          idempotencyKey: input.idempotencyKey,
        },
        select: { id: true },
      })
      await recordAudit(
        {
          action: replaced
            ? AUDIT_ACTIONS.DEALER_CHANGED
            : AUDIT_ACTIONS.DEALER_ASSIGNED,
          entityType: "DealerAssignment",
          entityId: created.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            sessionId,
            folio: session.folio,
            cycleId: cycle.id,
            table: table.table.name,
            dealerId: dealer.id,
            dealerName: dealer.name,
            ...(replaced
              ? {
                  previousDealerId: replaced.dealerId,
                  previousAssignmentId: replaced.id,
                }
              : {}),
          },
        },
        tx
      )
      return created.id
    }, TABLE_TX)
    return { assignmentId: id, replayed: false }
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await prisma.dealerAssignment.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true },
      })
      if (again) return { assignmentId: again.id, replayed: true }
      throw new ConflictError(
        "La asignación de dealer cambió al mismo tiempo: vuelve a intentarlo."
      )
    }
    throw error
  }
}

/** Libera al dealer de la mesa (sin reemplazo). Idempotente por clave. */
export async function releaseDealer(
  actor: SessionUser,
  sessionId: string,
  tableId: string,
  input: { idempotencyKey: string },
  ctx: RequestContext = {}
) {
  const done = await prisma.dealerAssignment.findUnique({
    where: { releaseIdempotencyKey: input.idempotencyKey },
    select: { id: true },
  })
  if (done) return { replayed: true }
  await prisma.$transaction(async (tx) => {
    const { cycle } = await tableCycle(tx, sessionId, tableId)
    const released = await releaseDealerOfCycleInTx(
      tx,
      actor,
      cycle.id,
      "RELEASED",
      { ...ctx, releaseIdempotencyKey: input.idempotencyKey }
    )
    if (!released)
      throw new BusinessRuleError("La mesa no tiene dealer asignado.")
  }, TABLE_TX)
  return { replayed: false }
}

/** Historial de dealers de la mesa en la sesión (todos los ciclos). */
export async function getDealerHistory(sessionId: string, tableId: string) {
  const st = await prisma.sessionTable.findUnique({
    where: { sessionId_tableId: { sessionId, tableId } },
    select: { id: true },
  })
  if (!st) return []
  const rows = await prisma.dealerAssignment.findMany({
    where: { sessionTableId: st.id },
    orderBy: { assignedAt: "desc" },
    select: {
      id: true,
      assignedAt: true,
      releasedAt: true,
      releaseReason: true,
      cycle: { select: { cycleNumber: true } },
      dealer: { select: { id: true, name: true, nickname: true } },
      assignedBy: user,
      releasedBy: user,
    },
  })
  return rows.map((r) => ({
    id: r.id,
    dealer: r.dealer,
    cycleNumber: r.cycle.cycleNumber,
    assignedAt: r.assignedAt.toISOString(),
    assignedBy: r.assignedBy,
    releasedAt: r.releasedAt?.toISOString() ?? null,
    releasedBy: r.releasedBy,
    releaseReason: r.releaseReason,
  }))
}
