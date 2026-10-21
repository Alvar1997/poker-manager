import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parseSessionIdParam,
  cancelSessionSchema,
} from "@/modules/sessions/session.schemas"
/** DRAFT o PREPARATION; motivo obligatorio. No borra nada. */
import { cancelSession } from "@/modules/sessions/session.service"

export const dynamic = "force-dynamic"

export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
      requestId,
      resource: "POST /api/sessions/:id/cancel",
    })
    const id = await parseSessionIdParam(params)
    const input = await parseJsonBody(req, cancelSessionSchema)
    return ok(await cancelSession(actor, id, input, { requestId }), {
      message: "Sesión cancelada",
      requestId,
    })
  }
)
