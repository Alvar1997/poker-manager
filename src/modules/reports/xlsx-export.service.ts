import "server-only"

import ExcelJS from "exceljs"

import { formatDateTime } from "@/lib/format"
import { AUDIT_ACTIONS, recordAuditSafe } from "@/modules/audit/audit.service"
import { getChipReport } from "@/modules/reports/chip-report.service"
import { getComparisons } from "@/modules/reports/comparative-report.service"
import {
  creditTotals,
  getCreditTree,
  listAllCreditPayments,
  listSettlementOffsets,
  type PaymentReportRow,
} from "@/modules/reports/credit-report.service"
import { getDashboard } from "@/modules/reports/dashboard-report.service"
import {
  getFinancialReport,
  sessionCashBooks,
  type SessionCashBookRow,
} from "@/modules/reports/financial-report.service"
import {
  listPlayerStats,
  type PlayerStatRow,
} from "@/modules/reports/player-report.service"
import {
  listAllPurchaseReports,
  listAllSettlementReports,
  purchaseTotals,
  settlementTotals,
  type PurchaseReportRow,
  type SettlementReportRow,
} from "@/modules/reports/purchase-report.service"
import {
  activeFilters,
  type ReportFilters,
  type ReportKind,
} from "@/modules/reports/report.filters"
import { purchaseTypeLabel } from "@/modules/reports/report.math"
import {
  listAllSessionReports,
  listTableCycles,
  type SessionReportRow,
  type TableCycleRow,
} from "@/modules/reports/session-report.service"
import { safeText, type Column } from "@/modules/reports/xlsx.cells"
import { addKeyValues, addTable } from "@/modules/reports/xlsx.workbook"

/**
 * Exportación EXCLUSIVA a XLSX (Módulo 14, DEC-01..03: sin CSV ni PDF).
 *
 * Cada libro se construye con los MISMOS servicios que alimentan la
 * pantalla y la API (nunca otra fórmula). Respeta filtros validados y
 * permisos (los verifica la ruta), aplica formato MXN y fechas locales,
 * conserva importes numéricos, agrega totales verificables y una hoja con
 * los criterios y la fecha de generación. Se audita cada exportación.
 */

export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

export const EXPORT_TITLES: Record<ReportKind, string> = {
  dashboard: "Dashboard",
  sessions: "Sesiones",
  tables: "Mesas",
  purchases: "Compras",
  financial: "Finanzas",
  credits: "Creditos",
  payments: "Abonos",
  settlements: "Liquidaciones",
  chips: "Fichas",
  players: "Jugadores",
  comparisons: "Comparativos",
}

const RULE_CREDITS =
  "Toda deuda debe poder consultarse de forma global por jugador, desglosada por sesión de origen y finalmente por cada compra o recompra. Los pagos posteriores se aplican a las obligaciones originales y no trasladan la deuda a la fecha o sesión del pago."
const RULE_CHIPS =
  "Ningún jugador se lleva fichas: al terminar entrega todas las que tiene (o confirma $0). Los resultados individuales (devuelto − comprado) se compensan entre jugadores y no son faltante. Una diferencia nominal GLOBAL de la sesión se concilia en el cierre (retorno identificado en el arqueo o diferencia autorizada); la circulación de sesiones anteriores es un registro histórico por revisar y nunca se paga sin presentación y validación física."
const RULE_NO_PROFIT =
  "Este reporte no declara utilidad neta: no existe una fórmula contable validada. Las cifras nominales, monetarias, por cobrar y por pagar se presentan por separado."

function addCriteria(
  wb: ExcelJS.Workbook,
  kind: ReportKind,
  f: ReportFilters,
  meta: {
    generatedAt: Date
    generatedBy: string
    rows: number
    notes: string[]
  }
) {
  const ws = wb.addWorksheet("Filtros y fecha")
  ws.getColumn(1).width = 34
  ws.getColumn(2).width = 90
  const add = (a: string, b: string) => ws.addRow([safeText(a), safeText(b)])
  ws.getRow(1).values = ["Criterio", "Valor"]
  ws.getRow(1).font = { bold: true }
  add("Reporte", EXPORT_TITLES[kind])
  add("Generado", formatDateTime(meta.generatedAt))
  add("Generado por", meta.generatedBy)
  add(
    "Periodo",
    f.from || f.to
      ? `${f.from ?? "inicio"} a ${f.to ?? "hoy"} (días operativos, America/Monterrey)`
      : "Sin periodo (todo el historial)"
  )
  const active = activeFilters(f)
  if (active.length === 0) add("Filtros", "Ninguno")
  for (const a of active) add(a.label, a.value)
  add("Filas exportadas", String(meta.rows))
  add("Moneda", "MXN. Importes numéricos con dos decimales.")
  for (const n of meta.notes) add("Nota", n)
}

