/**
 * Contenido del comprobante digital (puro: lo usan servidor, pantalla e
 * imagen PNG, así ambos muestran exactamente lo mismo). Importes como
 * strings decimales calculados por el servidor; nunca denominaciones,
 * teléfonos ni datos de tarjeta.
 */
export type ReceiptContent = {
  receiptFormat: "1"
  purchaseId: string
  folio: string
  confirmedAt: string
  player: { id: string; name: string }
  session: { id: string; folio: string }
  table: { id: string; name: string }
  purchaseType: "INITIAL_PURCHASE" | "REBUY"
  rebuyNumber: number | null
  purchaseLabel: string
  nominalAmount: string
  payments: { method: string; amount: string; reference: string | null }[]
  confirmedPayments: string
  pendingTransfers: string
  initialCredit: string
  partner: { name: string; channel: "VERBAL" | "MESSAGE" } | null
  deliveryStatus: "DELIVERED"
  deliveredBy: string
  deliveredAt: string
  signature: {
    signatureId: string
    signedAt: string
    snapshotHash: string
  } | null
  operationReference: { deliveryId: string; inventoryOperationId: string }
}

export const RECEIPT_METHOD_LABEL: Record<string, string> = {
  CASH: "Efectivo",
  BANK_TRANSFER: "Transferencia verificada",
  CARD_DEBIT: "Tarjeta de débito (terminal)",
  CARD_CREDIT: "Tarjeta de crédito (terminal)",
}

const mxn = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
})
export const receiptMoney = (v: string) => mxn.format(v as unknown as number)

const dateFmt = new Intl.DateTimeFormat("es-MX", {
  timeZone: "America/Monterrey",
  dateStyle: "medium",
  timeStyle: "short",
})
export const receiptDate = (iso: string) => dateFmt.format(new Date(iso))

export type ReceiptLine = { label: string; value: string; strong?: boolean }

/** Renglones del comprobante, compartidos por la pantalla y el PNG. */
export function receiptLines(c: ReceiptContent): ReceiptLine[] {
  const lines: ReceiptLine[] = [
    { label: "Jugador", value: c.player.name },
    { label: "Sesión", value: c.session.folio },
    { label: "Mesa", value: c.table.name },
    { label: "Tipo", value: c.purchaseLabel },
    {
      label: "Importe entregado",
      value: receiptMoney(c.nominalAmount),
      strong: true,
    },
  ]
  for (const p of c.payments)
    lines.push({
      label: RECEIPT_METHOD_LABEL[p.method] ?? p.method,
      value: receiptMoney(p.amount),
    })
  lines.push({
    label: "Pagos confirmados",
    value: receiptMoney(c.confirmedPayments),
  })
  if (c.pendingTransfers !== "0.00")
    lines.push({
      label: "Transferencia pendiente (no cobrada)",
      value: receiptMoney(c.pendingTransfers),
    })
  lines.push({
    label: "Crédito inicial",
    value: receiptMoney(c.initialCredit),
    strong: c.initialCredit !== "0.00",
  })
  if (c.partner)
    lines.push({
      label: "Crédito autorizado por",
      value: `${c.partner.name} (${c.partner.channel === "VERBAL" ? "verbal" : "mensaje"})`,
    })
  lines.push(
    { label: "Entrega", value: "Confirmada" },
    { label: "Cajero", value: c.deliveredBy },
    {
      label: "Firma",
      value: c.signature ? "Firmado por el jugador" : "No requerida (pagada)",
    }
  )
  return lines
}

/** Resumen textual para copiar y compartir manualmente (sin datos sensibles). */
export function receiptText(c: ReceiptContent, status: string): string {
  return [
    `Poker Manager · Comprobante ${c.folio}${status === "VOIDED" ? " (ANULADO)" : ""}`,
    receiptDate(c.confirmedAt),
    ...receiptLines(c).map((l) => `${l.label}: ${l.value}`),
  ].join("\n")
}
