import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { getFinancialReport } from "@/modules/reports/financial-report.service"
import { authorizeReport } from "@/modules/reports/report-route"

export const dynamic = "force-dynamic"

/** GET — reporte de solo lectura (Módulo 14). Filtros validados en servidor. */
export const GET = withApiHandler(async (req, { requestId }) => {
  const { filters } = await authorizeReport("financial", req, requestId)
  return ok(await getFinancialReport(filters), { requestId })
})
