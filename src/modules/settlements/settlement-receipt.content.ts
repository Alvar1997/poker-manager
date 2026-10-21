import {
  receiptDate,
  receiptMoney,
  type ReceiptLine,
} from "@/modules/signatures/receipt.content"

/**
 * Contenido de los comprobantes de LIQUIDACIÓN (puro: pantalla, texto y PNG
 * usan los mismos renglones). Fotografía histórica tomada al emitirse:
 *
 *  - RECEPTION: recepción de fichas, compensación, pago neto ACORDADO y lo
 *    realmente pagado hasta ese momento (nunca pagos inventados).
 *  - PAYOUT: anexo de cada desembolso ejecutado después.
 *
 * Los pagos posteriores no modifican el comprobante de recepción. Sin
 * denominaciones, teléfonos, cuentas bancarias completas ni PDF.
 */
export type SettlementReceiptContent = {
  receiptFormat: "1"
  kind: "RECEPTION" | "PAYOUT"
  settlementId: string
  folio: string
  issuedAt: string
  player: { id: string; name: string }
  session: { id: string; folio: string }
  table: { id: string; name: string }
  returnedNominalAmount: string
  offsetDecision: "NO_COMPENSATE" | "PARTIAL" | "MAXIMUM"
  offsetAmount: string
  allocations: {
    order: number
    purchaseFolio: string
    tableName: string
    amount: string
    balanceAfter: string
  }[]
  remainingDebt: string
  netPayoutAmount: string
  /** Pagado realmente al emitir (solo desembolsos ejecutados). */
  paidAtIssue: string
  /** Transferencias en trámite al emitir (NO pagadas). */
  inTransitAtIssue: string
  /** Pendiente de pago al emitir = neto − pagado. */
  pendingAtIssue: string
  payouts: {
    sequence: number
    method: "CASH" | "BANK_TRANSFER"
    funding: "SESSION_CASH" | "ADMIN_CUSTODY" | "BANK"
    amount: string
    reference: string | null
    executedAt: string
  }[]
  /** Solo en un anexo PAYOUT: el desembolso que documenta. */
  payout: {
    sequence: number
    method: "CASH" | "BANK_TRANSFER"
    funding: "SESSION_CASH" | "ADMIN_CUSTODY" | "BANK"
    amount: string
    reference: string | null
    executedAt: string
  } | null
  settlementStatus: "PENDING_PAYOUT" | "COMPLETED"
  receivedBy: string
  receivedAt: string
  issuedBy: string
  signature: { signatureId: string; signedAt: string; snapshotDigest: string }
  chipReturnOperationId: string | null
}

export const OFFSET_DECISION_LABEL: Record<string, string> = {
  NO_COMPENSATE: "No compensar",
  PARTIAL: "Compensación parcial",
  MAXIMUM: "Compensación máxima",
}

export const PAYOUT_METHOD_LABEL: Record<string, string> = {
  CASH: "Efectivo",
  BANK_TRANSFER: "Transferencia",
}

export const PAYOUT_FUNDING_LABEL: Record<string, string> = {
  SESSION_CASH: "caja de la sesión",
  ADMIN_CUSTODY: "custodia administrativa",
  BANK: "cuenta bancaria",
}

function payoutLabel(p: SettlementReceiptContent["payouts"][number]) {
  return `Pago ${p.sequence}: ${PAYOUT_METHOD_LABEL[p.method]} (${PAYOUT_FUNDING_LABEL[p.funding]})`
}

/** Renglones del comprobante, compartidos por la pantalla y el PNG. */
export function settlementReceiptLines(
  c: SettlementReceiptContent
): ReceiptLine[] {
  const lines: ReceiptLine[] = [
    { label: "Jugador", value: c.player.name },
    { label: "Sesión", value: c.session.folio },
    { label: "Mesa final", value: c.table.name },
  ]
  if (c.kind === "PAYOUT" && c.payout) {
    lines.push(
      {
        label: payoutLabel(c.payout),
        value: receiptMoney(c.payout.amount),
        strong: true,
      },
      ...(c.payout.reference
        ? [{ label: "Referencia", value: c.payout.reference }]
        : []),
      { label: "Ejecutado", value: receiptDate(c.payout.executedAt) },
      { label: "Pago neto acordado", value: receiptMoney(c.netPayoutAmount) },
      { label: "Pagado a la fecha", value: receiptMoney(c.paidAtIssue) },
      {
        label: "Pendiente de pago",
        value: receiptMoney(c.pendingAtIssue),
        strong: true,
      },
      { label: "Registró", value: c.issuedBy }
    )
    return lines
  }
  lines.push(
    {
      label: "Fichas devueltas (valor nominal)",
      value: receiptMoney(c.returnedNominalAmount),
      strong: true,
    },
    {
      label: "Decisión de compensación",
      value: OFFSET_DECISION_LABEL[c.offsetDecision] ?? c.offsetDecision,
    },
    { label: "Deuda compensada", value: receiptMoney(c.offsetAmount) }
  )
  for (const a of c.allocations)
    lines.push({
      label: `${a.order}. ${a.purchaseFolio} (${a.tableName})`,
      value: `${receiptMoney(a.amount)} → resta ${receiptMoney(a.balanceAfter)}`,
    })
  lines.push(
    { label: "Deuda restante", value: receiptMoney(c.remainingDebt) },
    {
      label: "Pago neto acordado",
      value: receiptMoney(c.netPayoutAmount),
      strong: true,
    }
  )
  for (const p of c.payouts)
    lines.push({ label: payoutLabel(p), value: receiptMoney(p.amount) })
  lines.push({
    label: "Pagado al emitir",
    value: receiptMoney(c.paidAtIssue),
  })
  if (c.inTransitAtIssue !== "0.00")
    lines.push({
      label: "Transferencia en trámite (no pagada)",
      value: receiptMoney(c.inTransitAtIssue),
    })
  lines.push(
    {
      label: "Pendiente de pago",
      value: receiptMoney(c.pendingAtIssue),
      strong: c.pendingAtIssue !== "0.00",
    },
    { label: "Recibió las fichas", value: c.receivedBy },
    { label: "Firma", value: "Firmado por el jugador" },
    {
      label: "Estado",
      value:
        c.settlementStatus === "COMPLETED" ? "Pagada" : "Pendiente de pago",
    }
  )
  return lines
}

export function settlementReceiptTitle(c: SettlementReceiptContent) {
  return c.kind === "PAYOUT" && c.payout
    ? `${c.folio} · Pago ${c.payout.sequence}`
    : c.folio
}

/** Resumen textual para copiar y compartir manualmente (sin datos sensibles). */
export function settlementReceiptText(
  c: SettlementReceiptContent,
  status: string
): string {
  return [
    `Poker Manager · ${c.kind === "PAYOUT" ? "Anexo de pago" : "Comprobante de liquidación"} ${settlementReceiptTitle(c)}${status === "VOIDED" ? " (ANULADO)" : ""}`,
    receiptDate(c.issuedAt),
    ...settlementReceiptLines(c).map((l) => `${l.label}: ${l.value}`),
  ].join("\n")
}
