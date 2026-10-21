import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parsePurchaseIdParam } from "@/modules/purchases/purchase.schemas"
import { getSignatureStatus } from "@/modules/signatures/signature.service"

export const dynamic = "force-dynamic"

/** GET — firma vigente e historial (incluidas las invalidadas, como evidencia). */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SIGNATURES_READ, {
      requestId,
      resource: "GET /api/purchases/:id/signatures/status",
    })
    return ok(await getSignatureStatus(await parsePurchaseIdParam(params)), {
      requestId,
    })
  }
)
