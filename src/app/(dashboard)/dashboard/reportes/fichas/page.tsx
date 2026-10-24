import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { getChipReport } from "@/modules/reports/chip-report.service"
import {
  DataTable,
  ExportButton,
  Money,
  Note,
  Pagination,
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

export const metadata = { title: "Inventario y circulación — Poker Manager" }

const BASE = `${REPORTS_BASE}/fichas`

export default async function ChipsReportPage({
  searchParams,
}: PageProps<"/dashboard/reportes/fichas">) {
  await requirePagePermission(PERMISSIONS.REPORTS_VIEW, BASE)
  const { filters } = pageFilters("chips", await searchParams)
  const [r, options] = await Promise.all([
    getChipReport(filters),
    getReportFilterOptions(),
  ])
  return (
    <>
      <ReportHeader
        title="Inventario y fichas en circulación"
        description="Diferencia física de arqueo, diferencia nominal de la sesión, resultados individuales y utilidad son conceptos distintos. Nadie se lleva fichas: los resultados individuales se compensan entre jugadores."
        actions={<ExportButton report="chips" filters={filters} />}
      />
      <RefreshOnFocus generatedAt={new Date().toISOString()} />
      <ReportFiltersForm
        fields={["from", "to", "sessionId"]}
        options={options}
      />
      <Card>
        <CardContent>
          <StatGrid>
            <Stat
              label="Bajo custodia (nominal)"
              value={r.position.custody}
              testId="chips-custody"
            />
            <Stat label="Reservado" value={r.position.reserved} />
            <Stat
              label="En circulación (global)"
              value={r.position.circulation}
              hint="Pendiente de retorno. No es faltante ni utilidad."
              testId="chips-circulation"
            />
            <Stat
              label="Libro consistente"
              value={r.position.ledgerConsistent ? "Sí" : "NO"}
              money={false}
            />
            <Stat label="Entregado en el periodo" value={r.flows.delivered} />
            <Stat label="Devuelto en el periodo" value={r.flows.returned} />
            <Stat
              label="Diferencia nominal (periodo)"
              value={r.flows.netNotReturned}
            />
            <Stat
              label="Ajustes de custodia"
              value={r.flows.custodyAdjustments}
            />
          </StatGrid>
        </CardContent>
      </Card>
      <Card data-testid="chips-last-count">
        <CardHeader>
          <CardTitle className="text-base">Último arqueo confirmado</CardTitle>
          {r.lastCount ? (
            <p className="text-muted-foreground text-xs">
              {r.lastCount.type} ·{" "}
              {r.lastCount.confirmedAt
                ? formatDateTime(r.lastCount.confirmedAt)
                : ""}{" "}
              · esperado <Money value={r.lastCount.expected} /> · contado{" "}
              <Money value={r.lastCount.counted} /> · diferencia física{" "}
              <Money value={r.lastCount.difference} />. La composición por
              denominación solo está verificada en esa fecha.
            </p>
          ) : null}
        </CardHeader>
        <CardContent>
          {r.lastCount ? (
            <DataTable
              head={[
                "Denominación",
                "Valor",
                "Esperado",
                "Contado",
                "Diferencia",
              ]}
            >
              {r.lastCount.details.map((d) => (
                <tr key={d.label + d.unitValue}>
                  <Td>{d.label}</Td>
                  <Td num>
                    <Money value={d.unitValue} />
                  </Td>
                  <Td num>{d.expected}</Td>
                  <Td num>{d.counted ?? "—"}</Td>
                  <Td num>{d.difference ?? "—"}</Td>
                </tr>
              ))}
            </DataTable>
          ) : (
            <p className="text-muted-foreground text-sm">
              Sin arqueos confirmados.
            </p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Arqueos y diferencias</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <DataTable
            head={[
              "Confirmado",
              "Tipo",
              "Sesión",
              "Esperado",
              "Contado",
              "Diferencia física",
              "Conciliación",
            ]}
            testId="chips-counts"
          >
            {r.counts.items.map((c) => (
              <tr key={c.id}>
                <Td>{c.confirmedAt ? formatDateTime(c.confirmedAt) : "—"}</Td>
                <Td>{c.type}</Td>
                <Td>{c.sessionFolio ?? "—"}</Td>
                <Td num>
                  <Money value={c.expected} />
                </Td>
                <Td num>
                  <Money value={c.counted} />
                </Td>
                <Td num>
                  <Money value={c.difference} />
                </Td>
                <Td>{c.reconciliationStatus}</Td>
              </tr>
            ))}
          </DataTable>
          <Pagination
            base={BASE}
            filters={filters}
            page={r.counts.page}
            pageSize={r.counts.pageSize}
            total={r.counts.total}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ajustes</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            head={[
              "Fecha",
              "Tipo",
              "Importe nominal",
              "Motivo",
              "Registró",
              "Autorizó (cierre)",
            ]}
          >
            {r.adjustments.map((a) => (
              <tr key={a.id}>
                <Td>{formatDateTime(a.at)}</Td>
                <Td>{a.type}</Td>
                <Td num>
                  <Money value={a.amount} />
                </Td>
                <Td>{a.reason ?? "—"}</Td>
                <Td>{a.createdBy ?? "—"}</Td>
                <Td>{a.closureAuthorizedBy ?? "—"}</Td>
              </tr>
            ))}
          </DataTable>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Diferencia nominal por sesión
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            head={[
              "Sesión",
              "Fecha operativa",
              "Entregado",
              "Devuelto",
              "Diferencia nominal",
            ]}
            testId="chips-by-session"
          >
            {r.bySession.map((s) => (
              <tr key={s.session.id}>
                <Td>{s.session.folio}</Td>
                <Td>{s.session.operatedDay}</Td>
                <Td num>
                  <Money value={s.delivered} />
                </Td>
                <Td num>
                  <Money value={s.returned} />
                </Td>
                <Td num>
                  <Money value={s.netNotReturned} />
                </Td>
              </tr>
            ))}
          </DataTable>
        </CardContent>
      </Card>
      <Note>
        {r.note} No se afirma quién conserva físicamente las fichas. El canje
        posterior se registra en Operaciones especiales (Módulo 16) y solo paga
        lo recibido físicamente y validado.
      </Note>
    </>
  )
}
