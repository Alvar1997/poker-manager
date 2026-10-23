/** Etiquetas de la sección privada de bancaje (Módulo 17). Puro. */

export const BANKING_BASE = "/dashboard/administracion/bancaje"
export const BANKING_API = "/api/admin/banking"

export const CYCLE_STATUS: Record<string, string> = {
  IN_PROGRESS: "En curso",
  READY_FOR_REVIEW: "Listo para corte",
  UNDER_REVIEW: "Corte en revisión",
  UNDER_REGULARIZATION: "En regularización",
  CLOSED: "Cerrado",
}
export const GAME_STATUS: Record<string, string> = {
  IN_PROGRESS: "En curso",
  PENDING_RECONCILIATION: "Discrepancia pendiente",
  CONFIRMED: "Confirmada",
  UNDER_CORRECTION: "En corrección",
}
export const CLOSING_STATUS: Record<string, string> = {
  UNDER_REVIEW: "En revisión",
  APPROVED: "Aprobado",
  REJECTED: "Rechazado",
  SUPERSEDED: "Sustituido",
}
export const ADVANCE_STATUS: Record<string, string> = {
  AUTHORIZED: "Autorizado",
  PARTIALLY_PAID: "Pagado parcialmente",
  PAID: "Pagado",
  CLOSED: "Cerrado",
}
export const WITHDRAWAL_STATUS: Record<string, string> = {
  REQUESTED: "Solicitado",
  APPROVED: "Aprobado",
  PARTIALLY_PAID: "Pagado parcialmente",
  PAID: "Pagado",
  CLOSED: "Cerrado",
  REJECTED: "Rechazado",
  CANCELLED: "Cancelado",
}
export const REG_STATUS: Record<string, string> = {
  OPEN: "Abierta",
  AWAITING_RETURN: "Esperando devolución",
  RECOVERING: "Recuperándose",
  RESOLVED: "Resuelta",
}
export const REG_KIND: Record<string, string> = {
  EXCESS_ADVANCE: "Anticipo excedido",
  PHYSICAL_DISCREPANCY: "Discrepancia física",
}
export const RESERVE_KIND: Record<string, string> = {
  CREATED: "Reserva creada (+)",
  CONSUMED_BY_LOSS: "Cubrió pérdidas (−)",
  CONSUMED_BY_REGULARIZATION: "Aplicada a regularización (−)",
  RECLASSIFIED_TO_WITHDRAWAL: "Comprometida por retiro (−)",
  RELEASED_FROM_WITHDRAWAL: "Remanente liberado (+)",
}
export const CHANNEL: Record<string, string> = {
  VERBAL: "Verbal",
  MESSAGE: "Mensaje",
}
export const REQUEST_STATUS: Record<string, string> = {
  PENDING: "Pendiente",
  APPROVED: "Aprobada",
  REJECTED: "Rechazada",
  CANCELLED: "Cancelada",
}
