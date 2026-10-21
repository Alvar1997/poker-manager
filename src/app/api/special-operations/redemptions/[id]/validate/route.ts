import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  getRedemption,
  validateRedemptionValue,
} from "@/modules/special-operations/redemption.service"
import {
  parseIdParam,
  validateRedemptionSchema,
} from "@/modules/special-operations/special.schemas"

export const dynamic = "force-dynamic"

/** POST — el socio valida el valor aceptado (no recibe fichas ni mueve dinero). */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SPECIAL_OPS_AUTHORIZE, {
      requestId,
      resource: "POST /api/special-operations/redemptions/:id/validate",
    })
    const id = await parseIdParam(params)
    const input = await parseJsonBody(req, validateRedemptionSchema)
    const r = await validateRedemptionValue(actor, id, input, { requestId })
    return ok(await getRedemption(id), {
      message:
        r.status === "REJECTED"
          ? "Canje rechazado: no se aceptó ningún valor"
          : "Valor validado: falta la recepción física",
      requestId,
    })
  }
)
