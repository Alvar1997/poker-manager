import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { getFinancialReport } from "@/modules/reports/financial-report.service"
import {
  DataTable,
  ExportButton,
  Money,
  Note,
  Pagination,
  REPORTS_BASE,
  ReportHeader,
  SESSION_STATUS_LABEL,
  Stat,
  StatGrid,
  Td,
} from "@/modules/reports/components/report-ui"
import { ReportFiltersForm } from "@/modules/reports/components/report-filters"
import { RefreshOnFocus } from "@/modules/reports/components/refresh-on-focus"
import { getReportFilterOptions } from "@/modules/reports/report-options.service"
import { pageFilters } from "@/modules/reports/report.filters"

export const metadata = { title: "Caja y finanzas — Poker Manager" }

const BASE = `${REPORTS_BASE}/finanzas`

const SPECIAL_KIND_LABEL: Record<string, string> = {
  REDEMPTION: "canjes posteriores",
  PURCHASE_REFUND: "reembolsos por reverso",
  SETTLEMENT_ADJUSTMENT: "correcciones de liquidación",
  UNAPPLIED_REFUND: "devoluciones de fondos",
}

export default async function FinancialReportPage({
  searchParams,
}: PageProps<"/dashboard/reportes/finanzas">) {
  await requirePagePermission(PERMISSIONS.REPORTS_FINANCIAL, BASE)
  const { filters } = pageFilters("financial", await searchParams)
  const [r, options] = await Promise.all([
    getFinancialReport(filters),
    getReportFilterOptions(),
  ])
  const p = r.monetary.positions
  const h = r.monetary.flows.highlights
  return (
    <>
      <ReportHeader
        title="Caja y finanzas"
        description="Cuatro categorías separadas que no se suman entre sí: nominal, monetario, por cobrar y por pagar."
        actions={<ExportButton report="financial" filters={filters} />}
      />
      <RefreshOnFocus generatedAt={new Date().toISOString()} />
      <ReportFiltersForm
        fields={["from", "to", "sessionId"]}
        options={options}
      />

      <Card data-testid="fin-nominal">
        <CardHeader>
          <CardTitle className="text-base">
            1. Movimientos nominales (fichas)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <StatGrid>
            <Stat label="Entregado en el periodo" value={r.nominal.delivered} />
            <Stat label="Devuelto en el periodo" value={r.nominal.returned} />
            <Stat label="Bajo custodia hoy" value={r.nominal.custodyNow} />
            <Stat
              label="En circulación hoy"
              value={r.nominal.circulationNow}
              hint="Pendiente de retorno; no es utilidad."
            />
          </StatGrid>
        </CardContent>
      </Card>

      <Card data-testid="fin-monetary">
        <CardHeader>
          <CardTitle className="text-base">2. Movimientos monetarios</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <StatGrid>
            <Stat
              label="Efectivo de la sesión abierta"
              value={p.cashOnHand}
              hint={p.openSession ? p.openSession.folio : "Sin sesión abierta"}
            />
            <Stat
              label="Cobros bancarios confirmados"
              value={h.bankCollectionsConfirmed}
            />
            <Stat
              label="Transferencias por verificar"
              value={p.pendingIncomingTransfers.amount}
              hint="No son cobro."
            />
            <Stat label="Cobros de terminal aprobados" value={h.cardApproved} />
            <Stat
              label="Depósitos de terminal al banco"
              value={h.cardSettledToBank}
              hint="Traslado; no se suma otra vez."
            />
            <Stat
              label="Terminal pendiente de liquidar"
              value={p.cardPendingSettlement}
            />
            <Stat label="Aportaciones de capital" value={h.contributions} />
            <Stat
              label="Retiros de caja"
              value={h.withdrawals}
              hint="No son gastos."
            />
            <Stat label="Custodia administrativa" value={p.adminCustody} />
            <Stat label="Efectivo en tránsito" value={p.cashInTransit} />
            <Stat
              label="Banco (neto registrado)"
              value={p.bankKnownNet}
              hint="No es el saldo real del banco."
            />
            <Stat
              label="Fondos sin aplicar"
              value={p.unappliedFunds}
              hint="Por devolver; no es saldo a favor."
            />
            {p.specialPayables.map((sp) => (
              <Stat
                key={sp.kind}
                label={`Por pagar · ${SPECIAL_KIND_LABEL[sp.kind] ?? sp.kind}`}
                value={sp.pending}
                hint={`${sp.count} obligación(es) del Módulo 16; no es gasto.`}
              />
            ))}
          </StatGrid>
          <DataTable
            head={["Cuenta", "Tipo", "Sentido", "Movimientos", "Importe"]}
            testId="fin-flows"
          >
            {r.monetary.flows.accounts.flatMap((a) =>
              a.lines.map((l, i) => (
                <tr key={`${a.kind}-${l.type}-${l.direction}-${i}`}>
                  <Td>{a.label}</Td>
                  <Td>{l.label}</Td>
                  <Td>{l.direction === "DEBIT" ? "Entrada" : "Salida"}</Td>
                  <Td num>{l.count}</Td>
                  <Td num>
                    <Money value={l.amount} />
                  </Td>
                </tr>
              ))
            )}
          </DataTable>
        </CardContent>
      </Card>

      <Card data-testid="fin-cash-books">
        <CardHeader>
          <CardTitle className="text-base">Caja central por sesión</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <DataTable
            head={[
              "Sesión",
              "Estado",
              "Inicial",
              "Entradas",
              "Salidas",
              "Retiro final",
              "Efectivo final",
            ]}
          >
            {r.monetary.cashBooks.items.map((b) => (
              <tr key={b.session.id}>
                <Td>
                  {b.session.folio}
                  <span className="text-muted-foreground block text-xs">
                    {b.session.operatedDay}
                  </span>
                </Td>
                <Td>
                  {SESSION_STATUS_LABEL[b.session.status] ?? b.session.status}
                </Td>
                <Td num>
                  <Money value={b.opening} />
                </Td>
                <Td num>
                  <Money value={b.inflow} />
                </Td>
                <Td num>
                  <Money value={b.outflow} />
                </Td>
                <Td num>
                  <Money value={b.closingWithdrawal} />
                </Td>
                <Td num>
                  <Money value={b.final} />
                </Td>
              </tr>
            ))}
          </DataTable>
          <Pagination
            base={BASE}
            filters={filters}
            page={r.monetary.cashBooks.page}
            pageSize={r.monetary.cashBooks.pageSize}
            total={r.monetary.cashBooks.total}
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card data-testid="fin-receivables">
          <CardHeader>
            <CardTitle className="text-base">3. Cuentas por cobrar</CardTitle>
          </CardHeader>
          <CardContent>
            <StatGrid>
              <Stat
                label="Deuda pendiente"
                value={r.receivables.balance}
                strong
              />
              <Stat
                label="Jugadores con saldo"
                value={r.receivables.playersWithBalance}
                money={false}
              />
              <Stat label="Crédito original" value={r.receivables.original} />
              <Stat label="Aplicado" value={r.receivables.paymentsApplied} />
            </StatGrid>
          </CardContent>
        </Card>
        <Card data-testid="fin-payables">
          <CardHeader>
            <CardTitle className="text-base">4. Cuentas por pagar</CardTitle>
          </CardHeader>
          <CardContent>
            <StatGrid>
              <Stat
                label="Obligaciones pendientes"
                value={r.payables.pending}
                strong
              />
              <Stat
                label="Jugadores"
                value={r.payables.players}
                money={false}
              />
              <Stat
                label="Transferencias de pago en curso"
                value={r.payables.inTransit}
              />
            </StatGrid>
          </CardContent>
        </Card>
      </div>
      <Note>{r.note}</Note>
    </>
  )
}
