import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parsePurchaseIdParam,
  prepareDeliverySchema,
} from "@/modules/purchases/purchase.schemas"
import { prepareDelivery } from "@/modules/purchases/purchase.service"

export const dynamic = "force-dynamic"

/** POST — aparta el importe en el inventario compartido (reserva nominal con vencimiento). */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.PURCHASES_CREATE, {
      requestId,
      resource: "POST /api/purchases/:id/prepare-delivery",
    })
    const id = await parsePurchaseIdParam(params)
    const input = await parseJsonBody(req, prepareDeliverySchema)
    return ok(await prepareDelivery(actor, id, input, { requestId }), {
      message: "Fichas apartadas",
      requestId,
    })
  }
)
