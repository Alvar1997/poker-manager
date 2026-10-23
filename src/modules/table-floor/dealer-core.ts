import "server-only"

import type { Prisma } from "@/generated/prisma/client"
import { ConflictError } from "@/lib/errors"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"

type Tx = Prisma.TransactionClient

/**
 * Libera al dealer vigente de un ciclo (si hay). Lo usa el cierre de mesa
 * (`CYCLE_CLOSED`) dentro de SU transacción: la base no deja cerrar un ciclo
 * con dealer asignado. Sin dependencias de otros servicios de mesa.
 */
export async function releaseDealerOfCycleInTx(
  tx: Tx,
  actor: SessionUser,
  cycleId: string,
  reason: "CHANGED" | "RELEASED" | "CYCLE_CLOSED",
  ctx: RequestContext & { releaseIdempotencyKey?: string } = {}
) {
  const current = await tx.dealerAssignment.findFirst({
    where: { cycleId, releasedAt: null },
    select: { id: true, dealerId: true, sessionId: true },
  })
  if (!current) return null
  const { count } = await tx.dealerAssignment.updateMany({
    where: { id: current.id, releasedAt: null },
    data: {
      releasedAt: new Date(),
      releasedById: actor.id,
      releaseReason: reason,
      releaseIdempotencyKey: ctx.releaseIdempotencyKey ?? null,
    },
  })
  if (count !== 1) throw new ConflictError("La asignación del dealer cambió")
  if (reason !== "CHANGED")
    await recordAudit(
      {
        action: AUDIT_ACTIONS.DEALER_RELEASED,
        entityType: "DealerAssignment",
        entityId: current.id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          sessionId: current.sessionId,
          cycleId,
          dealerId: current.dealerId,
          releaseReason: reason,
        },
      },
      tx
    )
  return current
}