// ── Libros por reporte ────────────────────────────────────────────────

const money = <T>(
  header: string,
  value: (r: T) => unknown,
  total?: string
): Column<T> => ({
  header,
  type: "money",
  value,
  total,
})
const text = <T>(
  header: string,
  value: (r: T) => unknown,
  width?: number
): Column<T> => ({
  header,
  type: "text",
  value,
  width,
})
const dt = <T>(header: string, value: (r: T) => unknown): Column<T> => ({
  header,
  type: "datetime",
  value,
})
const day = <T>(header: string, value: (r: T) => unknown): Column<T> => ({
  header,
  type: "day",
  value,
})
const int = <T>(
  header: string,
  value: (r: T) => unknown,
  total?: string
): Column<T> => ({
  header,
  type: "int",
  value,
  total,
})

async function creditsWorkbook(wb: ExcelJS.Workbook, f: ReportFilters) {
  const tree = await getCreditTree(f)
  const totals = creditTotals(tree)
  const payments = await listAllCreditPayments({ ...f, status: undefined })
  addKeyValues(wb, "Resumen global", [
    { label: "Crédito original acumulado", value: totals.original },
    { label: "Abonos aplicados (FIFO)", value: totals.payments },
    { label: "Pagos vinculados a la compra", value: totals.linkedPayments },
    { label: "Compensaciones con fichas", value: totals.offsets },
    { label: "Reversos de aplicaciones", value: totals.reversals },
    { label: "Deuda global pendiente", value: totals.balance },
    { label: "Jugadores", value: totals.players, type: "int" },
    {
      label: "Jugadores con saldo",
      value: totals.playersWithBalance,
      type: "int",
    },
    {
      label: "Deuda pendiente más antigua",
      value: totals.oldestOpenDebtAt
        ? formatDateTime(totals.oldestOpenDebtAt)
        : "—",
      type: "text",
    },
  ])
  type P = (typeof tree)[number]
  addTable<P>(
    wb,
    "Deudas por jugador",
    [
      text("Jugador", (r) => r.player.name, 28),
      money("Crédito original", (r) => r.original, totals.original),
      money(
        "Abonos y pagos aplicados",
        (r) => r.paymentsApplied,
        totals.paymentsApplied
      ),
      money("Compensaciones", (r) => r.offsets, totals.offsets),
      money("Reversos", (r) => r.reversals, totals.reversals),
      money("Saldo actual", (r) => r.balance, totals.balance),
      int("Sesiones con saldo", (r) => r.sessionsWithBalance),
      int("Obligaciones", (r) => r.debtsCount),
      dt("Deuda pendiente más antigua", (r) => r.oldestOpenDebtAt),
      dt("Último movimiento", (r) => r.lastMovementAt),
    ],
    tree
  )
  const sessions = tree.flatMap((p) => p.sessions.map((s) => ({ p, s })))
  type S = (typeof sessions)[number]
  addTable<S>(
    wb,
    "Deudas por sesión",
    [
      text("Jugador", (r) => r.p.player.name, 28),
      text("Sesión", (r) => r.s.session.folio),
      day("Fecha operativa", (r) => r.s.session.operatedDay),
      text("Estado de la sesión", (r) => r.s.session.status),
      money("Crédito original", (r) => r.s.original, totals.original),
      money(
        "Abonos confirmados",
        (r) => r.s.paymentsApplied,
        totals.paymentsApplied
      ),
      money("Compensaciones", (r) => r.s.offsets, totals.offsets),
      money("Reversos y ajustes", (r) => r.s.reversals, totals.reversals),
      money("Saldo actual", (r) => r.s.balance, totals.balance),
      money(
        "Deuda registrada al cierre",
        (r) => r.s.atClosure?.balanceAtClosure ?? null
      ),
      dt("Fecha de último abono", (r) => r.s.lastMovementAt),
    ],
    sessions
  )
  const debts = sessions.flatMap(({ p, s }) =>
    s.debts.map((d) => ({ p, s, d }))
  )
  type D = (typeof debts)[number]
  addTable<D>(
    wb,
    "Detalle de compras",
    [
      text("Jugador", (r) => r.p.player.name, 28),
      text("Sesión", (r) => r.s.session.folio),
      text("Mesa", (r) => r.d.table.name),
      int("Ciclo", (r) => r.d.cycleNumber),
      text("Folio de compra", (r) => r.d.purchase.folio),
      text("Tipo de compra", (r) => r.d.purchase.typeLabel),
      dt("Fecha de origen", (r) => r.d.createdAt),
      money("Crédito original", (r) => r.d.original, totals.original),
      money("Aplicaciones confirmadas", (r) => r.d.applied, totals.applied),
      money("Saldo pendiente", (r) => r.d.balance, totals.balance),
      money(
        "Saldo al cierre de su sesión",
        (r) => r.d.atClosure?.balanceAtClosure ?? null
      ),
      text("Socio autorizador", (r) => r.d.authorization.partnerName),
      text("Medio de autorización", (r) => r.d.authorization.channel),
      text("Firma", (r) => r.d.signature?.status ?? "—"),
      text("Estado", (r) => r.d.status),
    ],
    debts
  )
  const apps = payments.flatMap((p) => p.allocations.map((a) => ({ p, a })))
  type A = { p: PaymentReportRow; a: PaymentReportRow["allocations"][number] }
  const appliedTotal = apps.reduce(
    (acc, x) =>
      acc + (x.a.kind === "APPLICATION" ? 1 : -1) * Number(x.a.amount),
    0
  )
  addTable<A>(
    wb,
    "Aplicaciones de abonos",
    [
      text("Folio de abono", (r) => r.p.folio),
      dt("Fecha de pago", (r) => r.p.paidAt),
      text("Método", (r) => r.p.method),
      text("Jugador", (r) => r.p.player.name, 28),
      // Importe TOTAL del abono: se repite por fila y NO se suma.
      money("Importe total del abono (no sumar)", (r) => r.p.amount),
      text("Sesión de origen de deuda", (r) => r.a.originSession.folio),
      text(
        "Compra afectada",
        (r) =>
          `${r.a.purchase.folio} · ${purchaseTypeLabel(r.a.purchase.type, r.a.purchase.rebuyNumber)}`
      ),
      text("Tipo", (r) =>
        r.a.kind === "APPLICATION" ? "Aplicación" : "Reverso"
      ),
      money(
        "Importe aplicado",
        (r) => (r.a.kind === "APPLICATION" ? r.a.amount : `-${r.a.amount}`),
        appliedTotal.toFixed(2)
      ),
      text(
        "Referencia financiera",
        (r) => r.p.financialFolio ?? r.p.reference ?? "—"
      ),
    ],
    apps
  )
  return {
    rows: debts.length + apps.length,
    notes: [
      RULE_CREDITS,
      "«Importe total del abono» se repite en cada aplicación; el recibido real se suma una vez por abono (hoja de abonos en el reporte de abonos).",
      "«Deuda registrada al cierre» se reconstruye del libro inmutable de aplicaciones al instante del cierre; el comprobante de cierre conserva el total histórico.",
    ],
  }
}

