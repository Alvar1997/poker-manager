import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { confirmClosureSchema } from "@/modules/closure/closure.schemas"
import { confirmClosure } from "@/modules/closure/closure.service"
import { parseSessionIdParam } from "@/modules/sessions/session.schemas"

export const dynamic = "force-dynamic"

/** POST — cierre DEFINITIVO (CLOSING → CLOSED). Solo PARTNER o SUPERADMIN; el servidor revalida todo. */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(
      PERMISSIONS.SESSIONS_CLOSE_AUTHORIZE,
      {
        requestId,
        resource: "POST /api/sessions/:id/closure/confirm",
      }
    )
    const id = await parseSessionIdParam(params)
    const input = await parseJsonBody(req, confirmClosureSchema)
    const result = await confirmClosure(actor, id, input, { requestId })
    return ok(result, { message: "Sesión cerrada", requestId })
  }
)
