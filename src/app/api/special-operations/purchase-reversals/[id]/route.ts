import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { previewPurchaseReversal } from "@/modules/special-operations/purchase-reversal.service"
import { parseIdParam } from "@/modules/special-operations/special.schemas"

export const dynamic = "force-dynamic"

/** GET — (id = compra) clasificación, bloqueos y efectos del reverso, sin escrituras. */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SPECIAL_OPS_READ, {
      requestId,
      resource: "GET /api/special-operations/purchase-reversals/:purchaseId",
    })
    return ok(await previewPurchaseReversal(await parseIdParam(params)), {
      requestId,
    })
  }
)
