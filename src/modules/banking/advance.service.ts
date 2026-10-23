import "server-only"

import { BusinessRuleError, ConflictError, NotFoundError } from "@/lib/errors"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"

import {
  ADVANCE_SOURCE,
  advanceLimitOf,
  assertAuthorizerInTx,
  audit,
  auditBankingFailure,
  BANKING_TX,
  effectiveResult,
  lockBankingRow,
  lockPlayerInTx,
  payablesOfSource,
  payoutTotals,
  requireActiveAgreement,
} from "./banking-core"
import { dec, fmt } from "./banking.math"
import type { CreateAdvanceInput } from "./banking.schemas"

/**
 * Anticipos (Módulo 17). SOLO después de una jugada GANADORA confirmada y
 * dentro del límite conservador calculado por el servidor. El importe lo
 * decide un PARTNER o SUPERADMIN, que lo comunica VERBALMENTE o por MENSAJE;
 * el CASHIER lo registra seleccionando al autorizador (no hay aprobación
 * digital inventada). Registrar no paga: el dinero sale con `disburseAdvance`.
 */
export async function registerAdvance(
  actor: SessionUser,
  input: CreateAdvanceInput,
  ctx: RequestContext = {}
) {
  const requested = dec(input.requestedAmount)
  const authorized = dec(input.authorizedAmount)
  const previous = await prisma.bankingAdvance.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, playerId: true, authorizedAmount: true },
  })
  if (previous) {
    if (
      previous.playerId !== input.playerId ||
      !dec(previous.authorizedAmount).equals(authorized)
    )
      throw new ConflictError("Clave de operación reutilizada")
    return { advanceId: previous.id, replayed: true }
  }
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPlayerInTx(tx, input.playerId)
      await requireActiveAgreement(tx, input.playerId)
      const game = await tx.bankingGame.findUnique({
        where: { id: input.enablingGameId },
        include: { adjustments: { select: { amount: true } } },
      })
      if (!game || game.playerId !== input.playerId)
        throw new NotFoundError("Jugada no encontrada")
      if (game.status !== "CONFIRMED")
        throw new BusinessRuleError(
          "El anticipo requiere una jugada ganadora CONFIRMADA."
        )
      if (!effectiveResult(game).greaterThan(0))
        throw new BusinessRuleError(
          "La jugada no fue ganadora: no habilita anticipos."
        )
      if (authorized.greaterThan(requested))
        throw new BusinessRuleError(
          "El importe autorizado no puede ser mayor que el solicitado."
        )
      const authorizer = await assertAuthorizerInTx(tx, input.authorizerId)
      const limit = await advanceLimitOf(tx, game.cycleId)
      if (limit.blockedReason)
        throw new BusinessRuleError(
          `Anticipo no disponible: ${limit.blockedReason}`,
          { available: "0.00" }
        )
      if (authorized.greaterThan(limit.available))
        throw new BusinessRuleError(
          `El importe autorizado supera la participación positiva garantizada disponible ($${fmt(limit.available)}).`,
          { available: fmt(limit.available) }
        )
      const a = await tx.bankingAdvance.create({
        data: {
          playerId: input.playerId,
          cycleId: game.cycleId,
          enablingGameId: game.id,
          requestedAmount: requested,
          authorizedAmount: authorized,
          limitAtRegistration: limit.available,
          authorizerId: authorizer.id,
          authorizerName: authorizer.name,
          channel: input.channel,
          notes: input.notes ?? null,
          recordedById: actor.id,
          idempotencyKey: input.idempotencyKey,
        },
      })
      await audit(tx, actor, ctx, AUDIT_ACTIONS.BANKING_ADVANCE_REGISTERED, {
        entityType: "BankingAdvance",
        entityId: a.id,
        playerId: input.playerId,
        amount: fmt(authorized),
        idempotencyKey: input.idempotencyKey,
        metadata: {
          cycleId: game.cycleId,
          enablingGameId: game.id,
          requested: fmt(requested),
          authorized: fmt(authorized),
          limit: fmt(limit.available),
          guaranteedShare: fmt(limit.guaranteedShare),
          authorizerId: authorizer.id,
          authorizerName: authorizer.name,
          authorizerRole: authorizer.role,
          channel: input.channel,
          // Registro operativo: el socio NO aprobó digitalmente.
          digitalApproval: false,
        },
      })
      return { advanceId: a.id, replayed: false }
    }, BANKING_TX)
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await prisma.bankingAdvance.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true },
      })
      if (again) return { advanceId: again.id, replayed: true }
    }
    await auditBankingFailure(actor, "Player", input.playerId, error, ctx)
    throw error
  }
}

/**
 * Cierra el anticipo: el remanente autorizado que NO se pagó deja de estar
 * comprometido (lo pagado se conserva). Exige que no haya transferencias en
 * trámite ni obligaciones sin pagar.
 */
export async function closeAdvance(
  actor: SessionUser,
  advanceId: string,
  input: { reason: string; idempotencyKey: string },
  ctx: RequestContext = {}
) {
  const head = await prisma.bankingAdvance.findUnique({
    where: { id: advanceId },
    select: { playerId: true },
  })
  if (!head) throw new NotFoundError("Anticipo no encontrado")
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPlayerInTx(tx, head.playerId)
      await lockBankingRow(tx, "banking_advances", advanceId)
      const a = await tx.bankingAdvance.findUniqueOrThrow({
        where: { id: advanceId },
      })
      if (a.status === "CLOSED") return { replayed: true }
      if (a.status === "PAID")
        throw new BusinessRuleError("El anticipo ya está pagado por completo.")
      const t = payoutTotals(
        await payablesOfSource(tx, ADVANCE_SOURCE, advanceId)
      )
      if (t.unpaid.greaterThan(0))
        throw new BusinessRuleError(
          "Hay un pago sin completar: confirma o resuelve la transferencia antes de cerrar."
        )
      await tx.bankingAdvance.update({
        where: { id: advanceId },
        data: {
          status: "CLOSED",
          closedAt: new Date(),
          closedById: actor.id,
          closeReason: input.reason,
          version: { increment: 1 },
        },
      })
      await audit(tx, actor, ctx, AUDIT_ACTIONS.BANKING_ADVANCE_CLOSED, {
        entityType: "BankingAdvance",
        entityId: advanceId,
        playerId: head.playerId,
        reason: input.reason,
        amount: fmt(t.executed),
        metadata: {
          authorized: fmt(dec(a.authorizedAmount)),
          paid: fmt(t.executed),
          released: fmt(dec(a.authorizedAmount).sub(t.executed)),
        },
      })
      return { replayed: false }
    }, BANKING_TX)
  } catch (error) {
    await auditBankingFailure(actor, "BankingAdvance", advanceId, error, ctx)
    throw error
  }
}
