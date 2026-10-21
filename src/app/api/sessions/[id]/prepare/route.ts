import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseSessionIdParam } from "@/modules/sessions/session.schemas"
/** Solo el creador o SUPERADMIN. Idempotente. */
import { prepareSession } from "@/modules/sessions/session.service"

export const dynamic = "force-dynamic"

export const POST = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
      requestId,
      resource: "POST /api/sessions/:id/prepare",
    })
    const id = await parseSessionIdParam(params)
    return ok(await prepareSession(actor, id, { requestId }), {
      message: "Preparación iniciada",
      requestId,
    })
  }
)
