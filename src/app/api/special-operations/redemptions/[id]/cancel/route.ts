import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  cancelRedemption,
  getRedemption,
} from "@/modules/special-operations/redemption.service"
import {
  cancelSchema,
  parseIdParam,
} from "@/modules/special-operations/special.schemas"

export const dynamic = "force-dynamic"

/** POST — cancela un canje SIN fichas recibidas. */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SPECIAL_OPS_OPERATE, {
      requestId,
      resource: "POST /api/special-operations/redemptions/:id/cancel",
    })
    const id = await parseIdParam(params)
    const input = await parseJsonBody(req, cancelSchema)
    await cancelRedemption(actor, id, input, { requestId })
    return ok(await getRedemption(id), {
      message: "Canje cancelado",
      requestId,
    })
  }
)
