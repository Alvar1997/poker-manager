import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  confirmRedemptionReceipt,
  getRedemption,
} from "@/modules/special-operations/redemption.service"
import {
  confirmRedemptionReceiptSchema,
  parseIdParam,
} from "@/modules/special-operations/special.schemas"

export const dynamic = "force-dynamic"

/** POST — recepción física + firma: entrada al inventario y obligación (sin dinero). */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SPECIAL_OPS_OPERATE, {
      requestId,
      resource: "POST /api/special-operations/redemptions/:id/confirm-receipt",
    })
    const id = await parseIdParam(params)
    const input = await parseJsonBody(req, confirmRedemptionReceiptSchema)
    const r = await confirmRedemptionReceipt(actor, id, input, { requestId })
    return ok(await getRedemption(id), {
      status: r.replayed ? 200 : 201,
      message: "Fichas recibidas: la obligación queda pendiente de pago",
      requestId,
    })
  }
)
