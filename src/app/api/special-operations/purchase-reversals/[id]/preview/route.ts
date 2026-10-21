import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { previewPurchaseReversal } from "@/modules/special-operations/purchase-reversal.service"
import {
  parseIdParam,
  purchaseReversalPreviewSchema,
} from "@/modules/special-operations/special.schemas"

export const dynamic = "force-dynamic"

/** POST — vista previa con la devolución física declarada (sin escrituras). */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SPECIAL_OPS_READ, {
      requestId,
      resource:
        "POST /api/special-operations/purchase-reversals/:purchaseId/preview",
    })
    const id = await parseIdParam(params)
    void actor
    const input = await parseJsonBody(req, purchaseReversalPreviewSchema)
    return ok(await previewPurchaseReversal(id, input), { requestId })
  }
)
