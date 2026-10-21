import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseQueryParams } from "@/lib/validation"
import {
  parsePurchaseIdParam,
  purchasesQuerySchema,
} from "@/modules/purchases/purchase.schemas"
import { listPurchases } from "@/modules/purchases/purchase.service"

export const dynamic = "force-dynamic"

/** GET — compras del jugador (todas las sesiones). */
export const GET = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.PURCHASES_READ, {
      requestId,
      resource: "GET /api/players/:id/purchases",
    })
    const playerId = await parsePurchaseIdParam(params)
    const query = parseQueryParams(
      req.nextUrl.searchParams,
      purchasesQuerySchema
    )
    return ok(await listPurchases({ ...query, playerId }), { requestId })
  }
)
