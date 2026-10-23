import "server-only"

import { BusinessRuleError, ConflictError, NotFoundError } from "@/lib/errors"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"

import {
  activeAgreementOf,
  audit,
  auditBankingFailure,
  BANKING_TX,
  loadCycleFacts,
  lockBankingRow,
  lockPlayerInTx,
  openCycleOf,
  previousCarriedLoss,
  supersedeOpenClosingsInTx,
  type Tx,
} from "./banking-core"
import {
  buildTranches,
  dec,
  fmt,
  GAMES_PER_CYCLE,
  guaranteedPlayerShare,
  parsePercentages,
  segmentForGame,
  ZERO,
  type GameFact,
  type SegmentLike,
} from "./banking.math"
import type {
  ChangeRequestInput,
  CreateAgreementInput,
} from "./banking.schemas"

/**
 * Acuerdos privados de bancaje y cambios de porcentaje (Módulo 17).
 * Crear un acuerdo y APROBAR un cambio de porcentaje son decisiones
 * DIGITALES de PARTNER o SUPERADMIN (la ruta exige `banking:approve`): el
 * aprobador es el usuario con sesión iniciada, nunca un nombre capturado.
 * Los porcentajes de movimientos confirmados nunca se editan: un cambio crea
 * una VERSIÓN nueva y, si afecta el ciclo en curso, un TRAMO nuevo.
 */

function percentOrThrow(raw: string) {
  try {
    return parsePercentages(raw)
  } catch (e) {
    throw new BusinessRuleError(
      e instanceof Error ? e.message : "Porcentaje inválido"
    )
  }
}

export async function createAgreement(
  actor: SessionUser,
  input: CreateAgreementInput,
  ctx: RequestContext = {}
) {
  const pct = percentOrThrow(input.playerPercent)
  const previous = await prisma.bankingAgreement.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, playerId: true },
  })
  if (previous) {
    if (previous.playerId !== input.playerId)
      throw new ConflictError("Clave de operación reutilizada")
    return { agreementId: previous.id, replayed: true }
  }
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPlayerInTx(tx, input.playerId)
      const player = await tx.player.findUniqueOrThrow({
        where: { id: input.playerId },
        select: { id: true, isActive: true },
      })
      if (!player.isActive)
        throw new BusinessRuleError("El jugador está inactivo.")
      if (await activeAgreementOf(tx, input.playerId))
        throw new ConflictError(
          "El jugador ya tiene un acuerdo vigente: cambia su porcentaje o termínalo primero."
        )
      const a = await tx.bankingAgreement.create({
        data: {
          playerId: input.playerId,
          notes: input.notes ?? null,
          createdById: actor.id,
          idempotencyKey: input.idempotencyKey,
        },
      })
      await tx.bankingAgreementVersion.create({
        data: {
          agreementId: a.id,
          version: 1,
          playerPercent: pct.player,
          housePercent: pct.house,
          reason: input.reason,
          createdById: actor.id,
          approvedById: actor.id,
        },
      })
      await audit(tx, actor, ctx, AUDIT_ACTIONS.BANKING_AGREEMENT_CREATED, {
        entityType: "BankingAgreement",
        entityId: a.id,
        playerId: input.playerId,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        metadata: {
          playerPercent: fmt(pct.player),
          housePercent: fmt(pct.house),
          approvedBy: actor.id,
        },
      })
      return { agreementId: a.id, replayed: false }
    }, BANKING_TX)
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await prisma.bankingAgreement.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true },
      })
      if (again) return { agreementId: again.id, replayed: true }
      throw new ConflictError(
        "El jugador ya tiene un acuerdo vigente (registrado al mismo tiempo)."
      )
    }
    await auditBankingFailure(actor, "Player", input.playerId, error, ctx)
    throw error
  }
}

/** Termina el acuerdo (sin borrar historial). Exige ciclos cerrados. */
export async function endAgreement(
  actor: SessionUser,
  agreementId: string,
  input: { reason: string; idempotencyKey: string },
  ctx: RequestContext = {}
) {
  const head = await prisma.bankingAgreement.findUnique({
    where: { id: agreementId },
    select: { playerId: true },
  })
  if (!head) throw new NotFoundError("Acuerdo no encontrado")
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPlayerInTx(tx, head.playerId)
      const a = await tx.bankingAgreement.findUniqueOrThrow({
        where: { id: agreementId },
      })
      if (a.status === "ENDED") return { replayed: true }
      const open = await tx.bankingCycle.count({
        where: { agreementId, status: { not: "CLOSED" } },
      })
      if (open > 0)
        throw new BusinessRuleError(
          "El acuerdo tiene un ciclo sin cerrar: termina su corte antes de finalizarlo."
        )
      await tx.bankingAgreement.update({
        where: { id: agreementId },
        data: {
          status: "ENDED",
          endedAt: new Date(),
          endedById: actor.id,
          endReason: input.reason,
        },
      })
      await audit(tx, actor, ctx, AUDIT_ACTIONS.BANKING_AGREEMENT_ENDED, {
        entityType: "BankingAgreement",
        entityId: agreementId,
        playerId: head.playerId,
        reason: input.reason,
      })
      return { replayed: false }
    }, BANKING_TX)
  } catch (error) {
    await auditBankingFailure(
      actor,
      "BankingAgreement",
      agreementId,
      error,
      ctx
    )
    throw error
  }
}

