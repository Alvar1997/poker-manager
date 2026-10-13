import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseJsonBody } from "@/lib/validation"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { updatePaymentMethod } from "@/modules/payments/payment-method.service"
import {
  parseIdParam,
  updatePaymentMethodSchema,
} from "@/modules/settings/settings.schemas"

export const dynamic = "force-dynamic"

/** PATCH /api/payment-methods/:id — nombre, orden, activo. Solo SUPERADMIN. */
export const PATCH = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SETTINGS_MANAGE, {
      requestId,
      resource: "PATCH /api/payment-methods/:id",
    })
    const id = await parseIdParam(params)
    const input = await parseJsonBody(req, updatePaymentMethodSchema)
    return ok(await updatePaymentMethod(actor, id, input, { requestId }), {
      message: "Método de pago actualizado",
      requestId,
    })
  }
)
