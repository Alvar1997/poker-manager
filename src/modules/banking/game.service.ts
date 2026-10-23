import "server-only"

import { Prisma } from "@/generated/prisma/client"
import {
  AppError,
  BusinessRuleError,
  ConflictError,
  NotFoundError,
} from "@/lib/errors"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import { raiseIncidentInTx } from "@/modules/incidents/incident.service"
import {
  readNominal,
  sharedChipSetId,
} from "@/modules/inventory/inventory.core"
import {
  confirmNominalChipReturnInTx,
  expireReservations,
} from "@/modules/inventory/reservation.service"
import { deliverHouseFundedPurchaseInTx } from "@/modules/purchases/purchase.service"
import { completeParticipationFromBankingGameInTx } from "@/modules/session-tables/participation.service"
import {
  lockOpenSession,
  lockSessionTable,
} from "@/modules/session-tables/session-table.service"

import {
  advanceLimitOf,
  audit,
  auditBankingFailure,
  BANKING_TX,
  cycleForNewGameInTx,
  lockBankingRow,
  lockPlayerInTx,
  refreshCycleStatusInTx,
  requireActiveAgreement,
  supersedeOpenClosingsInTx,
  type Tx,
} from "./banking-core"
import {
  checkReconciliation,
  dec,
  fmt,
  GAMES_PER_CYCLE,
  RECONCILE_MESSAGE,
  ZERO,
} from "./banking.math"
import type { FinancedPurchaseInput, ReconcileInput } from "./banking.schemas"

/**
 * Jugadas del Módulo 17. Una JUGADA = una sesión distinta en la que el
 * jugador bancado recibió fichas financiadas por la casa (cambiar de mesa NO
 * crea otra: la jugada es por (jugador, sesión)). Se confirma SOLO con la
 * devolución física verificada por el cajero o con el retorno cero
 * confirmado expresamente; ningún jugador se lleva fichas a otra sesión.
 */

async function lockActiveParticipationOf(
  tx: Tx,
  playerId: string,
  sessionId: string
) {
  const p = await tx.tableParticipation.findFirst({
    where: { playerId, sessionId, status: "ACTIVE" },
    select: { id: true, sessionTableId: true },
  })
  if (!p)
    throw new BusinessRuleError(
      "El jugador no está activo en una mesa de la sesión."
    )
  return p
}

/**
 * Compra o recompra FINANCIADA POR LA CASA. Reutiliza el Módulo 08 (folio,
 * numeración, reserva y salida nominal del inventario compartido) sin
 * efectivo, sin transferencia, sin crédito ordinario y sin deuda. La primera
 * de la sesión inicia la jugada (y, si toca, el ciclo siguiente).
 */
