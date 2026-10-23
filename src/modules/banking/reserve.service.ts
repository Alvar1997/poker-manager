import "server-only"

import { BusinessRuleError, ConflictError, NotFoundError } from "@/lib/errors"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"

import {
  audit,
  auditBankingFailure,
  BANKING_TX,
  lockBankingRow,
  lockPlayerInTx,
  payablesOfSource,
  payoutTotals,
  reserveStateOf,
  supersedeOpenClosingsInTx,
  WITHDRAWAL_SOURCE,
} from "./banking-core"
import { dec, fmt } from "./banking.math"

/**
 * Retiros de la reserva positiva (Módulo 17). La reserva es un saldo
 * CONTABLE privado (no dinero nuevo en caja) derivado de su libro.
 *   CASHIER prepara la solicitud → PARTNER/SUPERADMIN la APRUEBA
 *   DIGITALMENTE: en esa transacción el importe sale de la reserva
 *   (RECLASSIFIED_TO_WITHDRAWAL) y queda comprometido, así no puede
 *   autorizarse otra vez → pagos REALES parciales o totales → cerrar el
 *   remanente no pagado lo regresa a la reserva (RELEASED_FROM_WITHDRAWAL).
 * Nunca se reduce dos veces: la reducción ocurre una sola vez al aprobar
 * (clave única por retiro) y los pagos solo descargan esa obligación.
 */

export async function requestWithdrawal(
  actor: SessionUser,
  input: {
    playerId: string
    amount: string
    reason: string
    idempotencyKey: string
  },
  ctx: RequestContext = {}
) {
  const amount = dec(input.amount)
  const previous = await prisma.bankingReserveWithdrawal.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, playerId: true },
  })
  if (previous) {
    if (previous.playerId !== input.playerId)
      throw new ConflictError("Clave de operación reutilizada")
    return { withdrawalId: previous.id, replayed: true }
  }
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPlayerInTx(tx, input.playerId)
      const state = await reserveStateOf(tx, input.playerId)
      if (amount.greaterThan(state.withdrawable))
        throw new BusinessRuleError(
          `La reserva disponible para retiro es $${fmt(state.withdrawable)}.`,
          { available: fmt(state.withdrawable) }
        )
      const w = await tx.bankingReserveWithdrawal.create({
        data: {
          playerId: input.playerId,
          requestedAmount: amount,
          reason: input.reason,
          requestedById: actor.id,
          idempotencyKey: input.idempotencyKey,
        },
      })
      await audit(
        tx,
        actor,
        ctx,
        AUDIT_ACTIONS.BANKING_RESERVE_WITHDRAWAL_REQUESTED,
        {
          entityType: "BankingReserveWithdrawal",
          entityId: w.id,
          playerId: input.playerId,
          amount: fmt(amount),
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          metadata: {
            reserveBalance: fmt(state.balance),
            withdrawable: fmt(state.withdrawable),
          },
        }
      )
      return { withdrawalId: w.id, replayed: false }
    }, BANKING_TX)
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await prisma.bankingReserveWithdrawal.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true },
      })
      if (again) return { withdrawalId: again.id, replayed: true }
    }
    await auditBankingFailure(actor, "Player", input.playerId, error, ctx)
    throw error
  }
}

async function head(withdrawalId: string) {
  const w = await prisma.bankingReserveWithdrawal.findUnique({
    where: { id: withdrawalId },
    select: { playerId: true },
  })
  if (!w) throw new NotFoundError("Retiro no encontrado")
  return w
}

