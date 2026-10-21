import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parsePurchaseIdParam } from "@/modules/purchases/purchase.schemas"
import { getPurchaseHistory } from "@/modules/purchases/purchase.service"

export const dynamic = "force-dynamic"

/** GET — historial inmutable de estados y eventos auditados de la compra. */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.PURCHASES_READ, {
      requestId,
      resource: "GET /api/purchases/:id/history",
    })
    return ok(await getPurchaseHistory(await parsePurchaseIdParam(params)), {
      requestId,
    })
  }
)