export async function recordFinancedPurchase(
  actor: SessionUser,
  input: FinancedPurchaseInput,
  ctx: RequestContext = {}
) {
  const amount = dec(input.nominalAmount)
  const previous = await prisma.chipPurchase.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: {
      id: true,
      participationId: true,
      fundingSource: true,
      bankingSource: { select: { gameId: true } },
    },
  })
  if (previous) {
    if (
      previous.participationId !== input.participationId ||
      previous.fundingSource !== "HOUSE" ||
      !previous.bankingSource
    )
      throw new ConflictError("Clave de operación reutilizada")
    return {
      purchaseId: previous.id,
      gameId: previous.bankingSource.gameId,
      replayed: true,
    }
  }
  await expireReservations()
  const head = await prisma.tableParticipation.findUnique({
    where: { id: input.participationId },
    select: { sessionId: true, sessionTableId: true, playerId: true },
  })
  if (!head) throw new NotFoundError("Participación no encontrada")
  try {
    return await prisma.$transaction(async (tx) => {
      await lockOpenSession(
        tx,
        head.sessionId,
        "La sesión debe estar abierta para entregar fichas."
      )
      const table = await lockSessionTable(tx, head.sessionTableId)
      await tx.$queryRaw`SELECT "id" FROM "table_participations" WHERE "id" = ${input.participationId} FOR UPDATE`
      await lockPlayerInTx(tx, head.playerId)
      if (table.status !== "OPEN" || !table.cycles[0])
        throw new BusinessRuleError("La mesa debe estar abierta.")
      const { agreement, version } = await requireActiveAgreement(
        tx,
        head.playerId
      )
      // Una jugada financiada nunca se mezcla con compras pagadas por el
      // jugador en la misma sesión (el resultado dejaría de ser verificable).
      const own = await tx.chipPurchase.count({
        where: {
          sessionId: head.sessionId,
          playerId: head.playerId,
          fundingSource: "PLAYER",
          status: { in: ["DRAFT", "READY_FOR_DELIVERY", "CONFIRMED"] },
        },
      })
      if (own > 0)
        throw new BusinessRuleError(
          "El jugador ya tiene compras pagadas en esta sesión: no se mezclan con fichas financiadas."
        )
      let game = await tx.bankingGame.findUnique({
        where: {
          playerId_sessionId: {
            playerId: head.playerId,
            sessionId: head.sessionId,
          },
        },
      })
      let started = false
      if (game) {
        if (game.status !== "IN_PROGRESS")
          throw new BusinessRuleError(
            game.status === "CONFIRMED"
              ? "La jugada de esta sesión ya fue conciliada: no admite más fichas financiadas."
              : "La jugada tiene una discrepancia o corrección pendiente."
          )
      } else {
        const { cycle } = await cycleForNewGameInTx(
          tx,
          actor,
          agreement,
          version,
          ctx
        )
        const count = await tx.bankingGame.count({
          where: { cycleId: cycle.id },
        })
        if (count >= GAMES_PER_CYCLE)
          throw new ConflictError("El ciclo ya tiene sus cuatro jugadas.")
        game = await tx.bankingGame.create({
          data: {
            cycleId: cycle.id,
            playerId: head.playerId,
            sessionId: head.sessionId,
            gameNumber: count + 1,
            startedById: actor.id,
          },
        })
        started = true
        await refreshCycleStatusInTx(tx, cycle.id)
        await audit(tx, actor, ctx, AUDIT_ACTIONS.BANKING_GAME_STARTED, {
          entityType: "BankingGame",
          entityId: game.id,
          playerId: head.playerId,
          sessionId: head.sessionId,
          metadata: {
            cycleId: cycle.id,
            cycleNumber: cycle.number,
            gameNumber: game.gameNumber,
          },
        })
      }
      const delivered = await deliverHouseFundedPurchaseInTx(
        tx,
        actor,
        {
          participationId: input.participationId,
          nominalAmount: amount,
          notes: input.notes ?? null,
          idempotencyKey: input.idempotencyKey,
        },
        ctx
      )
      await tx.bankingGameFinancialSource.create({
        data: {
          gameId: game.id,
          purchaseId: delivered.purchaseId,
          nominalAmount: amount,
          createdById: actor.id,
        },
      })
      await tx.bankingGame.update({
        where: { id: game.id },
        data: { version: { increment: 1 } },
      })
      await audit(
        tx,
        actor,
        ctx,
        AUDIT_ACTIONS.BANKING_FINANCED_PURCHASE_DELIVERED,
        {
          entityType: "BankingGame",
          entityId: game.id,
          playerId: head.playerId,
          sessionId: head.sessionId,
          amount: fmt(amount),
          idempotencyKey: input.idempotencyKey,
          metadata: {
            purchaseId: delivered.purchaseId,
            folio: delivered.folio,
            purchaseType: delivered.purchaseType,
            rebuyNumber: delivered.rebuyNumber,
            gameNumber: game.gameNumber,
            inventoryOperationId: delivered.inventoryOperationId,
            started,
          },
        }
      )
      return {
        purchaseId: delivered.purchaseId,
        gameId: game.id,
        replayed: false,
      }
    }, BANKING_TX)
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await prisma.chipPurchase.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true, bankingSource: { select: { gameId: true } } },
      })
      if (again?.bankingSource)
        return {
          purchaseId: again.id,
          gameId: again.bankingSource.gameId,
          replayed: true,
        }
      throw new ConflictError(
        "Otra operación modificó la jugada al mismo tiempo. Intenta de nuevo."
      )
    }
    await auditBankingFailure(
      actor,
      "TableParticipation",
      input.participationId,
      error,
      ctx
    )
    throw error
  }
}

