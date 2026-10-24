import {
  receiptDate,
  receiptMoney,
  type ReceiptLine,
} from "@/modules/signatures/receipt.content"

/**
 * Contenido INMUTABLE del comprobante de cierre (snapshot guardado en
 * `closure_reports`). Lo que pase después (transferencias verificadas,
 * pagos a jugadores, abonos, canjes de fichas) NO lo modifica: se consulta
 * en sus propios historiales. Puro: lo usan la pantalla, el PNG y el texto.
 */

export const CLOSURE_REPORT_VERSION = "2026-10-cierre-v1"

export type ClosureReportContent = {
  version: string
  folio: string
  kind: "NORMAL" | "NO_ACTIVITY"
  noActivityReason: string | null
  session: {
    id: string
    folio: string
    openedAt: string | null
    closingStartedAt: string | null
    closedAt: string
  }
  preparedBy: { id: string; name: string }
  approvedBy: { id: string; name: string; role: string }
  approvedAt: string
  attempts: {
    attemptNumber: number
    status: string
    startedAt: string
    returnedAt: string | null
    returnReason: string | null
  }[]
  tables: {
    operated: number
    names: string[]
    cyclesClosed: number
    cycles: {
      table: string
      cycleNumber: number
      openedAt: string
      closedAt: string | null
      initialPurchases: number
      rebuys: number
      deliveredNominal: string
      returnedNominal: string
      playersFinished: number
      playersTransferred: number
    }[]
  }
  players: number
  purchases: {
    initialCount: number
    initialNominal: string
    rebuyCount: number
    rebuyNominal: string
    paidCash: string
    paidTransferConfirmed: string
    paidTransferPending: string
    paidCardApproved: string
  }
  credits: { originated: string; outstanding: string }
  abonos: { cash: string; transferConfirmed: string; card: string }
  settlements: {
    completed: number
    pendingPayout: number
    returnedNominal: string
    offsets: string
    paidCash: string
    paidTransfer: string
    transferInTransit: string
    pendingAmount: string
    pendingPlayers: number
  }
  inventory: {
    chipCountId: string | null
    expectedCustody: string
    countedCustody: string | null
    physicalDifference: string | null
    adjustments: { amount: string; reason: string; authorizedBy: string }[]
    sessionDelivered: string
    sessionReturned: string
    sessionNetNotReturned: string
    globalCirculation: string
    /** Conciliación global (desde la corrección transversal; opcional en snapshots anteriores). */
    chipReconciliation?: {
      status: string
      authorizedUnrecovered: string
      identifiedInCount: string
    }
  }
  cash: {
    cashCountId: string
    expected: string
    counted: string
    difference: string
    adjustments: { amount: string; reason: string; authorizedBy: string }[]
    withdrawal: {
      amount: string
      recipientName: string
      withdrawnBy: string
      withdrawalAt: string
      folio: string | null
    } | null
    final: string
  }
  bank: {
    incomingConfirmed: string
    incomingPending: string
    outgoingExecuted: string
    outgoingPending: string
  }
  card: { approvedInSession: string; clearingGlobal: string }
  incidents: { severity: string; title: string; detail: string }[]
  previewDigest: string
}

const m = receiptMoney

export function closureReportTitle(c: ClosureReportContent) {
  return `Cierre ${c.session.folio}`
}