/** Decisión DIGITAL (PARTNER/SUPERADMIN): aprobar compromete la reserva. */
export async function decideWithdrawal(
  actor: SessionUser,
  withdrawalId: string,
  input: {
    decision: "APPROVE" | "REJECT"
    approvedAmount?: string
    notes?: string
    idempotencyKey: string
  },
  ctx: RequestContext = {}
) {
  const { playerId } = await head(withdrawalId)
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPlayerInTx(tx, playerId)
      await lockBankingRow(tx, "banking_reserve_withdrawals", withdrawalId)
      const w = await tx.bankingReserveWithdrawal.findUniqueOrThrow({
        where: { id: withdrawalId },
      })
      if (w.status !== "REQUESTED") {
        if (
          (input.decision === "APPROVE" &&
            w.status !== "REJECTED" &&
            w.status !== "CANCELLED") ||
          (input.decision === "REJECT" && w.status === "REJECTED")
        )
          return { replayed: true }
        throw new ConflictError("La solicitud ya fue decidida.")
      }
      const now = new Date()
      if (input.decision === "REJECT") {
        await tx.bankingReserveWithdrawal.update({
          where: { id: withdrawalId },
          data: {
            status: "REJECTED",
            decidedById: actor.id,
            decidedAt: now,
            decisionNotes: input.notes ?? null,
            version: { increment: 1 },
          },
        })
        await audit(
          tx,
          actor,
          ctx,
          AUDIT_ACTIONS.BANKING_RESERVE_WITHDRAWAL_REJECTED,
          {
            entityType: "BankingReserveWithdrawal",
            entityId: withdrawalId,
            playerId,
            reason: input.notes ?? null,
          }
        )
        return { replayed: false }
      }
      const approved = input.approvedAmount
        ? dec(input.approvedAmount)
        : dec(w.requestedAmount)
      if (approved.greaterThan(dec(w.requestedAmount)))
        throw new BusinessRuleError("No se puede aprobar más de lo solicitado.")
      // Disponible ACTUAL: reserva − déficit confirmado de ciclos abiertos.
      const state = await reserveStateOf(tx, playerId)
      if (approved.greaterThan(state.withdrawable))
        throw new BusinessRuleError(
          `La reserva disponible para retiro es $${fmt(state.withdrawable)}.`,
          { available: fmt(state.withdrawable) }
        )
      await tx.bankingReserveMovement.create({
        data: {
          playerId,
          kind: "RECLASSIFIED_TO_WITHDRAWAL",
          amount: approved,
          withdrawalId,
          uniqueKey: `withdrawal:${withdrawalId}:commit`,
          notes: "Retiro aprobado: pasa a obligación por pagar",
          createdById: actor.id,
        },
      })
      await tx.bankingReserveWithdrawal.update({
        where: { id: withdrawalId },
        data: {
          status: "APPROVED",
          approvedAmount: approved,
          decidedById: actor.id,
          decidedAt: now,
          decisionNotes: input.notes ?? null,
          version: { increment: 1 },
        },
      })
      await supersedeOpenClosingsInTx(
        tx,
        actor,
        playerId,
        "Retiro de reserva aprobado",
        ctx
      )
      await audit(
        tx,
        actor,
        ctx,
        AUDIT_ACTIONS.BANKING_RESERVE_WITHDRAWAL_APPROVED,
        {
          entityType: "BankingReserveWithdrawal",
          entityId: withdrawalId,
          playerId,
          amount: fmt(approved),
          idempotencyKey: input.idempotencyKey,
          metadata: {
            requested: fmt(dec(w.requestedAmount)),
            approved: fmt(approved),
            reserveBefore: fmt(state.balance),
            reserveAfter: fmt(state.balance.sub(approved)),
            requestedBy: w.requestedById,
          },
        }
      )
      return { replayed: false }
    }, BANKING_TX)
  } catch (error) {
    if (isUniqueViolation(error))
      throw new ConflictError("El retiro ya fue aprobado por otra persona.")
    await auditBankingFailure(
      actor,
      "BankingReserveWithdrawal",
      withdrawalId,
      error,
      ctx
    )
    throw error
  }
}

