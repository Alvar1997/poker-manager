import "server-only"

import { BusinessRuleError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"

/**
 * CONTRATO con el módulo de sesiones (Módulo 06).
 *
 * La caja no inventa sesiones: toda operación de efectivo pregunta a este
 * gateway si la sesión existe y en qué estado está. La implementación por
 * defecto lee `poker_sessions` (Módulo 06). Las pruebas pueden inyectar un
 * adaptador (`fixtureSessionGateway`).
 *
 * Estados (los de `PokerSessionStatus`):
 *  - DRAFT:       creada; aún sin controles.
 *  - PREPARATION: se cuentan fichas y efectivo (apertura en $0).
 *  - OPEN:        habilitada; admite cobros, aportaciones, retiros, traslados.
 *  - CLOSING:     cierre en curso; arqueo de cierre y retiro total (Módulo 12).
 *  - CLOSED / CANCELLED: sin operaciones de efectivo.
 */

export type SessionStatus =
  "DRAFT" | "PREPARATION" | "OPEN" | "CLOSING" | "CLOSED" | "CANCELLED"

export type OperationalSession = { id: string; status: SessionStatus }

export interface SessionGateway {
  /** La sesión operativa abierta, si existe. */
  getOpenSession(): Promise<OperationalSession | null>
  /** Sesión por id, o null si no existe. */
  getSession(sessionId: string): Promise<OperationalSession | null>
}

export const NO_SESSION_MESSAGE =
  "No hay una sesión operativa abierta. Las operaciones de efectivo se habilitan al abrir una sesión."

/** Adaptador sin sesiones (pruebas unitarias). */
export const pendingSessionGateway: SessionGateway = {
  async getOpenSession() {
    return null
  },
  async getSession() {
    return null
  },
}

/** Implementación real: sesiones del Módulo 06 en PostgreSQL. */
export const prismaSessionGateway: SessionGateway = {
  async getOpenSession() {
    const s = await prisma.pokerSession.findFirst({
      where: { status: "OPEN" },
      select: { id: true, status: true },
    })
    return s
  },
  async getSession(sessionId) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) return null
    return prisma.pokerSession.findUnique({
      where: { id: sessionId },
      select: { id: true, status: true },
    })
  },
}

let activeGateway: SessionGateway = prismaSessionGateway

/** Permite sustituir la implementación (pruebas). */
export function registerSessionGateway(gateway: SessionGateway) {
  activeGateway = gateway
}

export function currentSessionGateway(): SessionGateway {
  return activeGateway
}

/** Exige que la sesión exista y esté en uno de los estados permitidos. */
export async function requireSessionStatus(
  gateway: SessionGateway,
  sessionId: string,
  allowed: SessionStatus[]
): Promise<OperationalSession> {
  const session = await gateway.getSession(sessionId)
  if (!session) throw new BusinessRuleError(NO_SESSION_MESSAGE)
  if (!allowed.includes(session.status)) {
    throw new BusinessRuleError(
      `La sesión está en estado ${session.status}: esta operación requiere ${allowed.join(" o ")}.`
    )
  }
  return session
}

/** Adaptador para PRUEBAS: sesiones en memoria con el estado indicado. */
export function fixtureSessionGateway(
  sessions: Record<string, SessionStatus>
): SessionGateway {
  return {
    async getOpenSession() {
      const open = Object.entries(sessions).find(
        ([, status]) => status === "OPEN"
      )
      return open ? { id: open[0], status: "OPEN" } : null
    },
    async getSession(sessionId) {
      const status = sessions[sessionId]
      return status ? { id: sessionId, status } : null
    },
  }
}
