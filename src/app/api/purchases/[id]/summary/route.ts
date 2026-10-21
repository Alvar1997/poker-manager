import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parsePurchaseIdParam } from "@/modules/purchases/purchase.schemas"
import { getPurchaseSummary } from "@/modules/purchases/purchase.service"

export const dynamic = "force-dynamic"

/** GET — resumen firmable (versión + huella) y saldo por cobrar derivado. */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.PURCHASES_READ, {
      requestId,
      resource: "GET /api/purchases/:id/summary",
    })
    return ok(await getPurchaseSummary(await parsePurchaseIdParam(params)), {
      requestId,
    })
  }
)