async function paymentsWorkbook(wb: ExcelJS.Workbook, f: ReportFilters) {
  const payments = await listAllCreditPayments(f)
  type P = PaymentReportRow
  const confirmed = payments.filter((p) => p.status === "CONFIRMED")
  const received = confirmed
    .reduce((a, p) => a + Number(p.amount), 0)
    .toFixed(2)
  addTable<P>(
    wb,
    "Abonos",
    [
      text("Folio", (r) => r.folio),
      text("Jugador", (r) => r.player.name, 28),
      dt("Fecha real del pago", (r) => r.paidAt),
      text("Método", (r) => r.method),
      text("Origen", (r) => r.origin),
      text("Sesión de cobro", (r) => r.collectedInSession?.folio ?? "—"),
      money(
        "Importe confirmado",
        (r) => (r.status === "CONFIRMED" ? r.amount : "0.00"),
        received
      ),
      money("Importe aplicado neto", (r) => r.applied),
      money("Recibido sin aplicar", (r) => r.unapplied),
      text(
        "Sesiones de deuda afectadas",
        (r) => r.affectedSessions.map((s) => s.folio).join(", "),
        30
      ),
      text("Usuario", (r) => r.operator.name),
      text("Estado", (r) => r.status),
      text(
        "Referencia financiera",
        (r) => r.financialFolio ?? r.reference ?? "—"
      ),
    ],
    payments
  )
  const apps = payments.flatMap((p) => p.allocations.map((a) => ({ p, a })))
  type A = (typeof apps)[number]
  addTable<A>(
    wb,
    "Aplicaciones",
    [
      text("Folio de abono", (r) => r.p.folio),
      dt("Fecha de aplicación", (r) => r.a.appliedAt),
      text("Jugador", (r) => r.p.player.name, 28),
      text("Sesión de origen", (r) => r.a.originSession.folio),
      text("Compra afectada", (r) => r.a.purchase.folio),
      text("Mesa original", (r) => r.a.purchase.table),
      int("Orden FIFO", (r) => r.a.order),
      text("Tipo", (r) =>
        r.a.kind === "APPLICATION" ? "Aplicación" : "Reverso"
      ),
      money("Importe aplicado", (r) =>
        r.a.kind === "APPLICATION" ? r.a.amount : `-${r.a.amount}`
      ),
    ],
    apps
  )
  return {
    rows: payments.length,
    notes: [
      RULE_CREDITS,
      "Un abono puede aplicarse a varias obligaciones: el importe recibido se suma una vez por abono; las aplicaciones suman lo aplicado.",
    ],
  }
}

