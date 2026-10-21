import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { getComparisons } from "@/modules/reports/comparative-report.service"
import { BarChart } from "@/modules/reports/components/bar-chart"
import {
  ExportButton,
  Note,
  REPORTS_BASE,
  ReportHeader,
} from "@/modules/reports/components/report-ui"
import { ReportFiltersForm } from "@/modules/reports/components/report-filters"
import { RefreshOnFocus } from "@/modules/reports/components/refresh-on-focus"
import { pageFilters } from "@/modules/reports/report.filters"

export const metadata = { title: "Comparativos históricos — Poker Manager" }

const BASE = `${REPORTS_BASE}/comparativos`

export default async function ComparisonsPage({
  searchParams,
}: PageProps<"/dashboard/reportes/comparativos">) {
  await requirePagePermission(PERMISSIONS.REPORTS_FINANCIAL, BASE)
  const { filters } = pageFilters("comparisons", await searchParams)
  const r = await getComparisons(filters)
  return (
    <>
      <ReportHeader
        title="Comparativos históricos"
        description={`${r.period}. Cada gráfica indica unidad, periodo y definición.`}
        actions={<ExportButton report="comparisons" filters={filters} />}
      />
      <RefreshOnFocus generatedAt={new Date().toISOString()} />
      <ReportFiltersForm fields={["from", "to"]} options={{}} />
      <div
        className="grid gap-3 md:grid-cols-2"
        data-testid="comparison-charts"
      >
        {r.series.map((s) => (
          <BarChart key={s.id} series={s} />
        ))}
      </div>
      <Note>{r.note}</Note>
    </>
  )
}
