import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { getClosureReport } from "@/modules/closure/closure.service"
import { parseSessionIdParam } from "@/modules/sessions/session.schemas"

export const dynamic = "force-dynamic"

/** GET — comprobante digital inmutable del cierre (snapshot + huella). */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SESSIONS_READ, {
      requestId,
      resource: "GET /api/sessions/:id/closure/report",
    })
    return ok(await getClosureReport(await parseSessionIdParam(params)), {
      requestId,
    })
  }
)
