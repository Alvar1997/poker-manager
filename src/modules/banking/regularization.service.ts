import "server-only"

import { BusinessRuleError, ConflictError, NotFoundError } from "@/lib/errors"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import {
  custodianScope,
  GLOBAL_SCOPE,
  postTransactionInTx,
} from "@/modules/cash/ledger"

import {
  audit,
  auditBankingFailure,
  BANKING_TX,
  lockBankingRow,
  lockPlayerInTx,
  reserveStateOf,
  supersedeOpenClosingsInTx,
} from "./banking-core"
import { dec, fmt, ZERO } from "./banking.math"

/**
 * Regularizaciones de anticipos EXCEDIDOS (Módulo 17), caso por caso: un
 * PARTNER o SUPERADMIN decide. Nunca se crea deuda ordinaria, nunca se exige
 * devolución automática y nunca se registra dinero por aprobar:
 *   RECOVER_FROM_FUTURE  → se descuenta de participaciones futuras (cortes).
 *   APPLY_RESERVE        → consume reserva positiva disponible (una vez).
 *   MONEY_RETURNED       → se espera dinero REAL; entra solo al recibirlo.
 *   DOCUMENTED_WRITE_OFF → la casa lo absorbe, documentado.
 * Los pagos originales quedan inmutables.
 */

async function head(id: string) {
  const r = await prisma.bankingRegularization.findUnique({
    where: { id },
    select: { playerId: true },
  })
  if (!r) throw new NotFoundError("Regularización no encontrada")
  return r
}

export async function resolveRegularization(
  actor: SessionUser,
  regularizationId: string,
  input: {
    resolution:
      | "RECOVER_FROM_FUTURE"
      | "APPLY_RESERVE"
      | "MONEY_RETURNED"
      | "DOCUMENTED_WRITE_OFF"
    notes: string
    idempotencyKey: string
  },
  ctx: RequestContext = {}
) {
  const { playerId } = await head(regularizationId)
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPlayerInTx(tx, playerId)
      await lockBankingRow(tx, "banking_regularizations", regularizationId)
      const r = await tx.bankingRegularization.findUniqueOrThrow({
        where: { id: regularizationId },
      })
      if (r.kind !== "EXCESS_ADVANCE")
        throw new BusinessRuleError(
          "Las discrepancias físicas se aclaran desde la jugada."
        )
      if (r.status !== "OPEN") {
        if (r.resolution === input.resolution) return { replayed: true }
        throw new ConflictError("La regularización ya tiene una decisión.")
      }
      const now = new Date()
      const amount = dec(r.amount)
      let status: "RECOVERING" | "AWAITING_RETURN" | "RESOLVED"
      if (input.resolution === "RECOVER_FROM_FUTURE") status = "RECOVERING"
      else if (input.resolution === "MONEY_RETURNED") status = "AWAITING_RETURN"
      else status = "RESOLVED"
      if (input.resolution === "APPLY_RESERVE") {
        const state = await reserveStateOf(tx, playerId)
        if (state.withdrawable.lessThan(amount))
          throw new BusinessRuleError(
            `La reserva libre ($${fmt(state.withdrawable)}) no alcanza para cubrir el excedente ($${fmt(amount)}). Elige otro tratamiento.`
          )
        await tx.bankingReserveMovement.create({
          data: {
            playerId,
            kind: "CONSUMED_BY_REGULARIZATION",
            amount,
            regularizationId,
            uniqueKey: `regularization:${regularizationId}:reserve`,
            notes: "Reserva aplicada a un anticipo excedido",
            createdById: actor.id,
          },
        })
        await audit(tx, actor, ctx, AUDIT_ACTIONS.BANKING_RESERVE_APPLIED, {
          entityType: "BankingRegularization",
          entityId: regularizationId,
          playerId,
          amount: fmt(amount),
        })
        await supersedeOpenClosingsInTx(
          tx,
          actor,
          playerId,
          "Reserva aplicada a una regularización",
          ctx
        )
      }
      await tx.bankingRegularization.update({
        where: { id: regularizationId },
        data: {
          status,
          resolution: input.resolution,
          resolutionNotes: input.notes,
          resolvedById: actor.id,
          resolvedAt: now,
          version: { increment: 1 },
        },
      })
      await audit(
        tx,
        actor,
        ctx,
        AUDIT_ACTIONS.BANKING_REGULARIZATION_RESOLVED,
        {
          entityType: "BankingRegularization",
          entityId: regularizationId,
          playerId,
          amount: fmt(amount),
          reason: input.notes,
          idempotencyKey: input.idempotencyKey,
          metadata: { resolution: input.resolution, status },
        }
      )
      return { replayed: false, status }
    }, BANKING_TX)
  } catch (error) {
    await auditBankingFailure(
      actor,
      "BankingRegularization",
      regularizationId,
      error,
      ctx
    )
    throw error
  }
}

