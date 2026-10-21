import {
  receiptDate,
  receiptMoney,
  type ReceiptLine,
} from "@/modules/signatures/receipt.content"

/**
 * Contenido del comprobante de ABONO (puro: pantalla, texto y PNG usan los
 * mismos renglones). Fotografía histórica: no cambia con abonos posteriores.
 */
export type CreditReceiptContent = {
  receiptFormat: "1"
  paymentId: string
  folio: string
  confirmedAt: string
  player: { id: string; name: string }
  method: "CASH" | "BANK_TRANSFER" | "CARD_DEBIT" | "CARD_CREDIT"
  amount: string
  applied: string
  /** Dinero recibido que no pudo aplicarse (pendiente de devolución). */
  unapplied: string
  origin: "SESSION" | "ADMINISTRATIVE"
  session: { id: string; folio: string } | null
  financialReference: string | null
  confirmedBy: string
  allocations: {
    order: number
    purchaseFolio: string
    sessionFolio: string
    tableName: string
    amount: string
    balanceAfter: string
  }[]
  remainingOutstanding: string
}

export const CREDIT_METHOD_LABEL: Record<string, string> = {
  CASH: "Efectivo",
  BANK_TRANSFER: "Transferencia verificada",
  CARD_DEBIT: "Tarjeta de débito (terminal)",
  CARD_CREDIT: "Tarjeta de crédito (terminal)",
}

export function creditReceiptLines(c: CreditReceiptContent): ReceiptLine[] {
  const lines: ReceiptLine[] = [
    { label: "Jugador", value: c.player.name },
    { label: "Método", value: CREDIT_METHOD_LABEL[c.method] ?? c.method },
    {
      label: "Importe confirmado",
      value: receiptMoney(c.amount),
      strong: true,
    },
    {
      label: "Origen",
      value:
        c.origin === "SESSION"
          ? `Sesión ${c.session?.folio ?? ""}`
          : "Administrativo (fuera de sesión)",
    },
  ]
  for (const a of c.allocations)
    lines.push({
      label: `${a.order}. ${a.purchaseFolio} (${a.tableName})`,
      value: `${receiptMoney(a.amount)} → resta ${receiptMoney(a.balanceAfter)}`,
    })
  if (c.unapplied !== "0.00")
    lines.push({
      label: "Recibido sin aplicar (por devolver)",
      value: receiptMoney(c.unapplied),
    })
  lines.push(
    {
      label: "Deuda total restante",
      value: receiptMoney(c.remainingOutstanding),
      strong: true,
    },
    { label: "Recibió", value: c.confirmedBy }
  )
  if (c.financialReference)
    lines.push({ label: "Movimiento", value: c.financialReference })
  return lines
}

export function creditReceiptText(c: CreditReceiptContent, status: string) {
  return [
    `Poker Manager · Comprobante de abono ${c.folio}${status === "VOIDED" ? " (ANULADO)" : ""}`,
    receiptDate(c.confirmedAt),
    ...creditReceiptLines(c).map((l) => `${l.label}: ${l.value}`),
  ].join("\n")
}
