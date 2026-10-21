import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { reportShareEventSchema } from "@/modules/closure/closure.schemas"
import { recordClosureReportEvent } from "@/modules/closure/closure.service"
import { parseSessionIdParam } from "@/modules/sessions/session.schemas"

export const dynamic = "force-dynamic"

/** POST — registra que se SOLICITÓ compartir manualmente (no envía nada). */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_READ, {
      requestId,
      resource: "POST /api/sessions/:id/closure/report/share-events",
    })
    const id = await parseSessionIdParam(params)
    const { channel } = await parseJsonBody(req, reportShareEventSchema)
    await recordClosureReportEvent(
      actor,
      id,
      "SHARED",
      { channel },
      { requestId }
    )
    return ok({ recorded: true }, { requestId })
  }
)