/**
 * Dinero REAL devuelto por el jugador (acordado): efectivo que entra a la
 * custodia administrativa de quien lo recibe, con su asiento. Solo al
 * recibirlo; parcial permitido; nunca más que lo pendiente (trigger).
 */
export async function recordRegularizationFunds(
  actor: SessionUser,
  regularizationId: string,
  input: { amount: string; idempotencyKey: string },
  ctx: RequestContext = {}
) {
  const amount = dec(input.amount)
  const previous = await prisma.bankingRegularizationReceipt.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { regularizationId: true },
  })
  if (previous) {
    if (previous.regularizationId !== regularizationId)
      throw new ConflictError("Clave de operación reutilizada")
    return { replayed: true }
  }
  const { playerId } = await head(regularizationId)
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPlayerInTx(tx, playerId)
      await lockBankingRow(tx, "banking_regularizations", regularizationId)
      const r = await tx.bankingRegularization.findUniqueOrThrow({
        where: { id: regularizationId },
        include: {
          receipts: { select: { amount: true } },
          recoveries: { select: { amount: true } },
        },
      })
      if (r.status !== "AWAITING_RETURN")
        throw new BusinessRuleError(
          "La regularización no espera una devolución de dinero."
        )
      const used = [...r.receipts, ...r.recoveries].reduce(
        (a, x) => a.add(dec(x.amount)),
        ZERO
      )
      const remaining = dec(r.amount).sub(used)
      if (amount.greaterThan(remaining))
        throw new BusinessRuleError(
          `Solo quedan $${fmt(remaining)} por recibir.`,
          { available: fmt(remaining) }
        )
      const posted = await postTransactionInTx(
        tx,
        {
          type: "BANKING_FUNDS_RECEIVED",
          playerId,
          referenceType: "BankingRegularization",
          referenceId: regularizationId,
          reason: "Devolución recibida (registro administrativo)",
          idempotencyKey: `banking-reg-receipt:${input.idempotencyKey}`,
          requestHash: `banking-reg-receipt-${regularizationId}-${fmt(amount)}`,
          actorId: actor.id,
          audit: {
            action: AUDIT_ACTIONS.BANKING_REGULARIZATION_FUNDS_RECEIVED,
            metadata: { regularizationId, amount: fmt(amount) },
          },
        },
        [
          {
            account: "ADMIN_CASH_CUSTODY",
            direction: "DEBIT",
            amount,
            scopeKey: custodianScope(actor.id),
          },
          {
            account: "BANKING_PLAYER_SHARE",
            direction: "CREDIT",
            amount,
            scopeKey: GLOBAL_SCOPE,
          },
        ],
        ctx
      )
      await tx.bankingRegularizationReceipt.create({
        data: {
          regularizationId,
          amount,
          financialTransactionId: posted.transactionId,
          receivedById: actor.id,
          idempotencyKey: input.idempotencyKey,
        },
      })
      if (!remaining.sub(amount).greaterThan(0))
        await tx.bankingRegularization.update({
          where: { id: regularizationId },
          data: { status: "RESOLVED", version: { increment: 1 } },
        })
      return { replayed: false, remaining: fmt(remaining.sub(amount)) }
    }, BANKING_TX)
  } catch (error) {
    if (isUniqueViolation(error)) return { replayed: true }
    await auditBankingFailure(
      actor,
      "BankingRegularization",
      regularizationId,
      error,
      ctx
    )
    throw error
  }
}