/** Cancela una solicitud AÚN NO aprobada (no hay nada comprometido). */
export async function cancelWithdrawal(
  actor: SessionUser,
  withdrawalId: string,
  input: { reason: string; idempotencyKey: string },
  ctx: RequestContext = {}
) {
  const { playerId } = await head(withdrawalId)
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPlayerInTx(tx, playerId)
      await lockBankingRow(tx, "banking_reserve_withdrawals", withdrawalId)
      const w = await tx.bankingReserveWithdrawal.findUniqueOrThrow({
        where: { id: withdrawalId },
      })
      if (w.status === "CANCELLED") return { replayed: true }
      if (w.status !== "REQUESTED")
        throw new BusinessRuleError(
          "Solo se cancela una solicitud sin aprobar; si ya se aprobó, cierra su remanente."
        )
      await tx.bankingReserveWithdrawal.update({
        where: { id: withdrawalId },
        data: {
          status: "CANCELLED",
          closeReason: input.reason,
          closedById: actor.id,
          closedAt: new Date(),
          version: { increment: 1 },
        },
      })
      await audit(
        tx,
        actor,
        ctx,
        AUDIT_ACTIONS.BANKING_RESERVE_WITHDRAWAL_CANCELLED,
        {
          entityType: "BankingReserveWithdrawal",
          entityId: withdrawalId,
          playerId,
          reason: input.reason,
        }
      )
      return { replayed: false }
    }, BANKING_TX)
  } catch (error) {
    await auditBankingFailure(
      actor,
      "BankingReserveWithdrawal",
      withdrawalId,
      error,
      ctx
    )
    throw error
  }
}

/**
 * Cierra un retiro aprobado: lo NO pagado regresa a la reserva (una sola
 * vez). Exige que no haya transferencias en trámite ni pagos sin completar.
 */
export async function closeWithdrawal(
  actor: SessionUser,
  withdrawalId: string,
  input: { reason: string; idempotencyKey: string },
  ctx: RequestContext = {}
) {
  const { playerId } = await head(withdrawalId)
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPlayerInTx(tx, playerId)
      await lockBankingRow(tx, "banking_reserve_withdrawals", withdrawalId)
      const w = await tx.bankingReserveWithdrawal.findUniqueOrThrow({
        where: { id: withdrawalId },
      })
      if (w.status === "CLOSED") return { replayed: true }
      if (w.status !== "APPROVED" && w.status !== "PARTIALLY_PAID")
        throw new BusinessRuleError(
          "Este retiro no tiene remanente que cerrar."
        )
      const t = payoutTotals(
        await payablesOfSource(tx, WITHDRAWAL_SOURCE, withdrawalId)
      )
      if (t.unpaid.greaterThan(0))
        throw new BusinessRuleError(
          "Hay un pago sin completar: confirma o resuelve la transferencia antes de cerrar."
        )
      const released = dec(w.approvedAmount).sub(t.executed)
      if (released.greaterThan(0))
        await tx.bankingReserveMovement.create({
          data: {
            playerId,
            kind: "RELEASED_FROM_WITHDRAWAL",
            amount: released,
            withdrawalId,
            uniqueKey: `withdrawal:${withdrawalId}:release`,
            notes: "Remanente no pagado del retiro",
            createdById: actor.id,
          },
        })
      await tx.bankingReserveWithdrawal.update({
        where: { id: withdrawalId },
        data: {
          status: "CLOSED",
          closedAt: new Date(),
          closedById: actor.id,
          closeReason: input.reason,
          version: { increment: 1 },
        },
      })
      await supersedeOpenClosingsInTx(
        tx,
        actor,
        playerId,
        "Remanente de retiro liberado",
        ctx
      )
      await audit(
        tx,
        actor,
        ctx,
        AUDIT_ACTIONS.BANKING_RESERVE_WITHDRAWAL_CLOSED,
        {
          entityType: "BankingReserveWithdrawal",
          entityId: withdrawalId,
          playerId,
          reason: input.reason,
          amount: fmt(released),
          metadata: { paid: fmt(t.executed), released: fmt(released) },
        }
      )
      return { replayed: false }
    }, BANKING_TX)
  } catch (error) {
    await auditBankingFailure(
      actor,
      "BankingReserveWithdrawal",
      withdrawalId,
      error,
      ctx
    )
    throw error
  }
}
