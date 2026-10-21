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
import {
  AUDIT_ACTIONS,
  recordAudit,
  type AuditAction,
} from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import {
  canTransition,
  CORRECTION_TYPE_META,
  displayStatus,
  isAuthorizerRole,
  selfApprovalBlocked,
  type CorrectionStatusValue,
  type CorrectionTypeValue,
  type TargetType,
} from "@/modules/corrections/correction.rules"
import type {
  CorrectionsQuery,
  CreateCorrectionInput,
} from "@/modules/corrections/correction.schemas"
import { issueFolio } from "@/modules/settings/folio.service"

/**
 * Correcciones financieras excepcionales (Módulo 15).
 *
 * - Cualquier rol solicita y comenta; solo PARTNER/SUPERADMIN deciden
 *   (`corrections:operate`; la ruta lo exige y aquí se revalida el rol).
 * - APROBAR NO MUEVE DINERO: no hay escrituras financieras en este módulo.
 *   EXECUTED solo al ENLAZAR una operación real ya registrada por el
 *   servicio legítimo de su módulo (verificada contra la base).
 * - Concurrencia: la fila se bloquea (`FOR UPDATE`) y se exige la versión
 *   esperada; una decisión es única (`correction_approvals.correctionId`);
 *   una solicitud activa por movimiento (índice parcial); idempotencia por
 *   clave; un trigger impide salir de estados terminales.
 */

type Tx = Prisma.TransactionClient
const TX = { maxWait: 10_000, timeout: 20_000 } as const
const dec = (v: Prisma.Decimal | string | number | null | undefined) =>
  new Prisma.Decimal(v ?? 0)

type TargetInfo = {
  label: string
  sessionId: string | null
  playerId: string | null
  amount: string | null
  /** Por qué el módulo de origen NO permitiría ejecutarla hoy (o null). */
  blocker: string | null
}

