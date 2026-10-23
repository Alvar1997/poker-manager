import "server-only"

import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@/lib/errors"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import { can, PERMISSIONS } from "@/config/permissions"
import { AUDIT_ACTIONS } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import { createSpecialPayableInTx } from "@/modules/special-operations/special-payout.service"

import {
  advancesOfCycle,
  audit,
  auditBankingFailure,
  BANKING_TX,
  CLOSING_SOURCE,
  effectiveResult,
  hashOf,
  loadCycleFacts,
  lockBankingRow,
  lockPlayerInTx,
  pendingRecoveriesOf,
  previousCarriedLoss,
  refreshCycleStatusInTx,
  reserveBalanceOf,
  type Tx,
} from "./banking-core"
import {
  computeCycle,
  cycleResultToJson,
  dec,
  distributeRecovery,
  fmt,
  GAMES_PER_CYCLE,
  segmentForGame,
  validateDistribution,
  ZERO,
  type Allocation,
} from "./banking.math"
import type { PrepareClosingInput } from "./banking.schemas"

/**
 * Corte de cuatro jugadas (Módulo 17).
 *   CASHIER (o socio) PREPARA: el servidor calcula todo con hechos reales
 *   y guarda una VERSIÓN con snapshot + huella. Si hay pérdidas entre tramos
 *   con porcentajes distintos, la distribución la decide un PARTNER o
 *   SUPERADMIN al preparar (nunca CASHIER).
 *   PARTNER/SUPERADMIN APRUEBA DIGITALMENTE esa versión: se recalcula en la
 *   misma transacción y debe dar la MISMA huella (si cambió una jugada,
 *   porcentaje, reserva, anticipo o recuperación → 409 y la versión queda
 *   SUPERSEDED). Efectos (una sola vez): reserva consumida, reserva creada,
 *   recuperaciones, obligación por pagar (Módulo 16) y pérdida arrastrada.
 *   Ningún efecto mueve dinero: los pagos son desembolsos posteriores.
 */

type Snapshot = Awaited<ReturnType<typeof buildSnapshot>>

