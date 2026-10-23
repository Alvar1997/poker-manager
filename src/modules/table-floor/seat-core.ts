import "server-only"

import type { Prisma } from "@/generated/prisma/client"
import { ConflictError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"

/**
 * Núcleo de asientos (sin dependencias de otros servicios de mesa, para que
 * participaciones, transferencias y liquidaciones lo usen dentro de SU
 * transacción). Quien llama ya bloqueó la mesa de la sesión (FOR UPDATE):
 * todas las operaciones de asiento de una mesa quedan serializadas, y los
 * índices únicos parciales son la última defensa ante carreras.
 */

type Tx = Prisma.TransactionClient
type Db = Tx | typeof prisma

export type SeatReleaseReason =
  "SEAT_CHANGE" | "TRANSFER" | "SETTLEMENT" | "WITHDRAWAL"

export const SEAT_TAKEN_MESSAGE =
  "Ese asiento ya está ocupado. Elige otro asiento libre."

/** Asiento vigente de una participación (o null si no tiene). */
export async function openSeatOf(tx: Tx, participationId: string) {
  return tx.tableSeatAssignment.findFirst({
    where: { participationId, releasedAt: null },
    select: { id: true, seatNumber: true, cycleId: true },
  })
}

/** Confirmadas en la cadena de participaciones (origen por transferencia incluido). */
export async function chainConfirmedPurchasesInTx(
  db: Db,
  participationId: string
) {
  const rows = await db.$queryRaw<{ n: number }[]>`
    WITH RECURSIVE chain("id", "src") AS (
      SELECT tp."id", tp."sourceParticipationId" FROM "table_participations" tp WHERE tp."id" = ${participationId}
      UNION ALL
      SELECT tp."id", tp."sourceParticipationId" FROM "table_participations" tp JOIN chain ON tp."id" = chain."src"
    )
    SELECT count(*)::int AS "n" FROM "chip_purchases" cp
     WHERE cp."participationId" IN (SELECT "id" FROM chain) AND cp."status" = 'CONFIRMED'
  `
  return rows[0]?.n ?? 0
}

/**
 * Ocupa un asiento con una participación ACTIVE del ciclo vigente. No crea
 * compra, crédito, firma, entrega de fichas ni movimiento de dinero.
 */
export async function occupySeatInTx(
  tx: Tx,
  actor: SessionUser,
  input: {
    participation: {
      id: string
      sessionId: string
      sessionTableId: string
      cycleId: string
      playerId: string
    }
    seatNumber: number
    idempotencyKey: string
    previousAssignmentId?: string | null
    tableName: string
    sessionFolio?: string
  },
  ctx: RequestContext = {}
) {
  const p = input.participation
  const taken = await tx.tableSeatAssignment.findFirst({
    where: {
      cycleId: p.cycleId,
      seatNumber: input.seatNumber,
      releasedAt: null,
    },
    select: { id: true },
  })
  if (taken) throw new ConflictError(SEAT_TAKEN_MESSAGE)
  const seat = await tx.tableSeatAssignment.create({
    data: {
      sessionId: p.sessionId,
      sessionTableId: p.sessionTableId,
      cycleId: p.cycleId,
      participationId: p.id,
      playerId: p.playerId,
      seatNumber: input.seatNumber,
      assignedById: actor.id,
      assignedAt: new Date(),
      previousAssignmentId: input.previousAssignmentId ?? null,
      idempotencyKey: input.idempotencyKey,
    },
    select: { id: true, seatNumber: true },
  })
  if (!input.previousAssignmentId) {
    const confirmed = await chainConfirmedPurchasesInTx(tx, p.id)
    const metadata = {
      sessionId: p.sessionId,
      cycleId: p.cycleId,
      playerId: p.playerId,
      participationId: p.id,
      seatNumber: input.seatNumber,
      table: input.tableName,
      ...(input.sessionFolio ? { folio: input.sessionFolio } : {}),
    }
    await recordAudit(
      {
        action: AUDIT_ACTIONS.SEAT_ASSIGNED,
        entityType: "TableSeatAssignment",
        entityId: seat.id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata,
      },
      tx
    )
    if (confirmed === 0)
      await recordAudit(
        {
          action: AUDIT_ACTIONS.PLAYER_SEATED_PENDING_BUY,
          entityType: "TableParticipation",
          entityId: p.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata,
        },
        tx
      )
  }
  return seat
}

/**
 * Libera el asiento vigente de una participación (si tiene). Se llama ANTES
 * de que la participación deje de estar ACTIVE: la base lo exige.
 */
export async function releaseSeatInTx(
  tx: Tx,
  actor: SessionUser,
  participationId: string,
  reason: SeatReleaseReason,
  ctx: RequestContext = {}
) {
  const seat = await tx.tableSeatAssignment.findFirst({
    where: { participationId, releasedAt: null },
    select: {
      id: true,
      seatNumber: true,
      sessionId: true,
      cycleId: true,
      playerId: true,
    },
  })
  if (!seat) return null
  const { count } = await tx.tableSeatAssignment.updateMany({
    where: { id: seat.id, releasedAt: null },
    data: {
      releasedAt: new Date(),
      releasedById: actor.id,
      releaseReason: reason,
    },
  })
  if (count !== 1) throw new ConflictError("El asiento cambió de estado")
  if (reason !== "SEAT_CHANGE")
    await recordAudit(
      {
        action: AUDIT_ACTIONS.SEAT_RELEASED,
        entityType: "TableSeatAssignment",
        entityId: seat.id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          sessionId: seat.sessionId,
          cycleId: seat.cycleId,
          playerId: seat.playerId,
          participationId,
          seatNumber: seat.seatNumber,
          releaseReason: reason,
        },
      },
      tx
    )
  return seat
}
