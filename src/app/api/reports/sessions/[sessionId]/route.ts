import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { assertId, authorizeReport } from "@/modules/reports/report-route"
import { getSessionReport } from "@/modules/reports/session-report.service"

export const dynamic = "force-dynamic"

/** GET — detalle de sesión: vista histórica del cierre y vista actual, separadas. */
export const GET = withApiHandler<{ sessionId: string }>(
  async (req, { params, requestId }) => {
    await authorizeReport("sessions", req, requestId)
    const { sessionId } = await params
    return ok(await getSessionReport(assertId(sessionId, "Sesión")), {
      requestId,
    })
  }
)
