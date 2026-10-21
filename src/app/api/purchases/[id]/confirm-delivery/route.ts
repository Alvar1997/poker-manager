import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  confirmDeliverySchema,
  parsePurchaseIdParam,
} from "@/modules/purchases/purchase.schemas"
import { confirmDelivery } from "@/modules/purchases/purchase.service"

export const dynamic = "force-dynamic"

/**
 * POST — confirma la ENTREGA FÍSICA en una sola transacción (salida
 * nominal, asientos, deuda, numeración). Con saldo por cobrar exige socio
 * autorizador y firma auténtica (Módulo 09). Idempotente por clave.
 */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.PURCHASES_CREATE, {
      requestId,
      resource: "POST /api/purchases/:id/confirm-delivery",
    })
    const id = await parsePurchaseIdParam(params)
    const input = await parseJsonBody(req, confirmDeliverySchema)
    const result = await confirmDelivery(actor, id, input, { requestId })
    return ok(result.purchase, {
      status: 200,
      message: "Entrega confirmada",
      requestId,
    })
  }
)