async function sessionsWorkbook(wb: ExcelJS.Workbook, f: ReportFilters) {
  const rows = await listAllSessionReports(f)
  type S = SessionReportRow
  addTable<S>(
    wb,
    "Sesiones",
    [
      text("Folio", (r) => r.folio),
      text("Folio anterior", (r) => r.previousFolio ?? "—"),
      text("Tipo", (r) => (r.isHistorical ? "Histórica" : "Normal")),
      day("Fecha operativa", (r) => r.operatedDay),
      dt("Apertura real", (r) => r.openedAt),
      dt("Cierre real", (r) => r.closedAt),
      text("Estado", (r) => r.status),
      int("Mesas utilizadas", (r) => r.metrics.tablesUsed),
      int("Ciclos", (r) => r.metrics.cycles),
      int("Jugadores distintos", (r) => r.metrics.players),
      int("Compras iniciales", (r) => r.metrics.initialCount),
      money("Nominal compras iniciales", (r) => r.metrics.initialNominal),
      int("Recompras", (r) => r.metrics.rebuyCount),
      money("Nominal recompras", (r) => r.metrics.rebuyNominal),
      money("Nominal entregado", (r) => r.metrics.deliveredNominal),
      money("Nominal devuelto", (r) => r.metrics.returnedNominal),
      money(
        "Diferencia nominal (entregado − devuelto)",
        (r) => r.metrics.netNotReturned
      ),
      money("Créditos originados", (r) => r.metrics.creditsOriginated),
      money(
        "Deuda de la sesión al cierre (comprobante)",
        (r) => r.closure?.creditsOutstandingAtClosure ?? null
      ),
      money(
        "Deuda actual originada en la sesión",
        (r) => r.metrics.creditsOutstandingNow
      ),
      money(
        "Cobros confirmados de compras",
        (r) => r.metrics.collections.total
      ),
      money(
        "Abonos registrados en la sesión",
        (r) => r.metrics.debtPaymentsInSession.amount
      ),
      money("Liquidaciones pagadas", (r) => r.metrics.payables.executed),
      money("Liquidaciones pendientes", (r) => r.metrics.payables.pending),
      money(
        "Arqueo final fichas: diferencia",
        (r) => r.closure?.chipCount?.difference ?? null
      ),
      money(
        "Arqueo final efectivo: contado",
        (r) => r.closure?.cashCount?.counted ?? null
      ),
      money("Efectivo retirado", (r) => r.closure?.withdrawal?.amount ?? null),
      money("Ajustes autorizados", (r) => r.closure?.adjustmentsTotal ?? null),
      text("Autorizó el cierre", (r) => r.closure?.approvedBy?.name ?? "—"),
    ],
    rows
  )
  return { rows: rows.length, notes: [RULE_NO_PROFIT, RULE_CHIPS] }
}

async function tablesWorkbook(wb: ExcelJS.Workbook, f: ReportFilters) {
  const r = await listTableCycles({ ...f, page: 1, pageSize: 5_000 })
  type T = TableCycleRow
  addTable<T>(
    wb,
    "Mesas por ciclo",
    [
      text("Mesa", (x) => x.table.name),
      text("Ciegas", (x) => x.blinds),
      text("Sesión", (x) => x.session.folio),
      int("Ciclo", (x) => x.cycleNumber),
      dt("Apertura", (x) => x.openedAt),
      dt("Cierre", (x) => x.closedAt),
      int("Participantes distintos", (x) => x.participants),
      int("Compras iniciales", (x) => x.initialCount),
      int("Recompras", (x) => x.rebuyCount),
      money("Nominal entregado", (x) => x.deliveredNominal),
      int("Liquidaciones", (x) => x.settlementsCount),
      money("Nominal devuelto (mesa final)", (x) => x.returnedNominal),
      int("Transferencias de entrada", (x) => x.transfersIn),
      int("Transferencias de salida", (x) => x.transfersOut),
      text("Estado", (x) => x.status),
    ],
    r.items
  )
  return { rows: r.items.length, notes: [r.note] }
}

