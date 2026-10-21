import "server-only"

import { BusinessRuleError, ForbiddenError, NotFoundError } from "@/lib/errors"
import type { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import {
  canManagePreparation,
  isSuperadminIntervention,
  PREPARATION_FORBIDDEN_MESSAGE,
  SESSION_STATUS_LABEL,
  type SessionStatusValue,
} from "@/modules/sessions/session.state"

type Db = Prisma.TransactionClient | typeof prisma

/**
 * Control de acceso a la PREPARACIÓN de una sesión, compartido por los
 * servicios de sesiones, arqueos de fichas (Módulo 04) y arqueos de efectivo
 * (Módulo 05): nadie puede saltarse la regla del creador entrando por los
 * endpoints genéricos de arqueo.
 */
export async function assertPreparationAccess(
  db: Db,
  actor: { id: string; role: string },
  sessionId: string,
  allowedStatuses: SessionStatusValue[] = ["PREPARATION"]
) {
  const session = await db.pokerSession.findUnique({
    where: { id: sessionId },
    select: { id: true, folio: true, status: true, createdById: true },
  })
  if (!session) throw new NotFoundError("Sesión no encontrada")
  if (!canManagePreparation(actor, session)) {
    throw new ForbiddenError(PREPARATION_FORBIDDEN_MESSAGE)
  }
  if (!allowedStatuses.includes(session.status)) {
    throw new BusinessRuleError(
      `La sesión ${session.folio} está ${SESSION_STATUS_LABEL[session.status].toLowerCase()}: esta acción requiere que esté ${allowedStatuses
        .map((s) => SESSION_STATUS_LABEL[s].toLowerCase())
        .join(" o ")}.`
    )
  }
  return { ...session, intervention: isSuperadminIntervention(actor, session) }
}
