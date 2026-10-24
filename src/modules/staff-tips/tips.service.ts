import "server-only"

import { randomUUID } from "node:crypto"

import { Prisma } from "@/generated/prisma/client"
import { BusinessRuleError, ConflictError, NotFoundError } from "@/lib/errors"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import { nominalEffectInTx } from "@/modules/rake/nominal-effect"

import { dec, fmt, staffTipFigures, tipsTotal, ZERO } from "./tips.math"
import type {
  ConfirmTipCountInput,
  CorrectTipCountInput,
  PartialTipInput,
  SaveTipCountInput,
} from "./tips.schemas"

/**
 * Propinas por empleado y sesión (Módulo 18, simplificado). Solo importes
 * nominales: sin turnos, firmas, pagos ni saldos del staff. Un conteo por
 * empleado y sesión (borrador → confirmado); al confirmarlo las fichas se
 * reciben y regresan al inventario compartido una sola vez. Las
 * correcciones (±, motivo) son movimientos nuevos con su efecto real.
 * No es dinero de la casa ni toca la caja. Bloqueos: sesión (FOR SHARE) →
 * staff de la sesión (FOR UPDATE) → inventario.
 */

type Tx = Prisma.TransactionClient
type Db = Tx | typeof prisma
const TX = { maxWait: 15_000, timeout: 30_000 } as const

async function lockLiveSessionInTx(tx: Tx, sessionId: string, action: string) {
  const rows = await tx.$queryRaw<{ status: string }[]>`
    SELECT "status"::text AS "status" FROM "poker_sessions"
     WHERE "id" = ${sessionId} FOR SHARE`
  if (rows.length === 0) throw new NotFoundError("Sesión no encontrada")
  if (rows[0].status !== "OPEN" && rows[0].status !== "CLOSING")
    throw new BusinessRuleError(
      `La sesión debe estar abierta o en cierre para ${action}. Una sesión cerrada no se modifica.`
    )
}