/**
 * CONCILIA y CONFIRMA la jugada: el cajero verificó la devolución física
 * (o el retorno cero confirmado expresamente). En UNA transacción: entrada
 * nominal al inventario compartido una sola vez (si > 0), resultado bruto =
 * devuelto − financiado, salida de la participación SIN pago al jugador
 * (no se aplica la liquidación ordinaria) y estado del ciclo.
 */
export async function reconcileGame(
  actor: SessionUser,
  gameId: string,
  input: ReconcileInput,
  ctx: RequestContext = {}
) {
  const returned = dec(input.returnedNominalAmount)
  const head = await prisma.bankingGame.findUnique({
    where: { id: gameId },
    select: {
      playerId: true,
      sessionId: true,
      confirmIdempotencyKey: true,
      status: true,
    },
  })
  if (!head) throw new NotFoundError("Jugada no encontrada")
  if (head.confirmIdempotencyKey === input.idempotencyKey)
    return { replayed: true }
  if (head.status === "CONFIRMED" || head.status === "UNDER_CORRECTION")
    throw new ConflictError("La jugada ya fue conciliada.")
  try {
    return await prisma.$transaction(async (tx) => {
      await lockOpenSession(
        tx,
        head.sessionId,
        "La sesión debe estar abierta para conciliar la devolución."
      )
      const current = await tx.bankingGame.findUniqueOrThrow({
        where: { id: gameId },
        select: { status: true, confirmIdempotencyKey: true },
      })
      if (current.confirmIdempotencyKey === input.idempotencyKey)
        return { replayed: true }
      if (
        current.status === "CONFIRMED" ||
        current.status === "UNDER_CORRECTION"
      )
        throw new ConflictError("La jugada ya fue conciliada.")
      const part = await lockActiveParticipationOf(
        tx,
        head.playerId,
        head.sessionId
      )
      const table = await lockSessionTable(tx, part.sessionTableId)
      await tx.$queryRaw`SELECT "id" FROM "table_participations" WHERE "id" = ${part.id} FOR UPDATE`
      await lockPlayerInTx(tx, head.playerId)
      await lockBankingRow(tx, "banking_games", gameId)
      const game = await tx.bankingGame.findUniqueOrThrow({
        where: { id: gameId },
        include: { sources: true, cycle: { select: { id: true } } },
      })
      if (game.confirmIdempotencyKey === input.idempotencyKey)
        return { replayed: true }
      if (game.status === "PENDING_RECONCILIATION")
        throw new BusinessRuleError(
          "La jugada tiene una discrepancia física pendiente: requiere regularización autorizada."
        )
      if (game.status !== "IN_PROGRESS")
        throw new ConflictError("La jugada ya fue conciliada.")
      if (game.version !== input.expectedVersion)
        throw new ConflictError(
          "La jugada cambió (otra compra o conciliación): revisa los importes de nuevo."
        )
      // Lo financiado sale de las compras HOUSE confirmadas (cruzado con
      // las fuentes de la jugada): nunca de un dato del navegador.
      const house = await tx.chipPurchase.aggregate({
        where: {
          sessionId: head.sessionId,
          playerId: head.playerId,
          fundingSource: "HOUSE",
          status: "CONFIRMED",
        },
        _sum: { nominalAmount: true },
      })
      const financed = dec(house._sum.nominalAmount)
      const fromSources = game.sources.reduce(
        (a, s) => a.add(dec(s.nominalAmount)),
        ZERO
      )
      if (!financed.equals(fromSources))
        throw new ConflictError(
          "Las compras financiadas no coinciden con la jugada: revisa antes de conciliar."
        )
      const pendingPurchases = await tx.chipPurchase.count({
        where: {
          sessionId: head.sessionId,
          playerId: head.playerId,
          status: { in: ["DRAFT", "READY_FOR_DELIVERY"] },
        },
      })
      const nominal = await readNominal(tx, await sharedChipSetId(tx))
      const check = checkReconciliation({
        financed,
        pendingPurchases,
        returned,
        zeroReturnConfirmed: input.zeroReturnConfirmed,
        circulation: nominal.circulation,
      })
      if (!check.ok)
        throw new BusinessRuleError(RECONCILE_MESSAGE[check.reason])
      let operationId: string | null = null
      if (returned.greaterThan(0)) {
        const op = await confirmNominalChipReturnInTx(
          tx,
          actor,
          {
            amount: returned,
            referenceType: "BankingGame",
            referenceId: gameId,
            tableId: table.tableId,
            sessionId: head.sessionId,
            playerId: head.playerId,
            idempotencyKey: `banking-return-${gameId}`,
          },
          ctx
        )
        operationId = op.operationId
      }
      const now = new Date()
      const { count } = await tx.bankingGame.updateMany({
        where: { id: gameId, status: "IN_PROGRESS", version: game.version },
        data: {
          status: "CONFIRMED",
          financedNominal: financed,
          returnedNominal: returned,
          zeroReturnConfirmed: returned.isZero(),
          grossResult: check.result,
          returnOperationId: operationId,
          confirmedAt: now,
          confirmedById: actor.id,
          confirmIdempotencyKey: input.idempotencyKey,
          version: { increment: 1 },
        },
      })
      if (count !== 1) throw new ConflictError("La jugada cambió de estado.")
      await completeParticipationFromBankingGameInTx(
        tx,
        actor,
        { participationId: part.id, bankingGameId: gameId },
        ctx
      )
      await refreshCycleStatusInTx(tx, game.cycleId)
      await audit(tx, actor, ctx, AUDIT_ACTIONS.BANKING_GAME_RECONCILED, {
        entityType: "BankingGame",
        entityId: gameId,
        playerId: head.playerId,
        sessionId: head.sessionId,
        amount: fmt(returned),
        idempotencyKey: input.idempotencyKey,
        metadata: {
          financed: fmt(financed),
          returned: fmt(returned),
          zeroReturnConfirmed: returned.isZero(),
          inventoryOperationId: operationId,
          participationId: part.id,
        },
      })
      await audit(tx, actor, ctx, AUDIT_ACTIONS.BANKING_GAME_CONFIRMED, {
        entityType: "BankingGame",
        entityId: gameId,
        playerId: head.playerId,
        sessionId: head.sessionId,
        amount: fmt(check.result),
        metadata: {
          gameNumber: game.gameNumber,
          cycleId: game.cycleId,
          grossResult: fmt(check.result),
        },
      })
      // Señal temprana (informativa): anticipos pagados por encima de lo
      // que ahora está garantizado. El expediente se abre en el corte.
      const limit = await advanceLimitOf(tx, game.cycleId)
      if (limit.advances.paid.greaterThan(limit.guaranteedShare))
        await audit(
          tx,
          actor,
          ctx,
          AUDIT_ACTIONS.BANKING_EXCESS_ADVANCE_DETECTED,
          {
            entityType: "BankingCycle",
            entityId: game.cycleId,
            playerId: head.playerId,
            amount: fmt(limit.advances.paid.sub(limit.guaranteedShare)),
            metadata: {
              advancesPaid: fmt(limit.advances.paid),
              guaranteedShare: fmt(limit.guaranteedShare),
              stage: "GAME_CONFIRMED",
            },
          }
        )
      return { replayed: false, grossResult: fmt(check.result) }
    }, BANKING_TX)
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await prisma.bankingGame.findUnique({
        where: { id: gameId },
        select: { confirmIdempotencyKey: true },
      })
      if (again?.confirmIdempotencyKey === input.idempotencyKey)
        return { replayed: true }
      throw new ConflictError("La jugada ya fue conciliada por otra persona.")
    }
    await auditBankingFailure(actor, "BankingGame", gameId, error, ctx)
    throw error
  }
}

