import Link from "next/link"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDate } from "@/lib/format"
import {
  getCreditSummary,
  listCreditPlayers,
  listCreditSessions,
} from "@/modules/reports/credit-report.service"
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
import { filtersToQuery, pageFilters } from "@/modules/reports/report.filters"

export const metadata = { title: "Reporte de créditos — Poker Manager" }

const BASE = `${REPORTS_BASE}/creditos`

export default async function CreditsReportPage({
  searchParams,
}: PageProps<"/dashboard/reportes/creditos">) {
  await requirePagePermission(PERMISSIONS.REPORTS_FINANCIAL, BASE)
  const { filters, issues } = pageFilters("credits", await searchParams)
  const [summary, players, sessions, options] = await Promise.all([
    getCreditSummary(filters),
    listCreditPlayers(filters),
    listCreditSessions({ ...filters, page: 1, pageSize: 100 }),
    getReportFilterOptions(),
  ])
  const keep = { ...filters, page: 1 }
  return (
    <>
      <ReportHeader
        title="Créditos y deudas"
        description="Deuda global por jugador, desglosada por sesión de origen y por compra o recompra. Deudas más antiguas primero."
        actions={<ExportButton report="credits" filters={filters} />}
      />
      <RefreshOnFocus generatedAt={new Date().toISOString()} />
      <ReportFiltersForm
        fields={[
          "playerId",
          "sessionId",
          "tableId",
          "partnerId",
          "status",
          "debtFrom",
          "debtTo",
        ]}
        statuses={[
          { id: "OPEN", label: "Pendiente" },
          { id: "PARTIALLY_PAID", label: "Pago parcial" },
          { id: "PAID", label: "Pagada" },
        ]}
        options={options}
      />
      {issues.length ? (
        <p className="text-destructive text-sm" data-testid="filter-errors">
          Filtros inválidos: {issues.map((i) => i.message).join("; ")}. Se
          muestran todos los registros.
        </p>
      ) : null}
      <Card>
        <CardContent>
          <StatGrid>
            <Stat
              label="Deuda global pendiente"
              value={summary.balance}
              strong
              testId="credits-global-balance"
            />
            <Stat
              label="Jugadores con saldo"
              value={summary.playersWithBalance}
              money={false}
              testId="credits-players-with-balance"
            />
            <Stat label="Créditos originales" value={summary.original} />
            <Stat
              label="Abonos y pagos aplicados"
              value={summary.paymentsApplied}
              testId="credits-payments-applied"
            />
            <Stat label="Compensaciones con fichas" value={summary.offsets} />
            <Stat label="Reversos" value={summary.reversals} />
            <Stat
              label="Sesiones de origen con saldo"
              value={summary.sessionsWithBalance}
              money={false}
            />
            <Stat
              label="Deuda más antigua"
              value={
                summary.oldestOpenDebtAt
                  ? formatDate(summary.oldestOpenDebtAt)
                  : "—"
              }
              money={false}
            />
          </StatGrid>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Jugadores</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <DataTable
            head={[
              "Jugador",
              "Deuda",
              "Crédito original",
              "Abonos",
              "Compensaciones",
              "Sesiones con saldo",
              "Deuda más antigua",
            ]}
            testId="credit-players"
          >
            {players.items.map((p) => (
              <tr
                key={p.player.id}
                data-testid={`credit-player-${p.player.id}`}
              >
                <Td>
                  <Link
                    href={`${BASE}/${p.player.id}${filtersToQuery(keep)}`}
                    className="font-medium underline-offset-4 hover:underline"
                    data-testid="credit-player-link"
                  >
                    {p.player.name}
                  </Link>
                </Td>
                <Td num>
                  <Money value={p.balance} />
                </Td>
                <Td num>
                  <Money value={p.original} />
                </Td>
                <Td num>
                  <Money value={p.paymentsApplied} />
                </Td>
                <Td num>
                  <Money value={p.offsets} />
                </Td>
                <Td num>{p.sessionsWithBalance}</Td>
                <Td>
                  {p.oldestOpenDebtAt ? formatDate(p.oldestOpenDebtAt) : "—"}
                </Td>
              </tr>
            ))}
          </DataTable>
          <Pagination
            base={BASE}
            filters={filters}
            page={players.page}
            pageSize={players.pageSize}
            total={players.total}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Por sesión de origen</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <DataTable
            head={[
              "Sesión",
              "Fecha operativa",
              "Estado",
              "Crédito original",
              "Abonos",
              "Compensaciones",
              "Deuda actual",
              "Deuda al cierre (comprobante)",
            ]}
            testId="credit-by-session"
          >
            {sessions.items.map((s) => (
              <tr
                key={s.session.id}
                data-testid={`credit-origin-${s.session.folio}`}
              >
                <Td>
                  <Link
                    href={`${REPORTS_BASE}/sesiones/${s.session.id}`}
                    className="underline-offset-4 hover:underline"
                  >
                    {s.session.folio}
                  </Link>
                </Td>
                <Td>{formatDate(s.session.operatedAt)}</Td>
                <Td>
                  {SESSION_STATUS_LABEL[s.session.status] ?? s.session.status}
                </Td>
                <Td num>
                  <Money value={s.original} />
                </Td>
                <Td num>
                  <Money value={s.paymentsApplied} />
                </Td>
                <Td num>
                  <Money value={s.offsets} />
                </Td>
                <Td num>
                  <span
                    data-testid={`credit-origin-${s.session.folio}-current`}
                  >
                    <Money value={s.balance} />
                  </span>
                </Td>
                <Td num>
                  <span
                    data-testid={`credit-origin-${s.session.folio}-snapshot`}
                  >
                    <Money value={s.closureSnapshotOutstanding} />
                  </span>
                </Td>
              </tr>
            ))}
          </DataTable>
          {sessions.total > sessions.items.length ? (
            <p className="text-muted-foreground text-xs">
              Se muestran {sessions.items.length} de {sessions.total} sesiones;
              la exportación XLSX incluye todas.
            </p>
          ) : null}
        </CardContent>
      </Card>
      <Note>
        Toda deuda debe poder consultarse de forma global por jugador,
        desglosada por sesión de origen y finalmente por cada compra o recompra.
        Los pagos posteriores se aplican a las obligaciones originales y no
        trasladan la deuda a la fecha o sesión del pago. «Deuda al cierre» es la
        cifra histórica del comprobante; «deuda actual» se deriva de los
        movimientos vigentes. Las transferencias pendientes no reducen la deuda.
        No hay fechas de vencimiento.
      </Note>
    </>
  )
}
