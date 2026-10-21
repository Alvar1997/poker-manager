import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parseSessionIdParam,
  openSessionSchema,
} from "@/modules/sessions/session.schemas"
/**
 * POST /api/sessions/:id/open — confirma la apertura. La hora la asigna el
 * servidor (no se acepta openedAt del cliente) y no exige mesas. Idempotente.
 */
import { openSession } from "@/modules/sessions/opening.service"

export const dynamic = "force-dynamic"

export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
      requestId,
      resource: "POST /api/sessions/:id/open",
    })
    const id = await parseSessionIdParam(params)
    const input = await parseJsonBody(req, openSessionSchema)
    return ok(await openSession(actor, id, input, { requestId }), {
      message: "Sesión abierta",
      requestId,
    })
  }
)