/**
 * Discrepancia física (p. ej. lo contado no coincide con lo declarado):
 * BLOQUEA la confirmación, abre una incidencia neutral y un expediente
 * privado. No genera inventario ni resultados ficticios.
 */
export async function reportDiscrepancy(
  actor: SessionUser,
  gameId: string,
  input: { description: string; idempotencyKey: string },
  ctx: RequestContext = {}
) {
  const head = await prisma.bankingGame.findUnique({
    where: { id: gameId },
    select: { playerId: true },
  })
  if (!head) throw new NotFoundError("Jugada no encontrada")
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPlayerInTx(tx, head.playerId)
      await lockBankingRow(tx, "banking_games", gameId)
      const g = await tx.bankingGame.findUniqueOrThrow({
        where: { id: gameId },
      })
      if (g.status === "PENDING_RECONCILIATION") return { replayed: true }
      if (g.status !== "IN_PROGRESS")
        throw new BusinessRuleError(
          "Solo una jugada en curso puede quedar en discrepancia."
        )
      const incident = await raiseIncidentInTx(tx, {
        source: "MANUAL",
        fingerprint: `admin-return-discrepancy:${gameId}`,
        title:
          "Discrepancia en una devolución de fichas (registro administrativo)",
        description:
          "Una devolución de fichas quedó bloqueada por discrepancia física. El detalle está en el expediente administrativo correspondiente.",
        severity: "HIGH",
        entityType: "AdministrativeRecord",
        entityId: gameId,
        actorId: actor.id,
        requestId: ctx.requestId,
      })
      await tx.bankingGame.update({
        where: { id: gameId },
        data: {
          status: "PENDING_RECONCILIATION",
          discrepancyNotes: input.description,
          incidentId: incident.id,
          version: { increment: 1 },
        },
      })
      const reg = await tx.bankingRegularization.create({
        data: {
          playerId: head.playerId,
          cycleId: g.cycleId,
          gameId,
          kind: "PHYSICAL_DISCREPANCY",
          amount: ZERO,
          description: input.description,
          incidentId: incident.id,
          openedById: actor.id,
        },
      })
      await refreshCycleStatusInTx(tx, g.cycleId)
      await audit(
        tx,
        actor,
        ctx,
        AUDIT_ACTIONS.BANKING_GAME_DISCREPANCY_REPORTED,
        {
          entityType: "BankingGame",
          entityId: gameId,
          playerId: head.playerId,
          sessionId: g.sessionId,
          reason: input.description,
          metadata: { regularizationId: reg.id, incidentId: incident.id },
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
          playerId: head.playerId,
          metadata: { kind: "PHYSICAL_DISCREPANCY", gameId },
        }
      )
      return { replayed: false, regularizationId: reg.id }
    }, BANKING_TX)
  } catch (error) {
    await auditBankingFailure(actor, "BankingGame", gameId, error, ctx)
    throw error
  }
}