// ── Cambios de porcentaje ─────────────────────────────────────────────

/** Resumen del cálculo provisional con un juego de tramos (antes/después). */
function provisionalCalc(
  games: { gameNumber: number; result: ReturnType<typeof dec> }[],
  segments: SegmentLike[],
  carried: ReturnType<typeof dec>
) {
  const facts: GameFact[] = games.map((g) => {
    const s = segmentForGame(segments, g.gameNumber)
    return {
      gameNumber: g.gameNumber,
      result: g.result,
      segmentId: s.id,
      playerPercent: s.playerPercent,
    }
  })
  return {
    tranches: buildTranches(facts).map((t) => ({
      playerPercent: fmt(t.playerPercent),
      gameNumbers: t.gameNumbers,
      net: fmt(t.net),
    })),
    guaranteedPlayerShare: fmt(
      guaranteedPlayerShare({ games: facts, previousCarriedLoss: carried })
    ),
  }
}

export async function requestPercentageChange(
  actor: SessionUser,
  agreementId: string,
  input: ChangeRequestInput,
  ctx: RequestContext = {}
) {
  const pct = percentOrThrow(input.playerPercent)
  const previous = await prisma.bankingPercentageChangeRequest.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, agreementId: true },
  })
  if (previous) {
    if (previous.agreementId !== agreementId)
      throw new ConflictError("Clave de operación reutilizada")
    return { requestId: previous.id, replayed: true }
  }
  const head = await prisma.bankingAgreement.findUnique({
    where: { id: agreementId },
    select: { playerId: true },
  })
  if (!head) throw new NotFoundError("Acuerdo no encontrado")
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPlayerInTx(tx, head.playerId)
      const a = await tx.bankingAgreement.findUniqueOrThrow({
        where: { id: agreementId },
        include: { versions: { orderBy: { version: "desc" }, take: 1 } },
      })
      if (a.status !== "ACTIVE")
        throw new BusinessRuleError("El acuerdo ya no está vigente.")
      const current = a.versions[0]
      if (dec(current.playerPercent).equals(pct.player))
        throw new BusinessRuleError("El porcentaje nuevo es igual al vigente.")
      const pending = await tx.bankingPercentageChangeRequest.count({
        where: { agreementId, status: "PENDING" },
      })
      if (pending > 0)
        throw new ConflictError(
          "Ya hay un cambio de porcentaje pendiente de aprobación."
        )
      const cycle = await openCycleOf(tx, head.playerId)
      const gamesInCycle = cycle
        ? await tx.bankingGame.count({ where: { cycleId: cycle.id } })
        : 0
      const startGameNumber =
        input.mode === "WHOLE_CYCLE" ? 1 : gamesInCycle + 1
      const r = await tx.bankingPercentageChangeRequest.create({
        data: {
          agreementId,
          cycleId: cycle?.id ?? null,
          fromPlayerPercent: current.playerPercent,
          toPlayerPercent: pct.player,
          toHousePercent: pct.house,
          mode: input.mode,
          startGameNumber,
          reason: input.reason,
          requestedById: actor.id,
          idempotencyKey: input.idempotencyKey,
        },
      })
      await audit(
        tx,
        actor,
        ctx,
        AUDIT_ACTIONS.BANKING_PERCENTAGE_CHANGE_REQUESTED,
        {
          entityType: "BankingPercentageChangeRequest",
          entityId: r.id,
          playerId: head.playerId,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          metadata: {
            from: fmt(dec(current.playerPercent)),
            to: fmt(pct.player),
            mode: input.mode,
            cycleId: cycle?.id ?? null,
            startGameNumber,
          },
        }
      )
      return { requestId: r.id, replayed: false }
    }, BANKING_TX)
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await prisma.bankingPercentageChangeRequest.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true },
      })
      if (again) return { requestId: again.id, replayed: true }
    }
    await auditBankingFailure(
      actor,
      "BankingAgreement",
      agreementId,
      error,
      ctx
    )
    throw error
  }
}

/**
 * APRUEBA (digitalmente, PARTNER/SUPERADMIN) o RECHAZA un cambio. Al
 * aprobar: versión nueva del acuerdo; si afecta el ciclo vigente, tramo
 * nuevo desde la jugada indicada; los cortes en revisión se invalidan; se
 * guardan el cálculo anterior y el posterior. Un ciclo CERRADO nunca cambia.
 */
