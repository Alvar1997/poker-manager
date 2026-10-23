import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { parseIdParam, cancelSchema } from "@/modules/banking/banking.schemas"
import { cancelWithdrawal } from "@/modules/banking/reserve.service"

export const dynamic = "force-dynamic"

/** POST — Módulo 17 (privado). Autorización en el servidor + Zod + idempotencia. */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.BANKING_OPERATE, {
      requestId,
      resource: "POST /api/admin/banking/reserves/withdrawals/:id/cancel",
    })
    const id = await parseIdParam(params)
    const input = await parseJsonBody(req, cancelSchema)
    const r = await cancelWithdrawal(actor, id, input, { requestId })
    return ok(r, {
      status: 200,
      message: "Solicitud cancelada",
      requestId,
    })
  }
)
