import { Card, CardContent } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { listSettlementOffsets } from "@/modules/reports/credit-report.service"
import { listSettlementReports } from "@/modules/reports/purchase-report.service"
import {
  DataTable,
  ExportButton,
  Money,
  Note,
  Pagination,
  REPORTS_BASE,
  ReportHeader,
  SESSION_STATUS_LABEL,
  SETTLEMENT_STATUS_LABEL,
  Stat,
  StatGrid,
  Td,
} from "@/modules/reports/components/report-ui"
import { ReportFiltersForm } from "@/modules/reports/components/report-filters"
import { RefreshOnFocus } from "@/modules/reports/components/refresh-on-focus"
import { getReportFilterOptions } from "@/modules/reports/report-options.service"
import { pageFilters } from "@/modules/reports/report.filters"

export const metadata = { title: "Reporte de liquidaciones — Poker Manager" }

const BASE = `${REPORTS_BASE}/liquidaciones`

const DECISION: Record<string, string> = {
  NO_COMPENSATE: "Sin compensar",
  PARTIAL: "Parcial",
  MAXIMUM: "Máxima",
}

export default async function SettlementsReportPage({
  searchParams,
}: PageProps<"/dashboard/reportes/liquidaciones">) {
  await requirePagePermission(PERMISSIONS.REPORTS_FINANCIAL, BASE)
  const { filters } = pageFilters("settlements", await searchParams)
  const [r, offsets, options] = await Promise.all([
    listSettlementReports(filters),
    listSettlementOffsets(filters),
    getReportFilterOptions(),
  ])
  const t = r.totals
  return (
    <>
      <ReportHeader
        title="Liquidaciones"
        description="Devolución nominal, compensación opcional, pagos y obligaciones pendientes (aunque la sesión esté cerrada)."
        actions={<ExportButton report="settlements" filters={filters} />}
      />
      <RefreshOnFocus generatedAt={new Date().toISOString()} />
      <ReportFiltersForm
        fields={[
          "from",
          "to",
          "sessionId",
          "tableId",
          "playerId",
          "method",
          "status",
          "operatorId",
        ]}
        statuses={Object.entries(SETTLEMENT_STATUS_LABEL).map(
          ([id, label]) => ({
            id,
            label,
          })
        )}
        options={options}
      />
      <Card>
        <CardContent>
          <StatGrid>
            <Stat label="Nominal devuelto" value={t.returnedNominal} />
            <Stat
              label="Compensaciones"
              value={t.offsets}
              hint="No son dinero."
            />
            <Stat label="Efectivo entregado" value={t.cashPaid} />
            <Stat
              label="Transferencias ejecutadas"
              value={t.transferExecuted}
            />
            <Stat
              label="Transferencias pendientes"
              value={t.transferPending}
              hint="No descuentan la obligación."
            />
            <Stat
              label="Obligación pendiente de pago"
              value={t.payablePending}
              strong
              testId="settlements-pending"
            />
          </StatGrid>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-3">
          <DataTable
            head={[
              "Folio",
              "Jugador",
              "Sesión",
              "Mesa final",
              "Devuelto",
              "Compensación",
              "Pago neto",
              "Efectivo",
              "Transf. ejecutada",
              "Transf. pendiente",
              "Pendiente",
              "Estado",
              "Liquidación",
              "Último pago",
            ]}
            testId="settlements-report"
          >
            {r.items.map((s) => (
              <tr key={s.id}>
                <Td>{s.folio}</Td>
                <Td>{s.player.name}</Td>
                <Td>
                  {s.session.folio}
                  <span className="text-muted-foreground block text-xs">
                    {SESSION_STATUS_LABEL[s.session.status] ?? s.session.status}
                  </span>
                </Td>
                <Td>{s.table.name}</Td>
                <Td num>
                  <Money value={s.returnedNominal} />
                </Td>
                <Td num>
                  <Money value={s.offsetAmount} />
                  <span className="text-muted-foreground block text-xs">
                    {DECISION[s.offsetDecision] ?? s.offsetDecision}
                  </span>
                </Td>
                <Td num>
                  <Money value={s.netPayout} />
                </Td>
                <Td num>
                  <Money value={s.cashPaid} />
                </Td>
                <Td num>
                  <Money value={s.transferExecuted} />
                </Td>
                <Td num>
                  <Money value={s.transferPending} />
                </Td>
                <Td num>
                  <Money value={s.payablePending} />
                </Td>
                <Td>{SETTLEMENT_STATUS_LABEL[s.status] ?? s.status}</Td>
                <Td>{s.receivedAt ? formatDateTime(s.receivedAt) : "—"}</Td>
                <Td>{s.lastPayoutAt ? formatDateTime(s.lastPayoutAt) : "—"}</Td>
              </tr>
            ))}
          </DataTable>
          <Pagination
            base={BASE}
            filters={filters}
            page={r.page}
            pageSize={r.pageSize}
            total={r.total}
          />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-2">
          <p className="text-sm font-medium">Compensaciones de deuda</p>
          <DataTable
            head={[
              "Liquidación",
              "Jugador",
              "Decisión",
              "Sesión de origen de la deuda",
              "Compra",
              "Importe",
              "Deuda antes → después",
              "Fecha",
            ]}
            testId="settlement-offsets"
          >
            {offsets.map((o) => (
              <tr key={o.id}>
                <Td>{o.settlement?.folio ?? "—"}</Td>
                <Td>{o.player.name}</Td>
                <Td>
                  {o.settlement
                    ? (DECISION[o.settlement.decision] ?? o.settlement.decision)
                    : "—"}
                </Td>
                <Td>{o.originSession.folio}</Td>
                <Td>{o.purchaseFolio}</Td>
                <Td num>
                  {o.kind === "REVERSAL" ? "−" : ""}
                  <Money value={o.amount} />
                </Td>
                <Td num>
                  <Money value={o.settlement?.debtBefore ?? null} /> →{" "}
                  <Money value={o.settlement?.debtAfter ?? null} />
                </Td>
                <Td>{formatDateTime(o.appliedAt)}</Td>
              </tr>
            ))}
          </DataTable>
        </CardContent>
      </Card>
      <Note>
        Las compensaciones no son abonos de efectivo ni ingresos bancarios, y
        las cuentas por cobrar y por pagar nunca se netean en los reportes.
      </Note>
    </>
  )
}
