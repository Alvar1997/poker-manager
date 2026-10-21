import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { returnToOpenSchema } from "@/modules/closure/closure.schemas"
import { returnToOpen } from "@/modules/closure/closure.service"
import { parseSessionIdParam } from "@/modules/sessions/session.schemas"

export const dynamic = "force-dynamic"

/** POST — regreso auditado CLOSING → OPEN con motivo (operaciones reales olvidadas). Nunca desde CLOSED. */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
      requestId,
      resource: "POST /api/sessions/:id/closure/return-to-open",
    })
    const id = await parseSessionIdParam(params)
    const input = await parseJsonBody(req, returnToOpenSchema)
    const result = await returnToOpen(actor, id, input, { requestId })
    return ok(result, { message: "Sesión regresada a Abierta", requestId })
  }
)
