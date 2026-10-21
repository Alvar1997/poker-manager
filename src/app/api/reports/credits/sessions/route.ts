import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { listCreditSessions } from "@/modules/reports/credit-report.service"
import { authorizeReport } from "@/modules/reports/report-route"

export const dynamic = "force-dynamic"

/** GET — reporte de solo lectura (Módulo 14). Filtros validados en servidor. */
export const GET = withApiHandler(async (req, { requestId }) => {
  const { filters } = await authorizeReport("credits", req, requestId)
  return ok(await listCreditSessions(filters), { requestId })
})