async function purchasesWorkbook(wb: ExcelJS.Workbook, f: ReportFilters) {
  const [rows, t] = await Promise.all([
    listAllPurchaseReports(f),
    purchaseTotals(f),
  ])
  addKeyValues(wb, "Resumen", [
    {
      label: "Compras iniciales entregadas",
      value: t.initialCount,
      type: "int",
    },
    { label: "Nominal compras iniciales", value: t.initialNominal },
    { label: "Recompras entregadas", value: t.rebuyCount, type: "int" },
    { label: "Nominal recompras", value: t.rebuyNominal },
    { label: "Nominal entregado", value: t.deliveredNominal },
    { label: "Efectivo confirmado", value: t.cashConfirmed },
    { label: "Transferencias verificadas", value: t.transferConfirmed },
    { label: "Terminal aprobada", value: t.cardApproved },
    {
      label: "Transferencias pendientes (no cobradas)",
      value: t.transferPending,
    },
    { label: "Crédito originado (no es dinero)", value: t.creditOriginated },
  ])
  type P = PurchaseReportRow
  addTable<P>(
    wb,
    "Compras",
    [
      text("Folio", (r) => r.folio),
      text("Jugador", (r) => r.player.name, 28),
      text("Sesión", (r) => r.session.folio),
      text("Mesa", (r) => r.table.name),
      int("Ciclo", (r) => r.cycleNumber),
      text("Tipo", (r) => r.typeLabel),
      money("Valor nominal", (r) => r.nominalAmount),
      money("Efectivo confirmado", (r) => r.cashConfirmed),
      money("Transferencia verificada", (r) => r.transferConfirmed),
      money("Terminal aprobada", (r) => r.cardApproved),
      money("Transferencia pendiente", (r) => r.transferPending),
      money("Crédito originado", (r) => r.creditOriginated),
      text("Socio autorizador", (r) => r.creditPartner ?? "—"),
      text("Estado", (r) => r.status),
      text("Reverso solicitado", (r) => (r.reversalRequested ? "Sí" : "No")),
      dt("Fecha", (r) => r.at),
      text("Operador", (r) => r.operator.name),
    ],
    rows
  )
  return {
    rows: rows.length,
    notes: [
      "Solo valor nominal: no se registran denominaciones por compra.",
      "Las compras canceladas no son entregas. Las transferencias pendientes no son cobro.",
    ],
  }
}

async function settlementsWorkbook(wb: ExcelJS.Workbook, f: ReportFilters) {
  const [rows, t, offsets] = await Promise.all([
    listAllSettlementReports(f),
    settlementTotals(f),
    listSettlementOffsets(f),
  ])
  addKeyValues(wb, "Resumen", [
    { label: "Liquidaciones recibidas", value: t.count, type: "int" },
    { label: "Valor nominal devuelto", value: t.returnedNominal },
    { label: "Compensaciones aplicadas (no son dinero)", value: t.offsets },
    { label: "Pago neto comprometido", value: t.netPayout },
    { label: "Efectivo entregado", value: t.cashPaid },
    { label: "Transferencias ejecutadas", value: t.transferExecuted },
    {
      label: "Transferencias pendientes (no descuentan)",
      value: t.transferPending,
    },
    { label: "Obligación pendiente de pago", value: t.payablePending },
  ])
  type S = SettlementReportRow
  addTable<S>(
    wb,
    "Liquidaciones",
    [
      text("Folio", (r) => r.folio),
      text("Jugador", (r) => r.player.name, 28),
      text("Sesión", (r) => r.session.folio),
      text("Mesa final", (r) => r.table.name),
      money("Valor nominal devuelto", (r) => r.returnedNominal),
      text("Decisión de compensación", (r) => r.offsetDecision),
      money("Compensación aplicada", (r) => r.offsetAmount),
      money("Pago neto", (r) => r.netPayout),
      money("Efectivo entregado", (r) => r.cashPaid),
      money("Transferencias ejecutadas", (r) => r.transferExecuted),
      money("Transferencias pendientes", (r) => r.transferPending),
      money("Obligación pendiente", (r) => r.payablePending),
      text("Estado", (r) => r.status),
      dt("Fecha de liquidación", (r) => r.receivedAt ?? r.createdAt),
      dt("Último pago", (r) => r.lastPayoutAt),
    ],
    rows
  )
  type O = (typeof offsets)[number]
  addTable<O>(
    wb,
    "Compensaciones",
    [
      text("Liquidación", (r) => r.settlement?.folio ?? "—"),
      text("Jugador", (r) => r.player.name, 28),
      text("Decisión", (r) => r.settlement?.decision ?? "—"),
      text("Sesión de origen de la deuda", (r) => r.originSession.folio),
      text("Compra afectada", (r) => r.purchaseFolio),
      text("Tipo", (r) =>
        r.kind === "APPLICATION" ? "Aplicación" : "Reverso"
      ),
      money("Importe", (r) =>
        r.kind === "APPLICATION" ? r.amount : `-${r.amount}`
      ),
      money(
        "Deuda antes (liquidación)",
        (r) => r.settlement?.debtBefore ?? null
      ),
      money(
        "Deuda después (liquidación)",
        (r) => r.settlement?.debtAfter ?? null
      ),
      dt("Fecha", (r) => r.appliedAt),
    ],
    offsets
  )
  return {
    rows: rows.length + offsets.length,
    notes: [
      "Las compensaciones no son abonos de efectivo ni ingresos bancarios. Cuentas por cobrar y por pagar no se netean.",
    ],
  }
}

