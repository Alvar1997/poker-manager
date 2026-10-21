import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parseIdParam,
  reversePaymentSchema,
} from "@/modules/credits/credit.schemas"
import {
  getPayment,
  reversePayment,
} from "@/modules/credits/receivable-payment.service"

export const dynamic = "force-dynamic"

/** POST — reverso auditado con contraasientos (el original se conserva). */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.CREDITS_OPERATE, {
      requestId,
      resource: "POST /api/credits/payments/:id/reverse",
    })
    const id = await parseIdParam(params)
    const input = await parseJsonBody(req, reversePaymentSchema)
    await reversePayment(actor, id, input, { requestId })
    return ok(await getPayment(id), { message: "Abono revertido", requestId })
  }
)
