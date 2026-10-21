import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { getDashboard } from "@/modules/reports/dashboard-report.service"
import { authorizeReport } from "@/modules/reports/report-route"

export const dynamic = "force-dynamic"

/** GET — reporte de solo lectura (Módulo 14). Filtros validados en servidor. */
export const GET = withApiHandler(async (req, { requestId }) => {
  await authorizeReport("dashboard", req, requestId)
  return ok(await getDashboard(), { requestId })
})
