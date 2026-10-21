import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { startClosingSchema } from "@/modules/closure/closure.schemas"
import { startClosing } from "@/modules/closure/closure.service"
import { parseSessionIdParam } from "@/modules/sessions/session.schemas"

export const dynamic = "force-dynamic"

/** POST — inicia el cierre (OPEN → CLOSING) si la prevalidación no tiene bloqueos. CASHIER, PARTNER y SUPERADMIN. */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
      requestId,
      resource: "POST /api/sessions/:id/closure/start",
    })
    const id = await parseSessionIdParam(params)
    const input = await parseJsonBody(req, startClosingSchema)
    const result = await startClosing(actor, id, input, { requestId })
    return ok(result, { message: "Sesión en cierre", requestId })
  }
)