export async function decidePercentageChange(
  actor: SessionUser,
  requestId: string,
  input: {
    decision: "APPROVE" | "REJECT"
    notes?: string
    idempotencyKey: string
  },
  ctx: RequestContext = {}
) {
  const head = await prisma.bankingPercentageChangeRequest.findUnique({
    where: { id: requestId },
    select: { agreement: { select: { playerId: true } } },
  })
  if (!head) throw new NotFoundError("Solicitud no encontrada")
  const playerId = head.agreement.playerId
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPlayerInTx(tx, playerId)
      await lockBankingRow(tx, "banking_percentage_change_requests", requestId)
      const r = await tx.bankingPercentageChangeRequest.findUniqueOrThrow({
        where: { id: requestId },
        include: {
          agreement: {
            include: { versions: { orderBy: { version: "desc" }, take: 1 } },
          },
        },
      })
      if (r.status !== "PENDING") {
        if (
          (r.status === "APPROVED" && input.decision === "APPROVE") ||
          (r.status === "REJECTED" && input.decision === "REJECT")
        )
          return { replayed: true }
        throw new ConflictError("La solicitud ya fue decidida.")
      }
      if (input.decision === "REJECT") {
        if (!input.notes?.trim())
          throw new BusinessRuleError("Indica el motivo del rechazo.")
        await tx.bankingPercentageChangeRequest.update({
          where: { id: requestId },
          data: {
            status: "REJECTED",
            decidedById: actor.id,
            decidedAt: new Date(),
            decisionNotes: input.notes,
          },
        })
        await audit(
          tx,
          actor,
          ctx,
          AUDIT_ACTIONS.BANKING_PERCENTAGE_CHANGE_REJECTED,
          {
            entityType: "BankingPercentageChangeRequest",
            entityId: requestId,
            playerId,
            reason: input.notes,
          }
        )
        return { replayed: false }
      }
      if (r.agreement.status !== "ACTIVE")
        throw new BusinessRuleError("El acuerdo ya no está vigente.")
      const current = r.agreement.versions[0]
      const version = await tx.bankingAgreementVersion.create({
        data: {
          agreementId: r.agreementId,
          version: current.version + 1,
          playerPercent: r.toPlayerPercent,
          housePercent: r.toHousePercent,
          reason: r.reason,
          changeRequestId: r.id,
          createdById: r.requestedById,
          approvedById: actor.id,
        },
      })
      let before: unknown = null
      let after: unknown = null
      let affectsCycleId: string | null = null
      if (r.cycleId) {
        const cycle = await tx.bankingCycle.findUniqueOrThrow({
          where: { id: r.cycleId },
          select: { id: true, status: true, number: true },
        })
        // Un ciclo CERRADO requiere regularización excepcional, no edición.
        const start = r.startGameNumber ?? 1
        if (cycle.status !== "CLOSED" && start <= GAMES_PER_CYCLE) {
          const f = await loadCycleFacts(tx, cycle.id)
          const carried =
            (await previousCarriedLoss(tx, playerId, cycle.number)) ?? ZERO
          const games = f.facts.map((g) => ({
            gameNumber: g.gameNumber,
            result: g.result,
          }))
          before = provisionalCalc(games, f.segments, carried)
          const seg = await tx.bankingPercentageSegment.create({
            data: {
              cycleId: cycle.id,
              fromGameNumber: start,
              agreementVersionId: version.id,
              playerPercent: r.toPlayerPercent,
              housePercent: r.toHousePercent,
              changeRequestId: r.id,
              createdById: actor.id,
            },
          })
          after = provisionalCalc(
            games,
            [
              ...f.segments,
              {
                id: seg.id,
                fromGameNumber: seg.fromGameNumber,
                playerPercent: dec(seg.playerPercent),
                createdAt: seg.createdAt,
              },
            ],
            carried
          )
          affectsCycleId = cycle.id
        }
      }
      await tx.bankingPercentageChangeRequest.update({
        where: { id: requestId },
        data: {
          status: "APPROVED",
          decidedById: actor.id,
          decidedAt: new Date(),
          decisionNotes: input.notes ?? null,
          beforeCalculation: before as never,
          afterCalculation: after as never,
        },
      })
      await supersedeOpenClosingsInTx(
        tx,
        actor,
        playerId,
        "Cambio de porcentaje aprobado",
        ctx
      )
      await audit(
        tx,
        actor,
        ctx,
        AUDIT_ACTIONS.BANKING_PERCENTAGE_CHANGE_APPROVED,
        {
          entityType: "BankingPercentageChangeRequest",
          entityId: requestId,
          playerId,
          reason: r.reason,
          metadata: {
            from: fmt(dec(r.fromPlayerPercent)),
            to: fmt(dec(r.toPlayerPercent)),
            mode: r.mode,
            startGameNumber: r.startGameNumber,
            cycleId: affectsCycleId,
            version: version.version,
            requestedBy: r.requestedById,
            before,
            after,
          },
        }
      )
      await audit(tx, actor, ctx, AUDIT_ACTIONS.BANKING_AGREEMENT_CHANGED, {
        entityType: "BankingAgreement",
        entityId: r.agreementId,
        playerId,
        metadata: { version: version.version, changeRequestId: r.id },
      })
      return { replayed: false }
    }, BANKING_TX)
  } catch (error) {
    await auditBankingFailure(
      actor,
      "BankingPercentageChangeRequest",
      requestId,
      error,
      ctx
    )
    throw error
  }
}

export type { Tx }