/** Recalcula el corte desde los hechos actuales (preparar y aprobar). */
async function buildSnapshot(
  tx: Tx,
  cycleId: string,
  proposal: {
    reserveAmount: string
    payAmount: string
    lossAllocation: Allocation | null
  }
) {
  const f = await loadCycleFacts(tx, cycleId)
  if (f.games.length !== GAMES_PER_CYCLE || f.unsettled)
    throw new BusinessRuleError(
      "El corte requiere las cuatro jugadas CONFIRMADAS (sin discrepancias ni correcciones)."
    )
  const carried = await previousCarriedLoss(
    tx,
    f.cycle.playerId,
    f.cycle.number
  )
  if (carried === null)
    throw new BusinessRuleError(
      "El corte del ciclo anterior no está aprobado: apruébalo primero."
    )
  const adv = await advancesOfCycle(tx, cycleId)
  if (adv.unresolved > 0)
    throw new BusinessRuleError(
      "Hay anticipos del ciclo sin pagar por completo o sin cerrar (o transferencias en trámite): resuélvelos antes del corte."
    )
  const reserve = await reserveBalanceOf(tx, f.cycle.playerId)
  const recovery = await pendingRecoveriesOf(tx, f.cycle.playerId)
  const r = computeCycle({
    games: f.facts,
    previousCarriedLoss: carried,
    reserveAvailable: reserve,
    advancesPaid: adv.paid,
    pendingRecovery: recovery.total,
    allocation: proposal.lossAllocation,
  })
  const reserveAmount = dec(proposal.reserveAmount)
  const payAmount = dec(proposal.payAmount)
  const distributionErrors = validateDistribution(r, reserveAmount, payAmount)
  const content = {
    cycleId,
    cycleNumber: f.cycle.number,
    player: f.cycle.player,
    games: f.games.map((g) => {
      const seg = segmentForGame(f.segments, g.gameNumber)
      return {
        id: g.id,
        gameNumber: g.gameNumber,
        sessionId: g.sessionId,
        sessionFolio: g.session.folio,
        businessDate: g.session.businessDate.toISOString().slice(0, 10),
        financed: fmt(dec(g.financedNominal)),
        returned: fmt(dec(g.returnedNominal)),
        zeroReturnConfirmed: g.zeroReturnConfirmed,
        grossResult: fmt(dec(g.grossResult)),
        adjustments: g.adjustments.map((a) => ({
          id: a.id,
          amount: fmt(dec(a.amount)),
        })),
        effectiveResult: fmt(effectiveResult(g)),
        playerPercent: fmt(seg.playerPercent),
        segmentId: seg.id,
        purchases: g.sources
          .map((s) => ({
            purchaseId: s.purchaseId,
            nominal: fmt(dec(s.nominalAmount)),
          }))
          .sort((a, b) => a.purchaseId.localeCompare(b.purchaseId)),
      }
    }),
    advances: adv.rows.map((x) => ({
      id: x.advance.id,
      authorized: fmt(dec(x.advance.authorizedAmount)),
      paid: fmt(x.totals.executed),
      authorizerName: x.advance.authorizerName,
      channel: x.advance.channel,
    })),
    recoveries: distributeRecovery(r.recoveryApplied, recovery.list).map(
      (x) => ({ regularizationId: x.id, amount: fmt(x.amount) })
    ),
    computation: cycleResultToJson(r),
    lossAllocation: proposal.lossAllocation,
    reserveAmount: fmt(reserveAmount),
    payAmount: fmt(payAmount),
  }
  return {
    content,
    hash: hashOf(content),
    result: r,
    reserveAmount,
    payAmount,
    distributionErrors,
    playerId: f.cycle.playerId,
    recoveryList: recovery.list,
  }
}

