/**
 * Formato SOLO para mostrar importes que ya calculó el servidor (strings
 * decimales "1500.00"). Intl formatea el string decimal tal cual, sin
 * convertirlo a número de punto flotante. Ningún total se calcula aquí.
 */
const mxn = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
})

export function formatMXN(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—"
  return mxn.format(value as unknown as number)
}

export const CASH_BASE = "/dashboard/caja"

export const TRANSFER_STATUS_LABEL: Record<string, string> = {
  PENDING_VERIFICATION: "Pendiente de verificación",
  CONFIRMED: "Confirmada",
  REJECTED: "Rechazada",
  CANCELLED: "Cancelada",
}

export const RECONCILIATION_TYPE_LABEL: Record<string, string> = {
  OPENING: "Apertura",
  CONTROL: "Control",
  CLOSING: "Cierre",
}

export const RECONCILIATION_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Borrador",
  CONFIRMED: "Confirmado",
  CANCELLED: "Cancelado",
}

export const DIFFERENCE_STATUS_LABEL: Record<string, string> = {
  NOT_REQUIRED: "Sin diferencia",
  PENDING: "Diferencia pendiente",
  ADJUSTED: "Diferencia ajustada",
}

export const MOVEMENT_STATUS_LABEL: Record<string, string> = {
  ACTIVE: "Vigente",
  REVERSED: "Revertido",
  REVERSAL: "Reverso",
}