async function financialWorkbook(wb: ExcelJS.Workbook, f: ReportFilters) {
  const r = await getFinancialReport(f)
  const books = await sessionCashBooks({ ...f, page: 1, pageSize: 5_000 })
  addKeyValues(wb, "1 Nominal", [
    {
      label: "Fichas entregadas en el periodo (nominal)",
      value: r.nominal.delivered,
    },
    {
      label: "Fichas devueltas en el periodo (nominal)",
      value: r.nominal.returned,
    },
    {
      label: "Diferencia nominal en el periodo",
      value: r.nominal.netNotReturned,
    },
    {
      label: "Ajustes de custodia en el periodo",
      value: r.nominal.custodyAdjustments,
    },
    { label: "Bajo custodia hoy", value: r.nominal.custodyNow },
    {
      label: "En circulación hoy (pendiente de retorno)",
      value: r.nominal.circulationNow,
    },
  ])
  const flows = r.monetary.flows.accounts.flatMap((a) =>
    a.lines.map((l) => ({ a, l }))
  )
  type F = (typeof flows)[number]
  addTable<F>(
    wb,
    "2 Monetario",
    [
      text("Cuenta", (x) => x.a.label, 30),
      text("Tipo de movimiento", (x) => x.l.label, 34),
      text("Sentido", (x) =>
        x.l.direction === "DEBIT" ? "Entrada" : "Salida"
      ),
      int("Movimientos", (x) => x.l.count),
      money("Importe", (x) => x.l.amount),
    ],
    flows
  )
  type B = SessionCashBookRow
  addTable<B>(
    wb,
    "Caja por sesión",
    [
      text("Sesión", (x) => x.session.folio),
      day("Fecha operativa", (x) => x.session.operatedDay),
      text("Estado", (x) => x.session.status),
      money("Saldo inicial", (x) => x.opening),
      money("Aportaciones", (x) => x.contributions),
      money("Cobros de compras (efectivo)", (x) => x.purchaseCollections),
      money("Abonos en efectivo", (x) => x.debtPayments),
      money("Pagos de liquidaciones", (x) => x.settlementPayouts),
      money("Retiros", (x) => x.withdrawals),
      money("Retiro final de cierre", (x) => x.closingWithdrawal),
      money("Otras entradas", (x) => x.otherIn),
      money("Otras salidas", (x) => x.otherOut),
      money("Efectivo final", (x) => x.final),
    ],
    books.items
  )
  const p = r.monetary.positions
  addKeyValues(wb, "Saldos vigentes", [
    {
      label: "Banco (neto registrado; no es saldo bancario real)",
      value: p.bankKnownNet,
    },
    { label: "Efectivo en tránsito al banco", value: p.cashInTransit },
    { label: "Terminal pendiente de liquidar", value: p.cardPendingSettlement },
    { label: "Custodia administrativa", value: p.adminCustody },
    {
      label: "Transferencias de jugadores por verificar",
      value: p.pendingIncomingTransfers.amount,
    },
    {
      label: "Fondos recibidos sin aplicar (por devolver)",
      value: p.unappliedFunds,
    },
    {
      label: "Depósitos de terminal al banco en el periodo (traslado)",
      value: r.monetary.flows.highlights.cardSettledToBank,
    },
  ])
  addKeyValues(wb, "3 Por cobrar", [
    { label: "Crédito original", value: r.receivables.original },
    { label: "Abonos y pagos aplicados", value: r.receivables.paymentsApplied },
    { label: "Compensaciones", value: r.receivables.offsets },
    { label: "Reversos", value: r.receivables.reversals },
    { label: "Deuda pendiente", value: r.receivables.balance },
    {
      label: "Jugadores con saldo",
      value: r.receivables.playersWithBalance,
      type: "int",
    },
  ])
  addKeyValues(wb, "4 Por pagar", [
    { label: "Obligaciones pendientes de pago", value: r.payables.pending },
    { label: "Jugadores", value: r.payables.players, type: "int" },
    { label: "Transferencias de pago en curso", value: r.payables.inTransit },
  ])
  return {
    rows: flows.length + books.items.length,
    notes: [RULE_NO_PROFIT, r.note],
  }
}

