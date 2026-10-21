import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { listPurchaseReports } from "@/modules/reports/purchase-report.service"
import { authorizeReport } from "@/modules/reports/report-route"

export const dynamic = "force-dynamic"

/** GET — reporte de solo lectura (Módulo 14). Filtros validados en servidor. */
export const GET = withApiHandler(async (req, { requestId }) => {
  const { filters } = await authorizeReport("purchases", req, requestId)
  return ok(await listPurchaseReports(filters), { requestId })
})
