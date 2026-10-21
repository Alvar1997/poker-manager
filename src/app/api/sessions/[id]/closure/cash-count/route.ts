import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { cashCountSchema } from "@/modules/closure/closure.schemas"
import { recordClosingCashCount } from "@/modules/closure/closure.service"
import { parseSessionIdParam } from "@/modules/sessions/session.schemas"

export const dynamic = "force-dynamic"

/** POST — arqueo físico del efectivo de cierre (esperado = libro, calculado por el servidor). */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
      requestId,
      resource: "POST /api/sessions/:id/closure/cash-count",
    })
    const id = await parseSessionIdParam(params)
    const input = await parseJsonBody(req, cashCountSchema)
    const result = await recordClosingCashCount(actor, id, input, { requestId })
    return ok(result, { message: "Arqueo de efectivo registrado", requestId })
  }
)