async function chipsWorkbook(wb: ExcelJS.Workbook, f: ReportFilters) {
  const r = await getChipReport({ ...f, page: 1, pageSize: 5_000 })
  addKeyValues(wb, "Posición global", [
    { label: "Bajo custodia (nominal)", value: r.position.custody },
    { label: "Reservado (nominal)", value: r.position.reserved },
    {
      label: "En circulación (pendiente de retorno)",
      value: r.position.circulation,
    },
    {
      label: "Proyección coincide con el libro",
      value: r.position.ledgerConsistent ? "Sí" : "NO",
      type: "text",
    },
    { label: "Entregado en el periodo", value: r.flows.delivered },
    { label: "Devuelto en el periodo", value: r.flows.returned },
  ])
  if (r.lastCount) {
    type Dd = (typeof r.lastCount.details)[number]
    addTable<Dd>(
      wb,
      "Último arqueo",
      [
        text("Denominación", (d) => d.label),
        money("Valor unitario", (d) => d.unitValue),
        int("Esperado", (d) => d.expected),
        int("Contado", (d) => d.counted),
        int("Diferencia", (d) => d.difference),
      ],
      r.lastCount.details,
      {
        title: `Arqueo ${r.lastCount.type} confirmado ${r.lastCount.confirmedAt ? formatDateTime(r.lastCount.confirmedAt) : ""} (composición verificada solo en esa fecha)`,
      }
    )
  }
  type C = (typeof r.counts.items)[number]
  addTable<C>(
    wb,
    "Arqueos",
    [
      dt("Confirmado", (c) => c.confirmedAt),
      text("Tipo", (c) => c.type),
      text("Sesión", (c) => c.sessionFolio ?? "—"),
      money("Esperado", (c) => c.expected),
      money("Contado", (c) => c.counted),
      money("Diferencia física", (c) => c.difference),
      text("Conciliación", (c) => c.reconciliationStatus),
    ],
    r.counts.items
  )
  type A = (typeof r.adjustments)[number]
  addTable<A>(
    wb,
    "Ajustes",
    [
      dt("Fecha", (a) => a.at),
      text("Tipo", (a) => a.type),
      money("Importe nominal", (a) => a.amount),
      text("Motivo", (a) => a.reason ?? "—", 40),
      text("Registró", (a) => a.createdBy ?? "—"),
      text("Autorizó (cierre)", (a) => a.closureAuthorizedBy ?? "—"),
    ],
    r.adjustments
  )
  type S = (typeof r.bySession)[number]
  addTable<S>(
    wb,
    "Diferencia nominal por sesión",
    [
      text("Sesión", (s) => s.session.folio),
      day("Fecha operativa", (s) => s.session.operatedDay),
      money("Entregado", (s) => s.delivered),
      money("Devuelto", (s) => s.returned),
      money("Diferencia nominal", (s) => s.netNotReturned),
    ],
    r.bySession
  )
  return {
    rows: r.counts.items.length + r.bySession.length,
    notes: [RULE_CHIPS],
  }
}

async function playersWorkbook(wb: ExcelJS.Workbook, f: ReportFilters) {
  const r = await listPlayerStats({ ...f, page: 1, pageSize: 5_000 })
  type P = PlayerStatRow
  addTable<P>(
    wb,
    "Jugadores",
    [
      text("Jugador", (x) => x.player.name, 28),
      int("Sesiones", (x) => x.sessions),
      int("Mesas", (x) => x.tables),
      int("Compras iniciales", (x) => x.initialCount),
      int("Recompras", (x) => x.rebuyCount),
      money("Nominal comprado", (x) => x.bought),
      money("Nominal devuelto", (x) => x.returned),
      money(
        "Balance nominal observado (no es utilidad)",
        (x) => x.observedNominalBalance
      ),
      money("Créditos recibidos", (x) => x.credits),
      money("Abonos realizados", (x) => x.payments),
      money("Compensaciones", (x) => x.offsets),
      money("Deuda actual global", (x) => x.debt),
      int("Liquidaciones", (x) => x.settlements),
      money("Pagos pendientes al jugador", (x) => x.payablePending),
      dt("Última participación", (x) => x.lastParticipation),
    ],
    r.items
  )
  return { rows: r.items.length, notes: [r.note] }
}

