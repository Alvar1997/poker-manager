import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parseIdParam,
  registerUnappliedRefundSchema,
} from "@/modules/special-operations/special.schemas"
import {
  getUnappliedFunds,
  registerUnappliedRefund,
} from "@/modules/special-operations/unapplied-funds.service"

export const dynamic = "force-dynamic"

/** POST — registra la obligación de devolución (corrección aprobada); no paga. */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SPECIAL_OPS_OPERATE, {
      requestId,
      resource: "POST /api/special-operations/unapplied-funds/:id/refunds",
    })
    const id = await parseIdParam(params)
    const input = await parseJsonBody(req, registerUnappliedRefundSchema)
    const r = await registerUnappliedRefund(actor, id, input, { requestId })
    return ok(await getUnappliedFunds(id), {
      status: r.replayed ? 200 : 201,
      message:
        "Devolución registrada: se paga con pagos reales (efectivo o transferencia)",
      requestId,
    })
  }
)
