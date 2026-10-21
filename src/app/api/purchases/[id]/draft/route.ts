import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parsePurchaseIdParam,
  updateDraftSchema,
} from "@/modules/purchases/purchase.schemas"
import { updateDraft } from "@/modules/purchases/purchase.service"

export const dynamic = "force-dynamic"

/** PATCH — cambia importe o notas de un borrador (con la versión que se revisó). */
export const PATCH = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.PURCHASES_CREATE, {
      requestId,
      resource: "PATCH /api/purchases/:id/draft",
    })
    const id = await parsePurchaseIdParam(params)
    const input = await parseJsonBody(req, updateDraftSchema)
    return ok(await updateDraft(actor, id, input, { requestId }), {
      message: "Compra actualizada",
      requestId,
    })
  }
)
