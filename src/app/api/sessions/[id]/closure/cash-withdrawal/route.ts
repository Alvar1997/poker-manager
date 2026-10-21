import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { cashWithdrawalSchema } from "@/modules/closure/closure.schemas"
import { registerFinalWithdrawal } from "@/modules/closure/closure.service"
import { parseSessionIdParam } from "@/modules/sessions/session.schemas"

export const dynamic = "force-dynamic"

/** POST — retiro físico final (importe exacto disponible) y receptor; el receptor no inicia sesión ni firma. */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
      requestId,
      resource: "POST /api/sessions/:id/closure/cash-withdrawal",
    })
    const id = await parseSessionIdParam(params)
    const input = await parseJsonBody(req, cashWithdrawalSchema)
    const result = await registerFinalWithdrawal(actor, id, input, {
      requestId,
    })
    return ok(result, { message: "Retiro final registrado", requestId })
  }
)
