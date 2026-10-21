import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  cancelPurchaseSchema,
  parsePurchaseIdParam,
} from "@/modules/purchases/purchase.schemas"
import { cancelPurchase } from "@/modules/purchases/purchase.service"

export const dynamic = "force-dynamic"

/** POST — cancela un borrador (libera la reserva; exige resolver cobros reales antes). */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.PURCHASES_CREATE, {
      requestId,
      resource: "POST /api/purchases/:id/cancel",
    })
    const id = await parsePurchaseIdParam(params)
    const input = await parseJsonBody(req, cancelPurchaseSchema)
    return ok(await cancelPurchase(actor, id, input, { requestId }), {
      message: "Compra cancelada",
      requestId,
    })
  }
)
