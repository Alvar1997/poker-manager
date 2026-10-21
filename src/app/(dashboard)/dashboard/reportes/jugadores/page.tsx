import Link from "next/link"

import { Card, CardContent } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { listPlayerStats } from "@/modules/reports/player-report.service"
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

export const metadata = { title: "Estadísticas de jugadores — Poker Manager" }

const BASE = `${REPORTS_BASE}/jugadores`

export default async function PlayersReportPage({
  searchParams,
}: PageProps<"/dashboard/reportes/jugadores">) {
  await requirePagePermission(PERMISSIONS.REPORTS_VIEW, BASE)
  const { filters } = pageFilters("players", await searchParams)
  const [r, options] = await Promise.all([
    listPlayerStats(filters),
    getReportFilterOptions(),
  ])
  return (
    <>
      <ReportHeader
        title="Jugadores"
        description="Asistencia, compras, devoluciones, créditos, abonos y pendientes por jugador."
        actions={<ExportButton report="players" filters={filters} />}
      />
      <RefreshOnFocus generatedAt={new Date().toISOString()} />
      <ReportFiltersForm fields={["playerId", "sessionId"]} options={options} />
      <Card>
        <CardContent className="space-y-3">
          <DataTable
            head={[
              "Jugador",
              "Sesiones",
              "Mesas",
              "Compras / recompras",
              "Comprado",
              "Devuelto",
              "Balance nominal observado",
              "Créditos",
              "Abonos",
              "Compensaciones",
              "Deuda actual",
              "Por pagarle",
              "Última participación",
            ]}
            testId="players-report"
          >
            {r.items.map((p) => (
              <tr key={p.player.id}>
                <Td>
                  <Link
                    href={`${REPORTS_BASE}/creditos/${p.player.id}`}
                    className="underline-offset-4 hover:underline"
                  >
                    {p.player.name}
                  </Link>
                </Td>
                <Td num>{p.sessions}</Td>
                <Td num>{p.tables}</Td>
                <Td num>
                  {p.initialCount} / {p.rebuyCount}
                </Td>
                <Td num>
                  <Money value={p.bought} />
                </Td>
                <Td num>
                  <Money value={p.returned} />
                </Td>
                <Td num>
                  <Money value={p.observedNominalBalance} />
                </Td>
                <Td num>
                  <Money value={p.credits} />
                </Td>
                <Td num>
                  <Money value={p.payments} />
                </Td>
                <Td num>
                  <Money value={p.offsets} />
                </Td>
                <Td num>
                  <Money value={p.debt} />
                </Td>
                <Td num>
                  <Money value={p.payablePending} />
                </Td>
                <Td>
                  {p.lastParticipation
                    ? formatDateTime(p.lastParticipation)
                    : "—"}
                </Td>
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
        {r.note} El desglose de la deuda por sesión de origen está en el estado
        de cuenta de cada jugador.
      </Note>
    </>
  )
}