/** PARTNER/SUPERADMIN aclara la discrepancia: la jugada vuelve a poder conciliarse. */
export async function resolveDiscrepancy(
  actor: SessionUser,
  gameId: string,
  input: { notes: string; idempotencyKey: string },
  ctx: RequestContext = {}
) {
  const head = await prisma.bankingGame.findUnique({
    where: { id: gameId },
    select: { playerId: true },
  })
  if (!head) throw new NotFoundError("Jugada no encontrada")
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPlayerInTx(tx, head.playerId)
      await lockBankingRow(tx, "banking_games", gameId)
      const g = await tx.bankingGame.findUniqueOrThrow({
        where: { id: gameId },
      })
      if (g.status !== "PENDING_RECONCILIATION")
        throw new BusinessRuleError(
          "La jugada no tiene una discrepancia abierta."
        )
      const now = new Date()
      await tx.bankingGame.update({
        where: { id: gameId },
        data: { status: "IN_PROGRESS", version: { increment: 1 } },
      })
      const regs = await tx.bankingRegularization.findMany({
        where: { gameId, kind: "PHYSICAL_DISCREPANCY", status: "OPEN" },
        select: { id: true },
      })
      for (const r of regs) {
        await tx.bankingRegularization.update({
          where: { id: r.id },
          data: {
            status: "RESOLVED",
            resolution: "DISCREPANCY_CLEARED",
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
            entityId: r.id,
            playerId: head.playerId,
            reason: input.notes,
            metadata: { resolution: "DISCREPANCY_CLEARED", gameId },
          }
        )
      }
      if (g.incidentId) {
        const inc = await tx.operationalIncident.findUnique({
          where: { id: g.incidentId },
          select: { status: true },
        })
        if (inc && (inc.status === "OPEN" || inc.status === "IN_REVIEW")) {
          await tx.operationalIncident.update({
            where: { id: g.incidentId },
            data: {
              status: "RESOLVED",
              resolution: "Aclarada en el expediente administrativo.",
              resolvedById: actor.id,
              resolvedAt: now,
              version: { increment: 1 },
            },
          })
          await tx.incidentHistory.create({
            data: {
              incidentId: g.incidentId,
              kind: "STATUS_CHANGED",
              fromStatus: inc.status,
              toStatus: "RESOLVED",
              notes: "Aclarada en el expediente administrativo.",
              actorId: actor.id,
            },
          })
        }
      }
      await refreshCycleStatusInTx(tx, g.cycleId)
      return { replayed: false }
    }, BANKING_TX)
  } catch (error) {
    await auditBankingFailure(actor, "BankingGame", gameId, error, ctx)
    throw error
  }
}

