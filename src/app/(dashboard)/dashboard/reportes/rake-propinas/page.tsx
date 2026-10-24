import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import {
  DataTable,
  ExportButton,
  Money,
  Note,
  REPORTS_BASE,
  ReportHeader,
  Td,
} from "@/modules/reports/components/report-ui"
import { ReportFiltersForm } from "@/modules/reports/components/report-filters"
import {
  getNominalConsolidated,
  getRakeReport,
  getTipsReport,
} from "@/modules/reports/rake-tips-report.service"
import { getReportFilterOptions } from "@/modules/reports/report-options.service"
import { pageFilters } from "@/modules/reports/report.filters"

export const metadata = { title: "Rake y propinas — Poker Manager" }

const BASE = `${REPORTS_BASE}/rake-propinas`

/**
 * Reporte del Módulo 18: rake por mesa, propinas por empleado y
 * consolidado nominal. Solo lectura; rake y propinas no se suman como una
 * misma cuenta y lo pendiente al staff no es efectivo en caja.
 */
export default async function RakeTipsReportPage({
  searchParams,
}: PageProps<"/dashboard/reportes/rake-propinas">) {
  const user = await requirePagePermission(PERMISSIONS.REPORTS_VIEW, BASE)
  const { filters } = pageFilters("rake", await searchParams)
  const financial = can(user, PERMISSIONS.REPORTS_FINANCIAL)
  const [rake, tips, nominal, options] = await Promise.all([
    getRakeReport(filters),
    financial ? getTipsReport(filters) : Promise.resolve(null),
    getNominalConsolidated(filters),
    getReportFilterOptions(),
  ])
  return (
    <>
      <ReportHeader
        title="Rake y propinas"
        description="Rake de la casa por mesa y propinas individuales del staff, con la conciliación nominal de cada sesión."
        actions={
          <div className="flex flex-wrap gap-2">
            <ExportButton report="rake" filters={filters} />
            {financial ? (
              <ExportButton report="tips" filters={filters} />
            ) : null}
            <ExportButton report="nominal" filters={filters} />
          </div>
        }
      />
      <ReportFiltersForm
        fields={["from", "to", "sessionId", "tableId"]}
        options={options}
      />
      <Note>
        Entregado = devuelto por jugadores + rake + propinas + diferencias
        autorizadas + diferencia. Cada ficha se cuenta una vez al regresar al
        inventario; los registros parciales de propinas son informativos. Una
        diferencia nominal explicada no garantiza que el arqueo físico coincida:
        revisa la diferencia física.
      </Note>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Consolidado nominal por sesión
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            head={[
              "Sesión",
              "Entregado",
              "Jugadores",
              "Rake",
              "Propinas",
              "Diferencia nominal",
              "Diferencia física",
            ]}
            testId="nominal-table"
          >
            {nominal.rows.map((n) => (
              <tr key={n.sessionFolio}>
                <Td>{n.sessionFolio}</Td>
                <Td num>
                  <Money value={n.delivered} />
                </Td>
                <Td num>
                  <Money value={n.players} />
                </Td>
                <Td num>
                  <Money value={n.rake} />
                </Td>
                <Td num>
                  <Money value={n.tips} />
                </Td>
                <Td num>
                  <Money value={n.difference} />
                </Td>
                <Td num>
                  {n.physicalDifference === null ? (
                    "—"
                  ) : (
                    <Money value={n.physicalDifference} />
                  )}
                </Td>
              </tr>
            ))}
          </DataTable>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Rake por mesa y ciclo</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            head={[
              "Sesión",
              "Mesa",
              "Ciclo",
              "Modalidad",
              "Reconocido",
              "Contado",
              "Diferencia",
              "Estado",
            ]}
            testId="rake-report-table"
          >
            {rake.cycles.map((c) => (
              <tr key={`${c.sessionFolio}-${c.table}-${c.cycle}`}>
                <Td>{c.sessionFolio}</Td>
                <Td>{c.table}</Td>
                <Td>#{c.cycle}</Td>
                <Td>{c.mode === "MANUAL" ? "Manual" : "Conteo final"}</Td>
                <Td num>
                  <Money value={c.recognized} />
                </Td>
                <Td num>
                  {c.counted === null ? "—" : <Money value={c.counted} />}
                </Td>
                <Td num>
                  {c.difference === null ? "—" : <Money value={c.difference} />}
                </Td>
                <Td>{c.status}</Td>
              </tr>
            ))}
          </DataTable>
        </CardContent>
      </Card>
      {tips ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Propinas por empleado y sesión
            </CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable
              head={["Sesión", "Empleado", "Puesto", "Estado", "Propinas"]}
              testId="tips-report-table"
            >
              {tips.rows.map((s) => (
                <tr key={`${s.sessionFolio}-${s.staff}`}>
                  <Td>{s.sessionFolio}</Td>
                  <Td>{s.staff}</Td>
                  <Td>{s.position}</Td>
                  <Td>
                    {s.state === "CONFIRMED"
                      ? "Confirmado"
                      : s.state === "DRAFT"
                        ? "Borrador"
                        : "Sin conteo"}
                  </Td>
                  <Td num>
                    <Money value={s.recognized} />
                  </Td>
                </tr>
              ))}
            </DataTable>
          </CardContent>
        </Card>
      ) : null}
    </>
  )
}