/** Renglones del comprobante (pantalla y PNG comparten los mismos). */
export function closureReportLines(c: ClosureReportContent): ReceiptLine[] {
  const lines: ReceiptLine[] = [
    { label: "Folio de cierre", value: c.folio, strong: true },
    { label: "Sesión", value: c.session.folio },
    {
      label: "Tipo de cierre",
      value: c.kind === "NO_ACTIVITY" ? "Sin actividad" : "Normal",
    },
  ]
  if (c.noActivityReason)
    lines.push({ label: "Motivo (sin actividad)", value: c.noActivityReason })
  lines.push(
    {
      label: "Apertura",
      value: c.session.openedAt ? receiptDate(c.session.openedAt) : "—",
    },
    { label: "Cierre", value: receiptDate(c.session.closedAt) },
    { label: "Preparó", value: c.preparedBy.name },
    { label: "Confirmó (autorizó)", value: c.approvedBy.name },
    {
      label: "Mesas que operaron",
      value: c.tables.names.length ? c.tables.names.join(", ") : "Ninguna",
    },
    { label: "Ciclos cerrados", value: String(c.tables.cyclesClosed) },
    { label: "Jugadores", value: String(c.players) },
    {
      label: "Compras iniciales",
      value: `${c.purchases.initialCount} · ${m(c.purchases.initialNominal)}`,
    },
    {
      label: "Recompras",
      value: `${c.purchases.rebuyCount} · ${m(c.purchases.rebuyNominal)}`,
    },
    { label: "Cobrado en efectivo", value: m(c.purchases.paidCash) },
    {
      label: "Cobrado por transferencia",
      value: `${m(c.purchases.paidTransferConfirmed)} (por verificar ${m(c.purchases.paidTransferPending)})`,
    },
    { label: "Cobrado con terminal", value: m(c.purchases.paidCardApproved) },
    { label: "Créditos originados", value: m(c.credits.originated) },
    { label: "Abonos recibidos (efectivo)", value: m(c.abonos.cash) },
    {
      label: "Liquidaciones",
      value: `${c.settlements.completed} pagadas · ${c.settlements.pendingPayout} por pagar`,
    },
    {
      label: "Liquidaciones pagadas",
      value: `${m(c.settlements.paidCash)} efectivo · ${m(c.settlements.paidTransfer)} transferencia`,
    },
    {
      label: "Inventario esperado (custodia)",
      value: m(c.inventory.expectedCustody),
    },
    {
      label: "Inventario contado",
      value: c.inventory.countedCustody ? m(c.inventory.countedCustody) : "—",
    },
    {
      label: "Diferencia física de arqueo",
      value: c.inventory.physicalDifference
        ? m(c.inventory.physicalDifference)
        : "—",
      strong: true,
    }
  )
  for (const a of c.inventory.adjustments)
    lines.push({
      label: "Ajuste autorizado (fichas)",
      value: `${m(a.amount)} · ${a.authorizedBy} · ${a.reason}`,
    })
  lines.push(
    {
      label: "Fichas entregadas / devueltas",
      value: `${m(c.inventory.sessionDelivered)} / ${m(c.inventory.sessionReturned)}`,
    },
    c.inventory.chipReconciliation
      ? {
          label: "Balance nominal de la sesión",
          value:
            c.inventory.chipReconciliation.status === "RECONCILED"
              ? `Conciliado (${m(c.inventory.sessionNetNotReturned)} de diferencia autorizada)`
              : m(c.inventory.sessionNetNotReturned),
          strong: true,
        }
      : {
          label: "Valor no retornado (pendiente)",
          value: m(c.inventory.sessionNetNotReturned),
          strong: true,
        },
    {
      label: "Circulación global de fichas",
      value: m(c.inventory.globalCirculation),
    },
    { label: "Efectivo esperado", value: m(c.cash.expected) },
    { label: "Efectivo contado", value: m(c.cash.counted) },
    { label: "Diferencia de efectivo", value: m(c.cash.difference) }
  )
  for (const a of c.cash.adjustments)
    lines.push({
      label: "Ajuste autorizado (efectivo)",
      value: `${m(a.amount)} · ${a.authorizedBy} · ${a.reason}`,
    })
  lines.push(
    {
      label: "Retiro final",
      value: c.cash.withdrawal
        ? `${m(c.cash.withdrawal.amount)} → ${c.cash.withdrawal.recipientName}`
        : "Sin efectivo que retirar",
    },
    { label: "Caja final", value: m(c.cash.final), strong: true },
    {
      label: "Transferencias recibidas",
      value: `${m(c.bank.incomingConfirmed)} (pendientes ${m(c.bank.incomingPending)})`,
    },
    {
      label: "Transferencias a jugadores",
      value: `${m(c.bank.outgoingExecuted)} (en trámite ${m(c.bank.outgoingPending)})`,
    },
    {
      label: "Terminal por liquidar (global)",
      value: m(c.card.clearingGlobal),
    },
    {
      label: "Deudas de jugadores pendientes",
      value: m(c.credits.outstanding),
    },
    {
      label: "Pagos pendientes a jugadores",
      value: `${m(c.settlements.pendingAmount)} · ${c.settlements.pendingPlayers} jugador(es)`,
    }
  )
  const returns = c.attempts.filter((a) => a.status === "RETURNED_TO_OPEN")
  if (returns.length)
    lines.push({
      label: "Regresos a Abierta",
      value: returns.map((a) => a.returnReason ?? "").join(" | "),
    })
  return lines
}

/** Texto para copiar y compartir manualmente (sin enlaces ni WhatsApp). */
export function closureReportText(c: ClosureReportContent): string {
  const lines = closureReportLines(c).map((l) => `${l.label}: ${l.value}`)
  return [
    `Poker Manager · ${closureReportTitle(c)}`,
    ...lines,
    c.inventory.chipReconciliation
      ? "Ningún jugador se lleva fichas: el balance nominal de la sesión se concilia globalmente entre ambas mesas."
      : "Las fichas no retornadas quedan como valor nominal pendiente de retorno (no son faltante ni utilidad).",
  ].join("\n")
}
