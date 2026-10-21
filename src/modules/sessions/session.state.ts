/**
 * Máquina de estados de una sesión (lógica pura; la base la vuelve a exigir
 * con el trigger `poker_sessions_guard`).
 *
 *   DRAFT → PREPARATION → OPEN ⇄ CLOSING → CLOSED
 *     ↘ CANCELLED   ↘ CANCELLED (si no hay efectos pendientes)
 *
 * Nunca: OPEN → PREPARATION, CLOSED → OPEN/CLOSING, CANCELLED → OPEN,
 * CLOSED → DRAFT. OPEN → CLOSING, CLOSING → OPEN (regreso auditado con
 * motivo) y CLOSING → CLOSED pertenecen al cierre (Módulo 12).
 */
export const SESSION_STATUSES = [
  "DRAFT",
  "PREPARATION",
  "OPEN",
  "CLOSING",
  "CLOSED",
  "CANCELLED",
] as const
export type SessionStatusValue = (typeof SESSION_STATUSES)[number]

/** Vigentes: como máximo UNA a la vez (índice único parcial en la base). */
export const ACTIVE_SESSION_STATUSES: readonly SessionStatusValue[] = [
  "DRAFT",
  "PREPARATION",
  "OPEN",
  "CLOSING",
]

export const SESSION_TRANSITIONS: Record<
  SessionStatusValue,
  readonly SessionStatusValue[]
> = {
  DRAFT: ["PREPARATION", "CANCELLED"],
  PREPARATION: ["OPEN", "CANCELLED"],
  OPEN: ["CLOSING"],
  CLOSING: ["OPEN", "CLOSED"],
  CLOSED: [],
  CANCELLED: [],
}

export const SESSION_STATUS_LABEL: Record<SessionStatusValue, string> = {
  DRAFT: "Borrador",
  PREPARATION: "En preparación",
  OPEN: "Abierta",
  CLOSING: "En cierre",
  CLOSED: "Cerrada",
  CANCELLED: "Cancelada",
}

export function canTransition(
  from: SessionStatusValue,
  to: SessionStatusValue
): boolean {
  return SESSION_TRANSITIONS[from].includes(to)
}

export function isActiveSessionStatus(status: SessionStatusValue): boolean {
  return ACTIVE_SESSION_STATUSES.includes(status)
}

/**
 * Regla del creador (CRE-01…12): la preparación y la confirmación de
 * apertura solo las continúa quien creó la sesión, o SUPERADMIN. No basta
 * con tener el mismo rol que el creador.
 */
export function canManagePreparation(
  actor: { id: string; role: string },
  session: { createdById: string }
): boolean {
  return actor.role === "SUPERADMIN" || actor.id === session.createdById
}

/** SUPERADMIN actuando sobre una preparación ajena (se audita como intervención). */
export function isSuperadminIntervention(
  actor: { id: string; role: string },
  session: { createdById: string }
): boolean {
  return actor.role === "SUPERADMIN" && actor.id !== session.createdById
}

export const PREPARATION_FORBIDDEN_MESSAGE =
  "No tienes permiso para modificar la preparación de esta sesión: solo quien la creó o un superadministrador pueden continuarla."
