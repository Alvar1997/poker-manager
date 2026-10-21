import { Card, CardContent } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { listPurchaseReports } from "@/modules/reports/purchase-report.service"
import {
  DataTable,
  ExportButton,
  Money,
  Note,
  Pagination,
  PURCHASE_STATUS_LABEL,
  REPORTS_BASE,
  ReportHeader,
  Stat,
  StatGrid,
  Td,
} from "@/modules/reports/components/report-ui"
import { ReportFiltersForm } from "@/modules/reports/components/report-filters"
import { RefreshOnFocus } from "@/modules/reports/components/refresh-on-focus"
import { getReportFilterOptions } from "@/modules/reports/report-options.service"
import { pageFilters } from "@/modules/reports/report.filters"

export const metadata = { title: "Reporte de compras — Poker Manager" }

const BASE = `${REPORTS_BASE}/compras`

export default async function PurchasesReportPage({
  searchParams,
}: PageProps<"/dashboard/reportes/compras">) {
  await requirePagePermission(PERMISSIONS.REPORTS_VIEW, BASE)
  const { filters } = pageFilters("purchases", await searchParams)
  const [r, options] = await Promise.all([
    listPurchaseReports(filters),
    getReportFilterOptions(),
  ])
  const t = r.totals
  return (
    <>
      <ReportHeader
        title="Compras y recompras"
        description="Solo valor nominal (sin denominaciones). Cada componente de un pago mixto cuenta una vez."
        actions={<ExportButton report="purchases" filters={filters} />}
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
          "partnerId",
        ]}
        statuses={Object.entries(PURCHASE_STATUS_LABEL).map(([id, label]) => ({
          id,
          label,
        }))}
        options={options}
      />
      <Card>
        <CardContent>
          <StatGrid>
            <Stat
              label={`Compras iniciales (${t.initialCount})`}
              value={t.initialNominal}
              testId="purchases-initial"
            />
            <Stat
              label={`Recompras (${t.rebuyCount})`}
              value={t.rebuyNominal}
              testId="purchases-rebuys"
            />
            <Stat label="Efectivo confirmado" value={t.cashConfirmed} />
            <Stat
              label="Transferencias verificadas"
              value={t.transferConfirmed}
            />
            <Stat label="Terminal aprobada" value={t.cardApproved} />
            <Stat
              label="Transferencias pendientes"
              value={t.transferPending}
              hint="No son cobro."
            />
            <Stat
              label="Crédito originado"
              value={t.creditOriginated}
              hint="Deuda; no es dinero."
            />
            <Stat label="Nominal entregado" value={t.deliveredNominal} />
          </StatGrid>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-3">
          <DataTable
            head={[
              "Folio",
              "Jugador",
              "Sesión · mesa · ciclo",
              "Tipo",
              "Nominal",
              "Efectivo",
              "Transferencia",
              "Terminal",
              "Crédito",
              "Estado",
              "Fecha",
              "Operador",
            ]}
            testId="purchases-report"
          >
            {r.items.map((p) => (
              <tr key={p.id}>
                <Td>{p.folio}</Td>
                <Td>{p.player.name}</Td>
                <Td>
                  {p.session.folio} · {p.table.name} · {p.cycleNumber}
                </Td>
                <Td>{p.typeLabel}</Td>
                <Td num>
                  <Money value={p.nominalAmount} />
                </Td>
                <Td num>
                  <Money value={p.cashConfirmed} />
                </Td>
                <Td num>
                  <Money value={p.transferConfirmed} />
                  {p.transferPending !== "0.00" ? (
                    <span className="text-muted-foreground block text-xs">
                      pendiente <Money value={p.transferPending} />
                    </span>
                  ) : null}
                </Td>
                <Td num>
                  <Money value={p.cardApproved} />
                </Td>
                <Td num>
                  <Money value={p.creditOriginated} />
                </Td>
                <Td>
                  {PURCHASE_STATUS_LABEL[p.status] ?? p.status}
                  {p.reversalRequested ? " · reverso solicitado" : ""}
                </Td>
                <Td>{formatDateTime(p.at)}</Td>
                <Td>{p.operator.name}</Td>
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
      <Note>
        Una compra cancelada no es una entrega. Las compras revertidas y las
        solicitudes de reverso se distinguen en el estado. El crédito es la
        deuda originada (importe − pagos confirmados al entregar).
      </Note>
    </>
  )
}