export async function prepareClosing(
  actor: SessionUser,
  cycleId: string,
  input: PrepareClosingInput,
  ctx: RequestContext = {}
) {
  const previous = await prisma.bankingCycleClosing.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, cycleId: true },
  })
  if (previous) {
    if (previous.cycleId !== cycleId)
      throw new ConflictError("Clave de operación reutilizada")
    return { closingId: previous.id, replayed: true }
  }
  const cycleHead = await prisma.bankingCycle.findUnique({
    where: { id: cycleId },
    select: { playerId: true },
  })
  if (!cycleHead) throw new NotFoundError("Ciclo no encontrado")
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPlayerInTx(tx, cycleHead.playerId)
      await lockBankingRow(tx, "banking_cycles", cycleId)
      const cycle = await tx.bankingCycle.findUniqueOrThrow({
        where: { id: cycleId },
      })
      if (cycle.status === "CLOSED")
        throw new BusinessRuleError("El ciclo ya está cerrado.")
      const snap = await buildSnapshot(tx, cycleId, {
        reserveAmount: input.reserveAmount,
        payAmount: input.payAmount,
        lossAllocation: input.lossAllocation ?? null,
      })
      if (snap.result.allocationRequired && input.lossAllocation) {
        if (!can(actor, PERMISSIONS.BANKING_APPROVE))
          throw new ForbiddenError(
            "Solo un PARTNER o SUPERADMIN decide la distribución de pérdidas entre tramos."
          )
      }
      const errors = [
        ...snap.result.allocationErrors,
        ...snap.distributionErrors,
      ]
      if (errors.length > 0)
        throw new BusinessRuleError(errors.join(" "), {
          balance: fmt(snap.result.balance),
          excessAdvance: fmt(snap.result.excessAdvance),
          allocationRequired: snap.result.allocationRequired,
        })
      // Una sola versión en revisión: la anterior queda SUPERSEDED.
      const open = await tx.bankingCycleClosing.findMany({
        where: { cycleId, status: "UNDER_REVIEW" },
        select: { id: true },
      })
      for (const o of open)
        await tx.bankingCycleClosing.update({
          where: { id: o.id },
          data: {
            status: "SUPERSEDED",
            decisionNotes: "Reemplazada por una nueva preparación",
          },
        })
      const last = await tx.bankingCycleClosing.aggregate({
        where: { cycleId },
        _max: { version: true },
      })
      const r = snap.result
      const closing = await tx.bankingCycleClosing.create({
        data: {
          cycleId,
          version: (last._max.version ?? 0) + 1,
          snapshot: snap.content as never,
          snapshotHash: snap.hash,
          grossTotal: r.grossTotal,
          previousCarriedLoss: r.previousCarriedLoss,
          reserveBefore: r.reserveBefore,
          reserveConsumed: r.reserveConsumed,
          playerShare: r.playerShare,
          houseShare: r.houseShare,
          advancesPaid: r.advancesPaid,
          recoveryApplied: r.recoveryApplied,
          excessAdvance: r.excessAdvance,
          reserveAmount: snap.reserveAmount,
          payAmount: snap.payAmount,
          carriedLossOut: r.carriedLossOut,
          lossAllocation: (input.lossAllocation ?? undefined) as never,
          notes: input.notes ?? null,
          preparedById: actor.id,
          idempotencyKey: input.idempotencyKey,
        },
      })
      await refreshCycleStatusInTx(tx, cycleId)
      await audit(tx, actor, ctx, AUDIT_ACTIONS.BANKING_CLOSING_PREPARED, {
        entityType: "BankingCycleClosing",
        entityId: closing.id,
        playerId: cycleHead.playerId,
        amount: fmt(r.playerShare),
        idempotencyKey: input.idempotencyKey,
        metadata: {
          cycleId,
          version: closing.version,
          snapshotDigest: snap.hash,
          grossTotal: fmt(r.grossTotal),
          playerShare: fmt(r.playerShare),
          reserveAmount: fmt(snap.reserveAmount),
          payAmount: fmt(snap.payAmount),
          carriedLossOut: fmt(r.carriedLossOut),
          excessAdvance: fmt(r.excessAdvance),
        },
      })
      if (r.allocationRequired)
        await audit(tx, actor, ctx, AUDIT_ACTIONS.BANKING_LOSS_ALLOCATED, {
          entityType: "BankingCycleClosing",
          entityId: closing.id,
          playerId: cycleHead.playerId,
          metadata: {
            cycleId,
            allocation: input.lossAllocation,
            lossesToCover: fmt(r.lossesToCover),
          },
        })
      return { closingId: closing.id, replayed: false, snapshotHash: snap.hash }
    }, BANKING_TX)
  } catch (error) {
    if (isUniqueViolation(error))
      throw new ConflictError(
        "Otro corte se preparó al mismo tiempo: revisa la versión vigente."
      )
    await auditBankingFailure(actor, "BankingCycle", cycleId, error, ctx)
    throw error
  }
}

/**
 * APROBACIÓN DIGITAL (PARTNER o SUPERADMIN con sesión iniciada). El rol se
 * revalida aquí además de en la ruta: un CASHIER es rechazado y auditado.
 */
