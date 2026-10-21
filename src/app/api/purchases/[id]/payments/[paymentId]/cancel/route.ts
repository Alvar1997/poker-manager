import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  cancelPaymentSchema,
  parsePaymentParams,
} from "@/modules/purchases/purchase.schemas"
import { cancelPayment } from "@/modules/purchases/purchase.service"

export const dynamic = "force-dynamic"

/** POST — retira un pago antes de entregar (efectivo devuelto o transferencia pendiente). */
export const POST = withApiHandler<{ id: string; paymentId: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.PURCHASES_CREATE, {
      requestId,
      resource: "POST /api/purchases/:id/payments/:paymentId/cancel",
    })
    const { purchaseId, paymentId } = await parsePaymentParams(params)
    const input = await parseJsonBody(req, cancelPaymentSchema)
    return ok(
      await cancelPayment(actor, purchaseId, paymentId, input, { requestId }),
      { message: "Pago retirado", requestId }
    )
  }
)