async function comparisonsWorkbook(wb: ExcelJS.Workbook, f: ReportFilters) {
  const r = await getComparisons(f)
  const points = r.series.flatMap((s) => s.points.map((p) => ({ s, p })))
  type X = (typeof points)[number]
  addTable<X>(
    wb,
    "Series",
    [
      text("Indicador", (x) => x.s.title, 40),
      text("Unidad", (x) => x.s.unit),
      text("Periodo", (x) => x.s.period, 30),
      text("Punto", (x) => x.p.label, 26),
      { header: "Valor", type: "money", value: (x) => x.p.value },
      text("Definición", (x) => x.s.definition, 60),
    ],
    points
  )
  return { rows: points.length, notes: [r.note] }
}

async function dashboardWorkbook(wb: ExcelJS.Workbook) {
  const d = await getDashboard()
  const kpis = [...d.sessionKpis, ...d.globalKpis]
  type K = (typeof kpis)[number]
  addTable<K>(
    wb,
    "Indicadores",
    [
      text("Indicador", (k) => k.label, 40),
      text("Periodo", (k) =>
        k.period === "SESSION" ? "Sesión vigente" : "Global, a la fecha"
      ),
      text("Valor", (k) =>
        k.unit === "MXN" || k.unit === "MXN nominal" ? null : k.value
      ),
      money("Importe", (k) =>
        k.unit === "MXN" || k.unit === "MXN nominal" ? k.value : null
      ),
      text("Unidad", (k) => k.unit),
      text("Nota", (k) => k.hint ?? "", 60),
    ],
    kpis
  )
  return { rows: kpis.length, notes: [RULE_NO_PROFIT] }
}

const BUILDERS: Record<
  ReportKind,
  (
    wb: ExcelJS.Workbook,
    f: ReportFilters
  ) => Promise<{ rows: number; notes: string[] }>
> = {
  dashboard: (wb) => dashboardWorkbook(wb),
  sessions: sessionsWorkbook,
  tables: tablesWorkbook,
  purchases: purchasesWorkbook,
  financial: financialWorkbook,
  credits: creditsWorkbook,
  payments: paymentsWorkbook,
  settlements: settlementsWorkbook,
  chips: chipsWorkbook,
  players: playersWorkbook,
  comparisons: comparisonsWorkbook,
}

export function exportFileName(kind: ReportKind) {
  return `PokerManager_${EXPORT_TITLES[kind]}.xlsx`
}

/** Construye el XLSX y audita el resultado (éxito o error relevante). */
export async function buildReportXlsx(
  kind: ReportKind,
  f: ReportFilters,
  actor: { id: string; name: string },
  ctx: { requestId?: string } = {}
): Promise<{ buffer: Buffer; fileName: string; rows: number }> {
  const generatedAt = new Date()
  const auditFilters = Object.fromEntries(
    activeFilters(f).map((a) => [a.key, a.value])
  )
  try {
    const wb = new ExcelJS.Workbook()
    wb.creator = "Poker Manager"
    wb.created = generatedAt
    const result = await BUILDERS[kind](wb, f)
    addCriteria(wb, kind, f, {
      generatedAt,
      generatedBy: actor.name,
      rows: result.rows,
      notes: result.notes,
    })
    const buffer = Buffer.from(await wb.xlsx.writeBuffer())
    await recordAuditSafe({
      action: AUDIT_ACTIONS.REPORT_EXPORTED,
      entityType: "Report",
      entityId: kind,
      actorUserId: actor.id,
      requestId: ctx.requestId,
      metadata: {
        report: kind,
        format: "XLSX",
        filters: auditFilters,
        rows: result.rows,
        bytes: buffer.length,
      },
    })
    return { buffer, fileName: exportFileName(kind), rows: result.rows }
  } catch (error) {
    await recordAuditSafe({
      action: AUDIT_ACTIONS.REPORT_EXPORTED,
      entityType: "Report",
      entityId: kind,
      actorUserId: actor.id,
      requestId: ctx.requestId,
      result: "FAILURE",
      metadata: {
        report: kind,
        format: "XLSX",
        filters: auditFilters,
        error: error instanceof Error ? error.message.slice(0, 200) : "error",
      },
    })
    throw error
  }
}