export async function approveClosing(
  actor: SessionUser,
  cycleId: string,
  input: {
    closingId: string
    snapshotHash: string
    notes?: string
    idempotencyKey: string
  },
  ctx: RequestContext = {}
) {
  if (!can(actor, PERMISSIONS.BANKING_APPROVE)) {
    const e = new ForbiddenError(
      "Solo un PARTNER o SUPERADMIN aprueba digitalmente un corte."
    )
    await auditBankingFailure(
      actor,
      "BankingCycleClosing",
      input.closingId,
      e,
      ctx,
      true
    )
    throw e
  }
  const previous = await prisma.bankingCycleClosing.findUnique({
    where: { approveIdempotencyKey: input.idempotencyKey },
    select: { id: true },
  })
  if (previous) {
    if (previous.id !== input.closingId)
      throw new ConflictError("Clave de operación reutilizada")
    return { replayed: true }
  }
  const cycleHead = await prisma.bankingCycle.findUnique({
    where: { id: cycleId },
    select: { playerId: true },
  })
  if (!cycleHead) throw new NotFoundError("Ciclo no encontrado")
  const playerId = cycleHead.playerId
  let stale = false
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPlayerInTx(tx, playerId)
      await lockBankingRow(tx, "banking_cycles", cycleId)
      await lockBankingRow(tx, "banking_cycle_closings", input.closingId)
      const closing = await tx.bankingCycleClosing.findUniqueOrThrow({
        where: { id: input.closingId },
      })
      if (closing.cycleId !== cycleId)
        throw new NotFoundError("Corte no encontrado")
      if (closing.status === "APPROVED")
        throw new ConflictError("Este corte ya fue aprobado.")
      if (closing.status !== "UNDER_REVIEW")
        throw new ConflictError(
          "Esta versión del corte ya no está en revisión: prepara o revisa la vigente."
        )
      if (closing.snapshotHash !== input.snapshotHash)
        throw new ConflictError(
          "Aprobaste una versión distinta de la que está en revisión. Revisa el corte vigente."
        )
      const snap = await buildSnapshot(tx, cycleId, {
        reserveAmount: closing.reserveAmount.toFixed(2),
        payAmount: closing.payAmount.toFixed(2),
        lossAllocation: (closing.lossAllocation as Allocation | null) ?? null,
      })
      if (snap.hash !== closing.snapshotHash) {
        stale = true
        throw new ConflictError(
          "Los datos del ciclo cambiaron desde que se preparó el corte (jugada, porcentaje, reserva, anticipo o recuperación). Prepara una versión nueva."
        )
      }
      const r = snap.result
      const now = new Date()
      if (r.reserveConsumed.greaterThan(0)) {
        await tx.bankingReserveMovement.create({
          data: {
            playerId,
            kind: "CONSUMED_BY_LOSS",
            amount: r.reserveConsumed,
            closingId: closing.id,
            uniqueKey: `closing:${cycleId}:consumed`,
            notes: "Reserva aplicada a pérdidas del ciclo",
            createdById: actor.id,
          },
        })
        await audit(tx, actor, ctx, AUDIT_ACTIONS.BANKING_RESERVE_APPLIED, {
          entityType: "BankingCycleClosing",
          entityId: closing.id,
          playerId,
          amount: fmt(r.reserveConsumed),
          metadata: { cycleId, reserveBefore: fmt(r.reserveBefore) },
        })
      }
      if (snap.reserveAmount.greaterThan(0)) {
        await tx.bankingReserveMovement.create({
          data: {
            playerId,
            kind: "CREATED",
            amount: snap.reserveAmount,
            closingId: closing.id,
            uniqueKey: `closing:${cycleId}:created`,
            notes: "Reserva creada en el corte",
            createdById: actor.id,
          },
        })
        await audit(tx, actor, ctx, AUDIT_ACTIONS.BANKING_RESERVE_CREATED, {
          entityType: "BankingCycleClosing",
          entityId: closing.id,
          playerId,
          amount: fmt(snap.reserveAmount),
          metadata: { cycleId },
        })
      }
      for (const rec of distributeRecovery(
        r.recoveryApplied,
        snap.recoveryList
      )) {
        await tx.bankingRegularizationRecovery.create({
          data: {
            regularizationId: rec.id,
            closingId: closing.id,
            amount: rec.amount,
          },
        })
        const left = snap.recoveryList
          .find((x) => x.id === rec.id)!
          .remaining.sub(rec.amount)
        if (!left.greaterThan(0))
          await tx.bankingRegularization.update({
            where: { id: rec.id },
            data: {
              status: "RESOLVED",
              resolvedAt: now,
              resolvedById: actor.id,
              version: { increment: 1 },
            },
          })
      }
      let payableId: string | null = null
      if (snap.payAmount.greaterThan(0)) {
        const player = await tx.player.findUniqueOrThrow({
          where: { id: playerId },
          select: { name: true },
        })
        const open = await tx.pokerSession.findFirst({
          where: { status: "OPEN" },
          select: { id: true },
        })
        const payable = await createSpecialPayableInTx(tx, actor, {
          kind: "BANKING_CYCLE_PAYOUT",
          sourceType: CLOSING_SOURCE,
          sourceId: `${closing.id}:1`,
          playerId,
          beneficiaryName: player.name,
          sessionId: open?.id ?? null,
          amount: snap.payAmount,
        })
        payableId = payable.id
      }
      if (r.excessAdvance.greaterThan(0)) {
        const reg = await tx.bankingRegularization.create({
          data: {
            playerId,
            cycleId,
            closingId: closing.id,
            kind: "EXCESS_ADVANCE",
            amount: r.excessAdvance,
            description: `Anticipos pagados ($${fmt(r.advancesPaid)}) mayores que la participación definitiva ($${fmt(r.playerShare)}).`,
            openedById: actor.id,
          },
        })
        await audit(
          tx,
          actor,
          ctx,
          AUDIT_ACTIONS.BANKING_EXCESS_ADVANCE_DETECTED,
          {
            entityType: "BankingRegularization",
            entityId: reg.id,
            playerId,
            amount: fmt(r.excessAdvance),
            metadata: { cycleId, stage: "CLOSING_APPROVED" },
          }
        )
        await audit(
          tx,
          actor,
          ctx,
          AUDIT_ACTIONS.BANKING_REGULARIZATION_REQUESTED,
          {
            entityType: "BankingRegularization",
            entityId: reg.id,
            playerId,
            amount: fmt(r.excessAdvance),
            metadata: { kind: "EXCESS_ADVANCE", cycleId },
          }
        )
      }
      await tx.bankingCycleClosing.update({
        where: { id: closing.id },
        data: {
          status: "APPROVED",
          decidedById: actor.id,
          decidedAt: now,
          decisionNotes: input.notes ?? null,
          payableId,
          approveIdempotencyKey: input.idempotencyKey,
        },
      })
      await tx.bankingCycle.update({
        where: { id: cycleId },
        data: { status: "CLOSED", closedAt: now },
      })
      await audit(tx, actor, ctx, AUDIT_ACTIONS.BANKING_CLOSING_APPROVED, {
        entityType: "BankingCycleClosing",
        entityId: closing.id,
        playerId,
        amount: fmt(snap.payAmount),
        idempotencyKey: input.idempotencyKey,
        metadata: {
          cycleId,
          version: closing.version,
          snapshotDigest: closing.snapshotHash,
          approverRole: actor.role,
          preparedBy: closing.preparedById,
          playerShare: fmt(r.playerShare),
          houseShare: fmt(r.houseShare),
          reserveAmount: fmt(snap.reserveAmount),
          payAmount: fmt(snap.payAmount),
          reserveConsumed: fmt(r.reserveConsumed),
          carriedLossOut: fmt(r.carriedLossOut),
          excessAdvance: fmt(r.excessAdvance),
          payableId,
        },
      })
      await audit(tx, actor, ctx, AUDIT_ACTIONS.BANKING_CYCLE_CLOSED, {
        entityType: "BankingCycle",
        entityId: cycleId,
        playerId,
        metadata: { closingId: closing.id },
      })
      return { replayed: false, payableId }
    }, BANKING_TX)
  } catch (error) {
    if (stale)
      await markStale(actor, input.closingId, playerId, ctx).catch(() => {})
    if (isUniqueViolation(error))
      throw new ConflictError(
        "El corte ya fue aprobado por otra persona (una sola aprobación por ciclo)."
      )
    await auditBankingFailure(
      actor,
      "BankingCycleClosing",
      input.closingId,
      error,
      ctx
    )
    throw error
  }
}

