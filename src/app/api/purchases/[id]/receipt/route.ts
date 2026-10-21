import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parsePurchaseIdParam } from "@/modules/purchases/purchase.schemas"
import { getReceipt } from "@/modules/signatures/receipt.service"

export const dynamic = "force-dynamic"

/** GET — comprobante digital (snapshot inmutable de la entrega). No hay PDF. */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.PURCHASES_READ, {
      requestId,
      resource: "GET /api/purchases/:id/receipt",
    })
    return ok(await getReceipt(await parsePurchaseIdParam(params), actor), {
      requestId,
    })
  }
)