async function lockSessionStaffInTx(
  tx: Tx,
  sessionId: string,
  sessionStaffId: string,
  action: string
) {
  await lockLiveSessionInTx(tx, sessionId, action)
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "session_staff"
     WHERE "id" = ${sessionStaffId} AND "sessionId" = ${sessionId} FOR UPDATE`
  if (rows.length === 0)
    throw new NotFoundError("El empleado no está asignado a esta sesión")
  return tx.sessionStaff.findUniqueOrThrow({
    where: { id: sessionStaffId },
    include: {
      staffMember: { select: { id: true, name: true } },
      tipCount: true,
    },
  })
}

async function figuresOf(db: Db, sessionStaffId: string) {
  const [count, entries] = await Promise.all([
    db.staffTipCount.findUnique({
      where: { sessionStaffId },
      select: { status: true, amount: true },
    }),
    db.staffTipEntry.findMany({
      where: { sessionStaffId },
      select: { kind: true, amount: true },
    }),
  ])
  return staffTipFigures({
    count: count ? { status: count.status, amount: dec(count.amount) } : null,
    entries: entries.map((e) => ({ kind: e.kind, amount: dec(e.amount) })),
  })
}

// ── Staff de la sesión ────────────────────────────────────────────────

export async function addStaffToSession(
  actor: SessionUser,
  sessionId: string,
  staffMemberId: string,
  ctx: RequestContext = {}
) {
  try {
    return await prisma.$transaction(async (tx) => {
      await lockLiveSessionInTx(tx, sessionId, "agregar personal")
      const m = await tx.staffMember.findUnique({
        where: { id: staffMemberId },
        select: { isActive: true, name: true },
      })
      if (!m) throw new NotFoundError("Empleado no encontrado")
      if (!m.isActive) throw new BusinessRuleError("El empleado está inactivo")
      const row = await tx.sessionStaff.create({
        data: { sessionId, staffMemberId, addedById: actor.id },
        select: { id: true },
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.STAFF_ASSIGNED_TO_SESSION,
          entityType: "SessionStaff",
          entityId: row.id,
          actorUserId: actor.id,
          actorRole: actor.role,
          requestId: ctx.requestId,
          sessionId,
          metadata: { staffMemberId, staff: m.name },
        },
        tx
      )
      return { id: row.id, replayed: false }
    }, TX)
  } catch (e) {
    if (isUniqueViolation(e)) {
      const existing = await prisma.sessionStaff.findUnique({
        where: { sessionId_staffMemberId: { sessionId, staffMemberId } },
        select: { id: true },
      })
      if (existing) return { id: existing.id, replayed: true }
    }
    throw e
  }
}

// ── Registros parciales (informativos) ────────────────────────────────

export async function recordPartialTip(
  actor: SessionUser,
  sessionId: string,
  sessionStaffId: string,
  input: PartialTipInput,
  ctx: RequestContext = {}
) {
  const replay = await prisma.staffTipEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, sessionStaffId: true },
  })
  if (replay) {
    if (replay.sessionStaffId !== sessionStaffId)
      throw new ConflictError("Clave de operación reutilizada")
    return { id: replay.id, replayed: true }
  }
  const amount = dec(input.amount)
  try {
    return await prisma.$transaction(async (tx) => {
      const ss = await lockSessionStaffInTx(
        tx,
        sessionId,
        sessionStaffId,
        "registrar propinas"
      )
      if (ss.tipCount?.status === "CONFIRMED")
        throw new BusinessRuleError(
          "El conteo de este empleado ya está confirmado: registra una corrección con motivo."
        )
      const row = await tx.staffTipEntry.create({
        data: {
          sessionStaffId,
          sessionId,
          kind: "PARTIAL",
          amount,
          reason: input.notes ?? null,
          recordedById: actor.id,
          idempotencyKey: input.idempotencyKey,
        },
        select: { id: true },
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.STAFF_TIP_RECORDED,
          entityType: "StaffTipEntry",
          entityId: row.id,
          actorUserId: actor.id,
          actorRole: actor.role,
          requestId: ctx.requestId,
          sessionId,
          idempotencyKey: input.idempotencyKey,
          amount: fmt(amount),
          metadata: {
            staff: ss.staffMember.name,
            partial: true,
            countsInReconciliation: false,
          },
        },
        tx
      )
      return { id: row.id, replayed: false }
    }, TX)
  } catch (e) {
    if (isUniqueViolation(e)) {
      const again = await prisma.staffTipEntry.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true },
      })
      if (again) return { id: again.id, replayed: true }
    }
    throw e
  }
}

// ── Conteo (borrador → confirmado) ────────────────────────────────────

export async function saveTipCountDraft(
  actor: SessionUser,
  sessionId: string,
  sessionStaffId: string,
  input: SaveTipCountInput,
  ctx: RequestContext = {}
) {
  const amount = dec(input.amount)
  return prisma.$transaction(async (tx) => {
    const ss = await lockSessionStaffInTx(
      tx,
      sessionId,
      sessionStaffId,
      "capturar propinas"
    )
    const current = ss.tipCount
    if (current?.status === "CONFIRMED")
      throw new BusinessRuleError(
        "El conteo ya está confirmado: registra una corrección con motivo."
      )
    let version: number
    if (!current) {
      const row = await tx.staffTipCount.create({
        data: {
          sessionStaffId,
          sessionId,
          amount,
          savedById: actor.id,
        },
        select: { version: true },
      })
      version = row.version
    } else {
      if (
        input.expectedVersion !== undefined &&
        input.expectedVersion !== current.version
      )
        throw new ConflictError(
          "Otro usuario modificó este conteo: vuelve a cargarlo."
        )
      const { count } = await tx.staffTipCount.updateMany({
        where: { id: current.id, status: "DRAFT", version: current.version },
        data: {
          amount,
          savedById: actor.id,
          version: { increment: 1 },
        },
      })
      if (count !== 1) throw new ConflictError("El conteo cambió.")
      version = current.version + 1
    }
    await recordAudit(
      {
        action: AUDIT_ACTIONS.STAFF_TIP_COUNT_SAVED,
        entityType: "StaffTipCount",
        entityId: sessionStaffId,
        actorUserId: actor.id,
        actorRole: actor.role,
        requestId: ctx.requestId,
        sessionId,
        amount: fmt(amount),
        metadata: {
          staff: ss.staffMember.name,
          draft: true,
          previous: current ? fmt(dec(current.amount)) : null,
        },
      },
      tx
    )
    return { version, amount: fmt(amount) }
  }, TX)
}

export async function confirmTipCount(
  actor: SessionUser,
  sessionId: string,
  sessionStaffId: string,
  input: ConfirmTipCountInput,
  ctx: RequestContext = {}
) {
  const amount = dec(input.amount)
  if (amount.isZero() && input.zeroConfirmed !== true)
    throw new BusinessRuleError(
      "El empleado no tiene propinas: confirma expresamente el $0."
    )
  return prisma.$transaction(async (tx) => {
    const ss = await lockSessionStaffInTx(
      tx,
      sessionId,
      sessionStaffId,
      "confirmar propinas"
    )
    const c = ss.tipCount
    if (!c) throw new BusinessRuleError("Captura primero el conteo.")
    // Reintento idempotente: mismo conteo ya confirmado.
    if (c.status === "CONFIRMED") {
      if (dec(c.amount).equals(amount) && c.version === input.expectedVersion)
        return { replayed: true }
      throw new ConflictError("El conteo ya está confirmado.")
    }
    if (c.version !== input.expectedVersion || !dec(c.amount).equals(amount))
      throw new ConflictError(
        "El conteo cambió después de capturarlo: revísalo antes de confirmar."
      )
    const operationId = amount.greaterThan(0)
      ? await nominalEffectInTx(
          tx,
          actor,
          {
            amount,
            referenceType: "StaffTipCount",
            referenceId: c.id,
            sessionId,
            idempotencyKey: `tipcount_${c.id}`,
          },
          ctx
        )
      : null
    const { count } = await tx.staffTipCount.updateMany({
      where: { id: c.id, status: "DRAFT", version: c.version },
      data: {
        status: "CONFIRMED",
        confirmedById: actor.id,
        confirmedAt: new Date(),
        chipOperationId: operationId,
      },
    })
    if (count !== 1) throw new ConflictError("El conteo cambió.")
    await recordAudit(
      {
        action: AUDIT_ACTIONS.STAFF_TIP_COUNT_CONFIRMED,
        entityType: "StaffTipCount",
        entityId: c.id,
        actorUserId: actor.id,
        actorRole: actor.role,
        requestId: ctx.requestId,
        sessionId,
        amount: fmt(amount),
        metadata: {
          staffMemberId: ss.staffMember.id,
          staff: ss.staffMember.name,
          chipOperationId: operationId,
        },
      },
      tx
    )
    return { replayed: false }
  }, TX)
}

/** Corrección auditable del conteo confirmado (±, motivo obligatorio). */
export async function correctTipCount(
  actor: SessionUser,
  sessionId: string,
  sessionStaffId: string,
  input: CorrectTipCountInput,
  ctx: RequestContext = {}
) {
  const replay = await prisma.staffTipEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, sessionStaffId: true },
  })
  if (replay) {
    if (replay.sessionStaffId !== sessionStaffId)
      throw new ConflictError("Clave de operación reutilizada")
    return { id: replay.id, replayed: true }
  }
  const amount = dec(input.amount)
  return prisma.$transaction(async (tx) => {
    const ss = await lockSessionStaffInTx(
      tx,
      sessionId,
      sessionStaffId,
      "corregir propinas"
    )
    if (ss.tipCount?.status !== "CONFIRMED")
      throw new BusinessRuleError(
        "Solo se corrige un conteo confirmado (el borrador se edita directamente)."
      )
    const before = await figuresOf(tx, sessionStaffId)
    const after = before.recognized.add(amount)
    if (after.lessThan(0))
      throw new BusinessRuleError(
        `La corrección dejaría las propinas en negativo (reconocido $${fmt(before.recognized)}).`
      )
    const id = `ste_${randomUUID().replace(/-/g, "")}`
    const operationId = await nominalEffectInTx(
      tx,
      actor,
      {
        amount,
        referenceType: "StaffTipEntry",
        referenceId: id,
        sessionId,
        idempotencyKey: `tipfix_${input.idempotencyKey}`,
      },
      ctx
    )
    await tx.staffTipEntry.create({
      data: {
        id,
        sessionStaffId,
        sessionId,
        kind: "CORRECTION",
        amount,
        reason: input.reason,
        chipOperationId: operationId,
        recordedById: actor.id,
        idempotencyKey: input.idempotencyKey,
      },
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.STAFF_TIP_CORRECTED,
        entityType: "StaffTipEntry",
        entityId: id,
        actorUserId: actor.id,
        actorRole: actor.role,
        requestId: ctx.requestId,
        sessionId,
        idempotencyKey: input.idempotencyKey,
        amount: fmt(amount),
        reason: input.reason,
        metadata: {
          staff: ss.staffMember.name,
          originalAmount: fmt(before.recognized),
          correctedAmount: fmt(after),
        },
      },
      tx
    )
    return { id, replayed: false }
  }, TX)
}

// ── Consultas ─────────────────────────────────────────────────────────

export async function getSessionTips(sessionId: string, db: Db = prisma) {
  const session = await db.pokerSession.findUnique({
    where: { id: sessionId },
    select: { id: true, folio: true, status: true },
  })
  if (!session) throw new NotFoundError("Sesión no encontrada")
  const rows = await db.sessionStaff.findMany({
    where: { sessionId },
    orderBy: { createdAt: "asc" },
    include: {
      staffMember: {
        select: { id: true, name: true, position: { select: { name: true } } },
      },
      tipCount: {
        include: {
          savedBy: { select: { name: true } },
          confirmedBy: { select: { name: true } },
        },
      },
      entries: {
        orderBy: { recordedAt: "asc" },
        include: { recordedBy: { select: { name: true } } },
      },
    },
  })
  const staff = rows.map((r) => {
    const f = staffTipFigures({
      count: r.tipCount
        ? { status: r.tipCount.status, amount: dec(r.tipCount.amount) }
        : null,
      entries: r.entries.map((e) => ({ kind: e.kind, amount: dec(e.amount) })),
    })
    return {
      id: r.id,
      staff: {
        id: r.staffMember.id,
        name: r.staffMember.name,
        position: r.staffMember.position.name,
      },
      state: f.state,
      version: r.tipCount?.version ?? null,
      draft: f.draft ? fmt(f.draft) : null,
      confirmedCount: f.confirmedCount ? fmt(f.confirmedCount) : null,
      partials: fmt(f.partials),
      corrections: fmt(f.corrections),
      recognized: f.recognized,
      countVsPartials: f.countVsPartials ? fmt(f.countVsPartials) : null,
      confirmedAt: r.tipCount?.confirmedAt?.toISOString() ?? null,
      confirmedBy: r.tipCount?.confirmedBy?.name ?? null,
      history: r.entries.map((e) => ({
        id: e.id,
        kind: e.kind,
        amount: fmt(dec(e.amount)),
        reason: e.reason,
        at: e.recordedAt.toISOString(),
        by: e.recordedBy.name,
      })),
    }
  })
  return {
    session,
    staff: staff.map((s) => ({ ...s, recognized: fmt(s.recognized) })),
    total: fmt(tipsTotal(staff)),
    unconfirmed: staff.filter((s) => s.state !== "CONFIRMED").length,
  }
}
export type SessionTipsView = Awaited<ReturnType<typeof getSessionTips>>

/** Propinas de la SESIÓN para la conciliación global y el cierre. */
export async function getSessionTipsSummary(db: Db, sessionId: string) {
  const rows = await db.sessionStaff.findMany({
    where: { sessionId },
    select: {
      id: true,
      tipCount: { select: { status: true, amount: true } },
      entries: { select: { kind: true, amount: true } },
    },
  })
  let recognized = ZERO
  let unconfirmed = 0
  for (const r of rows) {
    const f = staffTipFigures({
      count: r.tipCount
        ? { status: r.tipCount.status, amount: dec(r.tipCount.amount) }
        : null,
      entries: r.entries.map((e) => ({ kind: e.kind, amount: dec(e.amount) })),
    })
    recognized = recognized.add(f.recognized)
    if (f.state !== "CONFIRMED") unconfirmed++
  }
  return { staff: rows.length, recognized, unconfirmed }
}