/** La versión revisada ya no corresponde a los datos actuales: SUPERSEDED. */
async function markStale(
  actor: SessionUser,
  closingId: string,
  playerId: string,
  ctx: RequestContext
) {
  await prisma.$transaction(async (tx) => {
    await lockPlayerInTx(tx, playerId)
    const c = await tx.bankingCycleClosing.findUniqueOrThrow({
      where: { id: closingId },
      select: { status: true, cycleId: true, version: true },
    })
    if (c.status !== "UNDER_REVIEW") return
    await tx.bankingCycleClosing.update({
      where: { id: closingId },
      data: {
        status: "SUPERSEDED",
        decisionNotes: "Datos cambiaron antes de aprobar",
      },
    })
    await refreshCycleStatusInTx(tx, c.cycleId)
    await audit(tx, actor, ctx, AUDIT_ACTIONS.BANKING_CLOSING_SUPERSEDED, {
      entityType: "BankingCycleClosing",
      entityId: closingId,
      playerId,
      metadata: { cycleId: c.cycleId, version: c.version, reason: "stale" },
    })
  }, BANKING_TX)
}

export async function rejectClosing(
  actor: SessionUser,
  cycleId: string,
  input: { closingId: string; notes: string; idempotencyKey: string },
  ctx: RequestContext = {}
) {
  const cycleHead = await prisma.bankingCycle.findUnique({
    where: { id: cycleId },
    select: { playerId: true },
  })
  if (!cycleHead) throw new NotFoundError("Ciclo no encontrado")
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPlayerInTx(tx, cycleHead.playerId)
      await lockBankingRow(tx, "banking_cycle_closings", input.closingId)
      const c = await tx.bankingCycleClosing.findUniqueOrThrow({
        where: { id: input.closingId },
      })
      if (c.cycleId !== cycleId) throw new NotFoundError("Corte no encontrado")
      if (c.status === "REJECTED") return { replayed: true }
      if (c.status !== "UNDER_REVIEW")
        throw new ConflictError(
          "Esta versión del corte ya no está en revisión."
        )
      await tx.bankingCycleClosing.update({
        where: { id: c.id },
        data: {
          status: "REJECTED",
          decidedById: actor.id,
          decidedAt: new Date(),
          decisionNotes: input.notes,
        },
      })
      await refreshCycleStatusInTx(tx, cycleId)
      await audit(tx, actor, ctx, AUDIT_ACTIONS.BANKING_CLOSING_REJECTED, {
        entityType: "BankingCycleClosing",
        entityId: c.id,
        playerId: cycleHead.playerId,
        reason: input.notes,
        metadata: { cycleId, version: c.version },
      })
      return { replayed: false }
    }, BANKING_TX)
  } catch (error) {
    await auditBankingFailure(
      actor,
      "BankingCycleClosing",
      input.closingId,
      error,
      ctx
    )
    throw error
  }
}

/** Vista previa (sin escribir) para la pantalla de corte. */
export async function previewClosing(
  cycleId: string,
  proposal: {
    reserveAmount?: string
    payAmount?: string
    lossAllocation?: Allocation | null
  } = {}
) {
  return prisma.$transaction(async (tx) => {
    const snap = await buildSnapshot(tx, cycleId, {
      reserveAmount: proposal.reserveAmount ?? "0",
      payAmount: proposal.payAmount ?? "0",
      lossAllocation: proposal.lossAllocation ?? null,
    })
    return {
      content: snap.content,
      distributionErrors: snap.distributionErrors,
      allocationRequired: snap.result.allocationRequired,
      allocationErrors: snap.result.allocationErrors,
      balance: fmt(snap.result.balance),
      excessAdvance: fmt(snap.result.excessAdvance),
    }
  }, BANKING_TX)
}

export type ClosingPreview = Awaited<ReturnType<typeof previewClosing>>
export type { Snapshot }
export { ZERO }