/**
 * Corrección AUDITADA del resultado de una jugada confirmada (recompra
 * omitida, retorno mal capturado…): PARTNER/SUPERADMIN, con motivo. El
 * resultado original se conserva; el ajuste se suma. Solo en ciclos NO
 * cerrados (un ciclo cerrado exige regularización excepcional). No mueve
 * fichas ni dinero: el inventario se concilia con su arqueo.
 */
export async function adjustGame(
  actor: SessionUser,
  gameId: string,
  input: { amount: string; reason: string; idempotencyKey: string },
  ctx: RequestContext = {}
) {
  const amount = new Prisma.Decimal(input.amount)
  const previous = await prisma.bankingGameAdjustment.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { gameId: true },
  })
  if (previous) {
    if (previous.gameId !== gameId)
      throw new ConflictError("Clave de operación reutilizada")
    return { replayed: true }
  }
  const head = await prisma.bankingGame.findUnique({
    where: { id: gameId },
    select: { playerId: true },
  })
  if (!head) throw new NotFoundError("Jugada no encontrada")
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPlayerInTx(tx, head.playerId)
      await lockBankingRow(tx, "banking_games", gameId)
      const g = await tx.bankingGame.findUniqueOrThrow({
        where: { id: gameId },
        include: { cycle: { select: { status: true } } },
      })
      if (g.status !== "CONFIRMED")
        throw new BusinessRuleError("Solo se ajusta una jugada conciliada.")
      if (g.cycle.status === "CLOSED")
        throw new BusinessRuleError(
          "El ciclo ya está cerrado: su corte no se recalcula (requiere una regularización excepcional)."
        )
      await tx.bankingGameAdjustment.create({
        data: {
          gameId,
          amount,
          reason: input.reason,
          approvedById: actor.id,
          idempotencyKey: input.idempotencyKey,
        },
      })
      await tx.bankingGame.update({
        where: { id: gameId },
        data: { version: { increment: 1 } },
      })
      await supersedeOpenClosingsInTx(
        tx,
        actor,
        head.playerId,
        "Ajuste de una jugada",
        ctx
      )
      await audit(tx, actor, ctx, AUDIT_ACTIONS.BANKING_GAME_ADJUSTED, {
        entityType: "BankingGame",
        entityId: gameId,
        playerId: head.playerId,
        sessionId: g.sessionId,
        amount: fmt(amount),
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        metadata: { originalResult: fmt(dec(g.grossResult)) },
      })
      return { replayed: false }
    }, BANKING_TX)
  } catch (error) {
    if (isUniqueViolation(error)) return { replayed: true }
    if (error instanceof AppError)
      await auditBankingFailure(actor, "BankingGame", gameId, error, ctx)
    throw error
  }
}