/** Carga el movimiento original y evalúa las restricciones de su módulo. */
async function loadTarget(
  db: Tx | typeof prisma,
  type: CorrectionTypeValue,
  targetType: TargetType,
  targetId: string
): Promise<TargetInfo> {
  const meta = CORRECTION_TYPE_META[type]
  if (!meta.targets.includes(targetType))
    throw new BusinessRuleError(
      `El tipo «${meta.label}» no aplica a ${targetType}.`
    )
  switch (targetType) {
    case "ReceivablePayment": {
      const p = await db.receivablePayment.findUnique({
        where: { id: targetId },
        select: {
          folio: true,
          status: true,
          amount: true,
          method: true,
          sessionId: true,
          playerId: true,
          cardSettlementId: true,
        },
      })
      if (!p) throw new NotFoundError("Abono no encontrado")
      let blocker: string | null = null
      if (p.status === "REVERSED") blocker = "El abono ya fue revertido."
      else if (p.status !== "CONFIRMED")
        blocker = "El Módulo 10 solo revierte abonos confirmados."
      else if (p.method === "BANK_TRANSFER")
        blocker =
          "El Módulo 10 no revierte abonos por transferencia (requiere devolución, Módulo 16)."
      else if (p.cardSettlementId)
        blocker = "El cobro de terminal ya se liquidó al banco."
      return {
        label: `Abono ${p.folio}`,
        sessionId: p.sessionId,
        playerId: p.playerId,
        amount: dec(p.amount).toFixed(2),
        blocker,
      }
    }
    case "CashTransaction": {
      const t = await db.cashTransaction.findUnique({
        where: { id: targetId },
        select: {
          folio: true,
          transactionType: true,
          sessionId: true,
          playerId: true,
          reversedBy: { select: { id: true } },
          entries: { select: { amount: true, direction: true } },
        },
      })
      if (!t) throw new NotFoundError("Movimiento de caja no encontrado")
      const session = t.sessionId
        ? await db.pokerSession.findUnique({
            where: { id: t.sessionId },
            select: { status: true },
          })
        : null
      const amount = t.entries
        .filter((e) => e.direction === "DEBIT")
        .reduce((acc, e) => acc.add(e.amount), dec(0))
      let blocker: string | null = null
      if (t.reversedBy) blocker = "El movimiento ya tiene un reverso."
      else if (t.transactionType === "REVERSAL")
        blocker = "Un reverso no se revierte."
      else if (session && ["CLOSED", "CANCELLED"].includes(session.status))
        blocker =
          "La sesión está cerrada: su caja es inmutable (Módulo 12). No se reabre para corregir."
      return {
        label: `Movimiento ${t.folio} (${t.transactionType})`,
        sessionId: t.sessionId,
        playerId: t.playerId,
        amount: amount.toFixed(2),
        blocker,
      }
    }
    case "PlayerSettlement": {
      const s = await db.playerSettlement.findUnique({
        where: { id: targetId },
        select: {
          folio: true,
          status: true,
          sessionId: true,
          playerId: true,
          returnedNominalAmount: true,
          session: { select: { status: true } },
          payouts: { select: { status: true } },
        },
      })
      if (!s) throw new NotFoundError("Liquidación no encontrada")
      const paid = s.payouts.some((p) =>
        ["EXECUTED", "PENDING"].includes(p.status)
      )
      let blocker: string | null = null
      if (s.status === "REVERSED") blocker = "La liquidación ya fue revertida."
      else if (!["PENDING_PAYOUT", "COMPLETED"].includes(s.status))
        blocker = "Solo se revierten liquidaciones recibidas."
      else if (type === "SETTLEMENT_REVERSAL" && paid)
        blocker =
          "Tiene pagos reales o en curso: su reverso es un proceso del Módulo 16."
      else if (type === "SETTLEMENT_REVERSAL" && s.session.status !== "OPEN")
        blocker = "El Módulo 11 solo revierte con la sesión abierta."
      return {
        label: `Liquidación ${s.folio}`,
        sessionId: s.sessionId,
        playerId: s.playerId,
        amount: dec(s.returnedNominalAmount).toFixed(2),
        blocker,
      }
    }
    case "ChipPurchase": {
      const p = await db.chipPurchase.findUnique({
        where: { id: targetId },
        select: {
          folio: true,
          status: true,
          sessionId: true,
          playerId: true,
          nominalAmount: true,
        },
      })
      if (!p) throw new NotFoundError("Compra no encontrada")
      return {
        label: `Compra ${p.folio}`,
        sessionId: p.sessionId,
        playerId: p.playerId,
        amount: dec(p.nominalAmount).toFixed(2),
        blocker:
          p.status === "CONFIRMED"
            ? null
            : "Solo las compras confirmadas requieren reverso.",
      }
    }
    case "UnappliedPlayerFunds": {
      const u = await db.unappliedPlayerFunds.findUnique({
        where: { id: targetId },
        select: { amount: true, playerId: true },
      })
      if (!u) throw new NotFoundError("Fondos no aplicados no encontrados")
      return {
        label: "Fondos recibidos sin aplicar",
        sessionId: null,
        playerId: u.playerId,
        amount: dec(u.amount).toFixed(2),
        blocker: null,
      }
    }
    case "Player": {
      const p = await db.player.findUnique({
        where: { id: targetId },
        select: { name: true },
      })
      if (!p) throw new NotFoundError("Jugador no encontrado")
      return {
        label: `Jugador ${p.name}`,
        sessionId: null,
        playerId: targetId,
        amount: null,
        blocker: null,
      }
    }
  }
}

/** Eventos propios del Módulo 16 al solicitar/aprobar (aprobar no ejecuta). */
const M16_EVENTS: Partial<
  Record<CorrectionTypeValue, { requested: AuditAction; approved: AuditAction }>
> = {
  PURCHASE_REVERSAL: {
    requested: AUDIT_ACTIONS.PURCHASE_REVERSAL_REQUESTED,
    approved: AUDIT_ACTIONS.PURCHASE_REVERSAL_APPROVED,
  },
  SETTLEMENT_REVERSAL_WITH_PAYOUTS: {
    requested: AUDIT_ACTIONS.SETTLEMENT_CORRECTION_REQUESTED,
    approved: AUDIT_ACTIONS.SETTLEMENT_CORRECTION_APPROVED,
  },
}

