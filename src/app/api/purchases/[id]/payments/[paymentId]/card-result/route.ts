import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  cardResultSchema,
  parsePaymentParams,
} from "@/modules/purchases/purchase.schemas"
import { resolveCardPayment } from "@/modules/purchases/purchase.service"

export const dynamic = "force-dynamic"

/** POST — resultado de la terminal: aprobado (con folio y confirmación explícita), rechazado o anulado. */
export const POST = withApiHandler<{ id: string; paymentId: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.PURCHASES_CREATE, {
      requestId,
      resource: "POST /api/purchases/:id/payments/:paymentId/card-result",
    })
    const { purchaseId, paymentId } = await parsePaymentParams(params)
    const input = await parseJsonBody(req, cardResultSchema)
    return ok(
      await resolveCardPayment(actor, purchaseId, paymentId, input, {
        requestId,
      }),
      { message: "Cobro actualizado", requestId }
    )
  }
)
