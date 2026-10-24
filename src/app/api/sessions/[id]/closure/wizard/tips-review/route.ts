import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseSessionIdParam } from "@/modules/sessions/session.schemas"
import { reviewSessionTips } from "@/modules/staff-tips/tips.service"

export const dynamic = "force-dynamic"

/** POST — confirma que el conteo del staff está completo (también con $0). */
export const POST = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.TIPS_OPERATE, {
      requestId,
      resource: "POST /api/sessions/:id/closure/wizard/tips-review",
    })
    const id = await parseSessionIdParam(params)
    const r = await reviewSessionTips(actor, id, { requestId })
    return ok(r, { message: "Conteo del staff confirmado", requestId })
  }
)