async function lockCorrection(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "correction_requests" WHERE "id" = ${id} FOR UPDATE`
  if (rows.length === 0) throw new NotFoundError("Solicitud no encontrada")
  return tx.correctionRequest.findUniqueOrThrow({ where: { id } })
}

function assertVersion(current: number, expected: number) {
  if (current !== expected)
    throw new ConflictError(
      "La solicitud cambió mientras la revisabas. Vuelve a cargarla."
    )
}

async function transition(
  tx: Tx,
  row: { id: string; status: CorrectionStatusValue; version: number },
  to: CorrectionStatusValue,
  actorId: string,
  notes: string | null,
  extra: Prisma.CorrectionRequestUncheckedUpdateManyInput = {}
) {
  if (!canTransition(row.status, to))
    throw new BusinessRuleError(`No se puede pasar de ${row.status} a ${to}.`)
  const r = await tx.correctionRequest.updateMany({
    where: { id: row.id, version: row.version },
    data: {
      ...extra,
      status: to,
      version: { increment: 1 },
    },
  })
  if (r.count !== 1) throw new ConflictError("La solicitud cambió de estado.")
  await tx.correctionEvent.create({
    data: {
      correctionId: row.id,
      kind: to === "EXECUTED" ? "EXECUTION_LINKED" : "STATUS_CHANGED",
      fromStatus: row.status,
      toStatus: to,
      notes,
      actorId,
    },
  })
}

function assertAuthorizer(actor: SessionUser) {
  if (!isAuthorizerRole(actor.role))
    throw new ForbiddenError(
      "Solo PARTNER o SUPERADMIN autorizan correcciones excepcionales."
    )
}

// ── Casos de uso ──────────────────────────────────────────────────────

export async function createCorrection(
  actor: SessionUser,
  input: CreateCorrectionInput,
  ctx: RequestContext = {}
) {
  const replay = await prisma.correctionRequest.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, folio: true, type: true, targetId: true },
  })
  if (replay) {
    if (replay.type !== input.type || replay.targetId !== input.targetId)
      throw new ConflictError("Clave de operación reutilizada")
    return { id: replay.id, folio: replay.folio, replayed: true }
  }
  const meta = CORRECTION_TYPE_META[input.type]
  try {
    return await prisma.$transaction(async (tx) => {
      const target = await loadTarget(
        tx,
        input.type,
        input.targetType,
        input.targetId
      )
      const folio = await issueFolio(tx, "CORRECTION")
      const amount = input.amount ?? target.amount
      const created = await tx.correctionRequest.create({
        data: {
          folio,
          type: input.type,
          module: meta.module,
          targetType: input.targetType,
          targetId: input.targetId,
          sessionId: target.sessionId,
          playerId: target.playerId,
          amount,
          reason: input.reason,
          evidenceNote: input.evidenceNote || null,
          requestedById: actor.id,
          idempotencyKey: input.idempotencyKey,
        },
        select: { id: true, folio: true },
      })
      await tx.correctionEvent.create({
        data: {
          correctionId: created.id,
          kind: "CREATED",
          toStatus: "REQUESTED",
          notes: input.reason,
          actorId: actor.id,
        },
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.CORRECTION_REQUESTED,
          entityType: "CorrectionRequest",
          entityId: created.id,
          actorUserId: actor.id,
          actorRole: actor.role,
          requestId: ctx.requestId,
          idempotencyKey: input.idempotencyKey,
          reason: input.reason,
          sessionId: target.sessionId,
          playerId: target.playerId,
          amount,
          metadata: {
            folio,
            type: input.type,
            targetType: input.targetType,
            targetId: input.targetId,
            target: target.label,
            module16: meta.module16,
            moduleBlocker: target.blocker,
          },
        },
        tx
      )
      const m16Requested = M16_EVENTS[input.type]?.requested
      if (m16Requested)
        await recordAudit(
          {
            action: m16Requested,
            entityType: input.targetType,
            entityId: input.targetId,
            actorUserId: actor.id,
            actorRole: actor.role,
            requestId: ctx.requestId,
            reason: input.reason,
            sessionId: target.sessionId,
            playerId: target.playerId,
            amount,
            metadata: { correctionId: created.id, correctionFolio: folio },
          },
          tx
        )
      return { id: created.id, folio: created.folio, replayed: false }
    }, TX)
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await prisma.correctionRequest.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true, folio: true },
      })
      if (again) return { ...again, replayed: true }
      throw new ConflictError(
        "Ya existe una solicitud activa de este tipo para ese movimiento."
      )
    }
    throw error
  }
}

export async function commentCorrection(
  actor: SessionUser,
  id: string,
  notes: string,
  ctx: RequestContext = {}
) {
  await prisma.$transaction(async (tx) => {
    const row = await lockCorrection(tx, id)
    await tx.correctionEvent.create({
      data: { correctionId: id, kind: "COMMENT", notes, actorId: actor.id },
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.CORRECTION_COMMENTED,
        entityType: "CorrectionRequest",
        entityId: id,
        actorUserId: actor.id,
        actorRole: actor.role,
        requestId: ctx.requestId,
        sessionId: row.sessionId,
        playerId: row.playerId,
        metadata: { folio: row.folio },
      },
      tx
    )
  }, TX)
}

export async function markUnderReview(
  actor: SessionUser,
  id: string,
  expectedVersion: number,
  ctx: RequestContext = {}
) {
  assertAuthorizer(actor)
  await prisma.$transaction(async (tx) => {
    const row = await lockCorrection(tx, id)
    assertVersion(row.version, expectedVersion)
    await transition(tx, row, "UNDER_REVIEW", actor.id, null)
    await recordAudit(
      {
        action: AUDIT_ACTIONS.CORRECTION_UNDER_REVIEW,
        entityType: "CorrectionRequest",
        entityId: id,
        actorUserId: actor.id,
        actorRole: actor.role,
        requestId: ctx.requestId,
        metadata: { folio: row.folio },
      },
      tx
    )
  }, TX)
}

/** Aprueba o rechaza (decisión ÚNICA). Aprobar NO ejecuta nada. */
export async function decideCorrection(
  actor: SessionUser,
  id: string,
  decision: "APPROVED" | "REJECTED",
  input: { expectedVersion: number; notes: string },
  ctx: RequestContext = {}
) {
  assertAuthorizer(actor)
  try {
    return await prisma.$transaction(async (tx) => {
      const row = await lockCorrection(tx, id)
      assertVersion(row.version, input.expectedVersion)
      const others = await tx.user.count({
        where: {
          id: { not: actor.id },
          isActive: true,
          role: { in: ["PARTNER", "SUPERADMIN"] },
        },
      })
      if (
        selfApprovalBlocked({
          actorId: actor.id,
          requestedById: row.requestedById,
          otherActiveAuthorizers: others,
        })
      )
        throw new ForbiddenError(
          "No puedes decidir tu propia solicitud: hay otro socio o superadministrador que puede revisarla."
        )
      if (decision === "APPROVED") {
        // DEC-06: la aprobación respeta las restricciones del módulo de origen.
        const target = await loadTarget(
          tx,
          row.type,
          row.targetType as TargetType,
          row.targetId
        )
        const meta = CORRECTION_TYPE_META[row.type]
        if (target.blocker && !meta.module16 && meta.execution)
          throw new BusinessRuleError(
            `El módulo de origen no permite esta corrección: ${target.blocker}`
          )
      }
      await tx.correctionApproval.create({
        data: {
          correctionId: id,
          decision,
          decidedById: actor.id,
          decidedRole: actor.role,
          notes: input.notes,
        },
      })
      await transition(tx, row, decision, actor.id, input.notes)
      await recordAudit(
        {
          action:
            decision === "APPROVED"
              ? AUDIT_ACTIONS.CORRECTION_APPROVED
              : AUDIT_ACTIONS.CORRECTION_REJECTED,
          entityType: "CorrectionRequest",
          entityId: id,
          actorUserId: actor.id,
          actorRole: actor.role,
          requestId: ctx.requestId,
          reason: input.notes,
          sessionId: row.sessionId,
          playerId: row.playerId,
          amount: row.amount?.toFixed(2) ?? null,
          metadata: {
            folio: row.folio,
            type: row.type,
            selfDecision: actor.id === row.requestedById,
            // Aprobar no crea movimientos: queda pendiente de ejecución real.
            financialEffect: "NONE",
          },
        },
        tx
      )
      const m16Approved =
        decision === "APPROVED" ? M16_EVENTS[row.type]?.approved : undefined
      if (m16Approved)
        await recordAudit(
          {
            action: m16Approved,
            entityType: row.targetType,
            entityId: row.targetId,
            actorUserId: actor.id,
            actorRole: actor.role,
            requestId: ctx.requestId,
            reason: input.notes,
            sessionId: row.sessionId,
            playerId: row.playerId,
            metadata: {
              correctionId: id,
              correctionFolio: row.folio,
              financialEffect: "NONE",
            },
          },
          tx
        )
      return { status: decision }
    }, TX)
  } catch (error) {
    if (isUniqueViolation(error))
      throw new ConflictError("La solicitud ya fue decidida por otra persona.")
    throw error
  }
}

/** Verifica que la operación real exista y corresponda al movimiento original. */
async function verifyExecutionReference(
  tx: Tx,
  row: { type: CorrectionTypeValue; targetId: string },
  referenceId: string
) {
  const meta = CORRECTION_TYPE_META[row.type]
  if (!meta.execution) {
    throw new BusinessRuleError(
      "Este tipo no tiene ejecución enlazable: requiere la operación legítima de su módulo."
    )
  }
  switch (meta.execution.referenceType) {
    case "ReceivablePaymentReversal": {
      const r = await tx.receivablePaymentReversal.findUnique({
        where: { id: referenceId },
        select: { paymentId: true, createdById: true, createdAt: true },
      })
      if (!r || r.paymentId !== row.targetId)
        throw new BusinessRuleError(
          "La referencia no es un reverso real de ese abono."
        )
      return { executedById: r.createdById, executedAt: r.createdAt }
    }
    case "CashTransaction": {
      const t = await tx.cashTransaction.findUnique({
        where: { id: referenceId },
        select: {
          transactionType: true,
          reversesTransactionId: true,
          createdById: true,
          createdAt: true,
        },
      })
      if (
        !t ||
        t.transactionType !== "REVERSAL" ||
        t.reversesTransactionId !== row.targetId ||
        !t.createdById
      )
        throw new BusinessRuleError(
          "La referencia no es el reverso real de ese movimiento de caja."
        )
      return { executedById: t.createdById, executedAt: t.createdAt }
    }
    case "SettlementReversal": {
      const r = await tx.settlementReversal.findUnique({
        where: { id: referenceId },
        select: { settlementId: true, createdById: true, createdAt: true },
      })
      if (!r || r.settlementId !== row.targetId)
        throw new BusinessRuleError(
          "La referencia no es el reverso real de esa liquidación."
        )
      return { executedById: r.createdById, executedAt: r.createdAt }
    }
    // Módulo 16: hechos EJECUTADOS (nunca una simple solicitud).
    case "PurchaseReversal": {
      const r = await tx.purchaseReversal.findUnique({
        where: { id: referenceId },
        select: { purchaseId: true, executedById: true, executedAt: true },
      })
      if (!r || r.purchaseId !== row.targetId)
        throw new BusinessRuleError(
          "La referencia no es el reverso ejecutado de esa compra."
        )
      return { executedById: r.executedById, executedAt: r.executedAt }
    }
    case "SettlementCorrection": {
      const r = await tx.settlementCorrection.findUnique({
        where: { id: referenceId },
        select: { settlementId: true, executedById: true, executedAt: true },
      })
      if (!r || r.settlementId !== row.targetId)
        throw new BusinessRuleError(
          "La referencia no es una corrección ejecutada de esa liquidación."
        )
      return { executedById: r.executedById, executedAt: r.executedAt }
    }
    case "UnappliedFundsRefund": {
      const r = await tx.specialPayable.findUnique({
        where: { id: referenceId },
        select: {
          kind: true,
          sourceId: true,
          createdById: true,
          createdAt: true,
        },
      })
      if (!r || r.kind !== "UNAPPLIED_REFUND" || r.sourceId !== row.targetId)
        throw new BusinessRuleError(
          "La referencia no es la obligación de devolución de esos fondos."
        )
      return { executedById: r.createdById, executedAt: r.createdAt }
    }
    case "LateChipRedemption": {
      const r = await tx.lateChipRedemption.findUnique({
        where: { id: referenceId },
        select: {
          playerId: true,
          chipOperationId: true,
          receivedById: true,
          receivedAt: true,
        },
      })
      if (
        !r ||
        r.playerId !== row.targetId ||
        !r.chipOperationId ||
        !r.receivedById ||
        !r.receivedAt
      )
        throw new BusinessRuleError(
          "La referencia no es un canje con fichas recibidas de ese jugador."
        )
      return { executedById: r.receivedById, executedAt: r.receivedAt }
    }
  }
}

/**
 * Módulo 16: exige, DENTRO de la transacción del ejecutor, una solicitud
 * APROBADA (o FAILED reintentable) del tipo y objetivo exactos. Bloquea la
 * solicitud para que dos ejecuciones no la usen a la vez.
 */
export async function requireApprovedCorrectionInTx(
  tx: Tx,
  correctionId: string,
  expected: { type: CorrectionTypeValue; targetId: string }
) {
  const row = await lockCorrection(tx, correctionId)
  if (row.type !== expected.type || row.targetId !== expected.targetId)
    throw new BusinessRuleError(
      "La solicitud de corrección no corresponde a esta operación."
    )
  if (row.status !== "APPROVED" && row.status !== "FAILED")
    throw new BusinessRuleError(
      row.status === "EXECUTED"
        ? "La solicitud de corrección ya fue ejecutada."
        : "Requiere una solicitud de corrección APROBADA por PARTNER o SUPERADMIN."
    )
  return row
}

/**
 * Módulo 16: enlaza la ejecución REAL recién registrada en la MISMA
 * transacción (la solicitud nunca queda EXECUTED si la operación falla).
 */
export async function linkExecutionInTx(
  tx: Tx,
  actor: SessionUser,
  row: Awaited<ReturnType<typeof requireApprovedCorrectionInTx>>,
  referenceId: string,
  notes: string | null,
  ctx: RequestContext = {}
) {
  const meta = CORRECTION_TYPE_META[row.type]
  const ref = await verifyExecutionReference(tx, row, referenceId)
  await transition(tx, row, "EXECUTED", actor.id, notes, {
    executionReferenceType: meta.execution!.referenceType,
    executionReferenceId: referenceId,
    executedById: ref.executedById,
    executedAt: ref.executedAt,
    executionNotes: notes,
  })
  await recordAudit(
    {
      action: AUDIT_ACTIONS.CORRECTION_EXECUTION_LINKED,
      entityType: "CorrectionRequest",
      entityId: row.id,
      actorUserId: actor.id,
      actorRole: actor.role,
      requestId: ctx.requestId,
      sessionId: row.sessionId,
      playerId: row.playerId,
      metadata: {
        folio: row.folio,
        referenceType: meta.execution!.referenceType,
        referenceId,
        executedById: ref.executedById,
        automatic: true,
      },
    },
    tx
  )
}

/**
 * Enlaza la ejecución REAL (operación ya registrada por su módulo). Solo
 * aquí una solicitud pasa a EXECUTED. No crea ningún movimiento.
 */
export async function linkExecution(
  actor: SessionUser,
  id: string,
  input: { expectedVersion: number; referenceId: string; notes?: string },
  ctx: RequestContext = {}
) {
  assertAuthorizer(actor)
  try {
    return await prisma.$transaction(async (tx) => {
      const row = await lockCorrection(tx, id)
      assertVersion(row.version, input.expectedVersion)
      if (row.status !== "APPROVED" && row.status !== "FAILED")
        throw new BusinessRuleError(
          "Solo una solicitud aprobada puede marcarse como ejecutada."
        )
      const meta = CORRECTION_TYPE_META[row.type]
      const ref = await verifyExecutionReference(tx, row, input.referenceId)
      await transition(tx, row, "EXECUTED", actor.id, input.notes ?? null, {
        executionReferenceType: meta.execution!.referenceType,
        executionReferenceId: input.referenceId,
        executedById: ref.executedById,
        executedAt: ref.executedAt,
        executionNotes: input.notes ?? null,
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.CORRECTION_EXECUTION_LINKED,
          entityType: "CorrectionRequest",
          entityId: id,
          actorUserId: actor.id,
          actorRole: actor.role,
          requestId: ctx.requestId,
          sessionId: row.sessionId,
          playerId: row.playerId,
          metadata: {
            folio: row.folio,
            referenceType: meta.execution!.referenceType,
            referenceId: input.referenceId,
            executedById: ref.executedById,
          },
        },
        tx
      )
      return { status: "EXECUTED" as const }
    }, TX)
  } catch (error) {
    if (isUniqueViolation(error))
      throw new ConflictError(
        "Esa operación ya está enlazada a otra solicitud."
      )
    throw error
  }
}

/** El servicio del módulo rechazó la operación: se registra el fallo real. */
export async function markExecutionFailed(
  actor: SessionUser,
  id: string,
  input: { expectedVersion: number; notes: string },
  ctx: RequestContext = {}
) {
  assertAuthorizer(actor)
  await prisma.$transaction(async (tx) => {
    const row = await lockCorrection(tx, id)
    assertVersion(row.version, input.expectedVersion)
    await transition(tx, row, "FAILED", actor.id, input.notes, {
      executionNotes: input.notes,
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.CORRECTION_EXECUTION_FAILED,
        entityType: "CorrectionRequest",
        entityId: id,
        actorUserId: actor.id,
        actorRole: actor.role,
        requestId: ctx.requestId,
        reason: input.notes,
        metadata: { folio: row.folio },
      },
      tx
    )
  }, TX)
}

export async function cancelCorrection(
  actor: SessionUser,
  id: string,
  input: { expectedVersion: number; notes: string },
  ctx: RequestContext = {}
) {
  await prisma.$transaction(async (tx) => {
    const row = await lockCorrection(tx, id)
    assertVersion(row.version, input.expectedVersion)
    if (row.requestedById !== actor.id && !isAuthorizerRole(actor.role))
      throw new ForbiddenError(
        "Solo quien la solicitó o un socio/superadministrador puede cancelarla."
      )
    await transition(tx, row, "CANCELLED", actor.id, input.notes)
    await recordAudit(
      {
        action: AUDIT_ACTIONS.CORRECTION_CANCELLED,
        entityType: "CorrectionRequest",
        entityId: id,
        actorUserId: actor.id,
        actorRole: actor.role,
        requestId: ctx.requestId,
        reason: input.notes,
        metadata: { folio: row.folio },
      },
      tx
    )
  }, TX)
}

// ── Consultas ─────────────────────────────────────────────────────────

const listSelect = {
  id: true,
  folio: true,
  type: true,
  module: true,
  targetType: true,
  targetId: true,
  amount: true,
  status: true,
  version: true,
  requestedAt: true,
  requestedBy: { select: { id: true, name: true, role: true } },
  approval: {
    select: {
      decision: true,
      decidedAt: true,
      decidedRole: true,
      decidedBy: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.CorrectionRequestSelect

type ListRow = Prisma.CorrectionRequestGetPayload<{ select: typeof listSelect }>

const SPECIAL_BASE = "/dashboard/operaciones-especiales"
function specialOperationHref(r: {
  id: string
  type: CorrectionTypeValue
  targetId: string
}) {
  switch (r.type) {
    case "PURCHASE_REVERSAL":
      return `${SPECIAL_BASE}/reversos-compras/nuevo?purchaseId=${r.targetId}&correctionId=${r.id}`
    case "SETTLEMENT_REVERSAL_WITH_PAYOUTS":
      return `${SPECIAL_BASE}/correcciones-liquidaciones/nuevo?settlementId=${r.targetId}&correctionId=${r.id}`
    case "UNAPPLIED_FUNDS_RETURN":
      return `${SPECIAL_BASE}/fondos-no-aplicados/${r.targetId}`
    case "LATE_CHIP_REDEMPTION":
      return `${SPECIAL_BASE}/canjes`
    default:
      return null
  }
}

function listView(r: ListRow) {
  const meta = CORRECTION_TYPE_META[r.type]
  return {
    id: r.id,
    folio: r.folio,
    type: r.type,
    typeLabel: meta.label,
    module: r.module,
    module16: meta.module16,
    // Los procesos del Módulo 16 se ejecutan en su pantalla (que enlaza la
    // solicitud en la misma transacción); no se enlazan a mano.
    executable: meta.execution !== null && !meta.module16,
    specialOperationHref: specialOperationHref(r),
    targetType: r.targetType,
    targetId: r.targetId,
    amount: r.amount ? r.amount.toFixed(2) : null,
    status: r.status,
    statusLabel: displayStatus(r.status, r.type),
    version: r.version,
    requestedAt: r.requestedAt.toISOString(),
    requestedBy: r.requestedBy,
    decision: r.approval
      ? {
          decision: r.approval.decision,
          decidedAt: r.approval.decidedAt.toISOString(),
          decidedRole: r.approval.decidedRole,
          decidedBy: r.approval.decidedBy,
        }
      : null,
  }
}

export async function listCorrections(q: CorrectionsQuery) {
  const where: Prisma.CorrectionRequestWhereInput = {
    ...(q.status && { status: q.status }),
    ...(q.type && { type: q.type }),
  }
  const [total, rows] = await Promise.all([
    prisma.correctionRequest.count({ where }),
    prisma.correctionRequest.findMany({
      where,
      select: listSelect,
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
  ])
  return {
    page: q.page,
    pageSize: q.pageSize,
    total,
    items: rows.map(listView),
  }
}

export async function getCorrection(id: string) {
  const r = await prisma.correctionRequest.findUnique({
    where: { id },
    select: {
      ...listSelect,
      reason: true,
      evidenceNote: true,
      sessionId: true,
      playerId: true,
      executionReferenceType: true,
      executionReferenceId: true,
      executedAt: true,
      executionNotes: true,
      executedBy: { select: { id: true, name: true } },
      approval: {
        select: {
          decision: true,
          decidedAt: true,
          decidedRole: true,
          notes: true,
          decidedBy: { select: { id: true, name: true } },
        },
      },
      events: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          kind: true,
          fromStatus: true,
          toStatus: true,
          notes: true,
          createdAt: true,
          actor: { select: { id: true, name: true } },
        },
      },
    },
  })
  if (!r) throw new NotFoundError("Solicitud no encontrada")
  const target = await loadTarget(
    prisma,
    r.type,
    r.targetType as TargetType,
    r.targetId
  ).catch(() => null)
  const meta = CORRECTION_TYPE_META[r.type]
  return {
    ...listView(r),
    reason: r.reason,
    evidenceNote: r.evidenceNote,
    sessionId: r.sessionId,
    playerId: r.playerId,
    target: target
      ? { label: target.label, moduleBlocker: target.blocker }
      : null,
    executionService: meta.execution?.service ?? null,
    executionReference: r.executionReferenceId
      ? {
          type: r.executionReferenceType,
          id: r.executionReferenceId,
          executedAt: r.executedAt?.toISOString() ?? null,
          executedBy: r.executedBy,
          notes: r.executionNotes,
        }
      : null,
    decisionNotes: r.approval?.notes ?? null,
    events: r.events.map((e) => ({
      ...e,
      createdAt: e.createdAt.toISOString(),
    })),
  }
}

export type CorrectionDetail = Awaited<ReturnType<typeof getCorrection>>
