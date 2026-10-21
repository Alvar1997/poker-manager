import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { previewRedemptionValidation } from "@/modules/special-operations/redemption.service"
import {
  parseIdParam,
  previewRedemptionSchema,
} from "@/modules/special-operations/special.schemas"

export const dynamic = "force-dynamic"

/** POST — vista previa de la validación (sin escrituras). */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SPECIAL_OPS_READ, {
      requestId,
      resource: "POST /api/special-operations/redemptions/:id/preview",
    })
    const id = await parseIdParam(params)
    void actor
    const input = await parseJsonBody(req, previewRedemptionSchema)
    return ok(await previewRedemptionValidation(id, input), { requestId })
  }
)
