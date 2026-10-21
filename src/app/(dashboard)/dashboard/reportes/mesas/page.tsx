import { Card, CardContent } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import {
  DataTable,
  ExportButton,
  Money,
  Note,
  Pagination,
  REPORTS_BASE,
  ReportHeader,
  Td,
} from "@/modules/reports/components/report-ui"
import { ReportFiltersForm } from "@/modules/reports/components/report-filters"
import { RefreshOnFocus } from "@/modules/reports/components/refresh-on-focus"
import { getReportFilterOptions } from "@/modules/reports/report-options.service"
import { pageFilters } from "@/modules/reports/report.filters"
import { listTableCycles } from "@/modules/reports/session-report.service"

export const metadata = { title: "Reporte por mesas — Poker Manager" }

const BASE = `${REPORTS_BASE}/mesas`

export default async function TablesReportPage({
  searchParams,
}: PageProps<"/dashboard/reportes/mesas">) {
  await requirePagePermission(PERMISSIONS.REPORTS_VIEW, BASE)
  const { filters } = pageFilters("tables", await searchParams)
  const [r, options] = await Promise.all([
    listTableCycles(filters),
    getReportFilterOptions(),
  ])
  return (
    <>
      <ReportHeader
        title="Mesas"
        description="Un renglón por ciclo de mesa. Las compras conservan su mesa de origen y las liquidaciones la mesa final."
        actions={<ExportButton report="tables" filters={filters} />}
      />
      <RefreshOnFocus generatedAt={new Date().toISOString()} />
      <ReportFiltersForm
        fields={["from", "to", "sessionId", "tableId", "playerId", "status"]}
        statuses={[
          { id: "OPEN", label: "Abierto" },
          { id: "CLOSED", label: "Cerrado" },
        ]}
        options={options}
      />
      <Card>
        <CardContent className="space-y-3">
          <DataTable
            head={[
              "Mesa",
              "Ciegas",
              "Sesión",
              "Ciclo",
              "Apertura / cierre",
              "Participantes",
              "Compras",
              "Recompras",
              "Entregado",
              "Liquidaciones",
              "Devuelto",
              "Transf. entrada",
              "Transf. salida",
              "Estado",
            ]}
            testId="tables-report"
          >
            {r.items.map((c) => (
              <tr key={c.id}>
                <Td>{c.table.name}</Td>
                <Td>{c.blinds}</Td>
                <Td>{c.session.folio}</Td>
                <Td num>{c.cycleNumber}</Td>
                <Td>
                  {formatDateTime(c.openedAt)}
                  {c.closedAt ? ` → ${formatDateTime(c.closedAt)}` : ""}
                </Td>
                <Td num>{c.participants}</Td>
                <Td num>
                  {c.initialCount} · <Money value={c.initialNominal} />
                </Td>
                <Td num>
                  {c.rebuyCount} · <Money value={c.rebuyNominal} />
                </Td>
                <Td num>
                  <Money value={c.deliveredNominal} />
                </Td>
                <Td num>{c.settlementsCount}</Td>
                <Td num>
                  <Money value={c.returnedNominal} />
                </Td>
                <Td num>{c.transfersIn}</Td>
                <Td num>{c.transfersOut}</Td>
                <Td>{c.status === "OPEN" ? "Abierto" : "Cerrado"}</Td>
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
      <Note>{r.note}</Note>
    </>
  )
}
