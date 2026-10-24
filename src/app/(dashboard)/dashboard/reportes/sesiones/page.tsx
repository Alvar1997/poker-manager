import Link from "next/link"

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
  SESSION_STATUS_LABEL,
  Td,
} from "@/modules/reports/components/report-ui"
import { ReportFiltersForm } from "@/modules/reports/components/report-filters"
import { RefreshOnFocus } from "@/modules/reports/components/refresh-on-focus"
import { getReportFilterOptions } from "@/modules/reports/report-options.service"
import { filtersToQuery, pageFilters } from "@/modules/reports/report.filters"
import { listSessionReports } from "@/modules/reports/session-report.service"

export const metadata = { title: "Reporte por sesiones — Poker Manager" }

const BASE = `${REPORTS_BASE}/sesiones`

export default async function SessionsReportPage({
  searchParams,
}: PageProps<"/dashboard/reportes/sesiones">) {
  await requirePagePermission(PERMISSIONS.REPORTS_VIEW, BASE)
  const { filters } = pageFilters("sessions", await searchParams)
  const [r, options] = await Promise.all([
    listSessionReports(filters),
    getReportFilterOptions(),
  ])
  return (
    <>
      <ReportHeader
        title="Sesiones"
        description="Actividad, cifras nominales, créditos, cobros, liquidaciones y cierre de cada sesión."
        actions={<ExportButton report="sessions" filters={filters} />}
      />
      <RefreshOnFocus generatedAt={new Date().toISOString()} />
      <ReportFiltersForm
        fields={["from", "to", "status", "tableId", "playerId", "operatorId"]}
        statuses={Object.entries(SESSION_STATUS_LABEL).map(([id, label]) => ({
          id,
          label,
        }))}
        options={options}
      />
      <Card>
        <CardContent className="space-y-3">
          <DataTable
            head={[
              "Sesión",
              "Fecha operativa",
              "Estado",
              "Mesas / ciclos",
              "Jugadores",
              "Compras (nominal)",
              "Recompras (nominal)",
              "Diferencia nominal",
              "Créditos originados",
              "Deuda actual",
              "Cobros confirmados",
              "Por pagar",
              "Autorizó cierre",
            ]}
            testId="sessions-report"
          >
            {r.items.map((s) => (
              <tr key={s.id} data-testid={`session-row-${s.folio}`}>
                <Td>
                  <Link
                    href={`${BASE}/${s.id}${filtersToQuery({ ...filters, page: filters.page })}`}
                    className="font-medium underline-offset-4 hover:underline"
                    data-testid="session-report-link"
                  >
                    {s.folio}
                  </Link>
                  <span className="text-muted-foreground block text-xs">
                    {s.openedAt ? formatDateTime(s.openedAt) : "Sin apertura"}
                    {s.closedAt ? ` → ${formatDateTime(s.closedAt)}` : ""}
                  </span>
                </Td>
                <Td>{s.operatedDay}</Td>
                <Td>{SESSION_STATUS_LABEL[s.status] ?? s.status}</Td>
                <Td num>
                  {s.metrics.tablesUsed} / {s.metrics.cycles}
                </Td>
                <Td num>{s.metrics.players}</Td>
                <Td num>
                  {s.metrics.initialCount} ·{" "}
                  <Money value={s.metrics.initialNominal} />
                </Td>
                <Td num>
                  {s.metrics.rebuyCount} ·{" "}
                  <Money value={s.metrics.rebuyNominal} />
                </Td>
                <Td num>
                  <Money value={s.metrics.netNotReturned} />
                </Td>
                <Td num>
                  <Money value={s.metrics.creditsOriginated} />
                </Td>
                <Td num>
                  <Money value={s.metrics.creditsOutstandingNow} />
                </Td>
                <Td num>
                  <Money value={s.metrics.collections.total} />
                </Td>
                <Td num>
                  <Money value={s.metrics.payables.pending} />
                </Td>
                <Td>{s.closure?.approvedBy?.name ?? "—"}</Td>
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
        Fecha operativa = día de apertura (America/Monterrey); una sesión puede
        cruzar la medianoche. «Diferencia nominal» = entregado − devuelto (ambas
        mesas): nadie se lleva fichas, así que con la sesión terminada debe ser
        $0; si no, se concilió o se autorizó en el cierre. No es utilidad.
        «Deuda actual» es lo que sigue pendiente HOY de los créditos nacidos en
        la sesión.
      </Note>
    </>
  )
}
