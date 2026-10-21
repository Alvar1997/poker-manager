import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseQueryParams } from "@/lib/validation"
import { parseTableParams } from "@/modules/session-tables/session-table.schemas"
import { purchasesQuerySchema } from "@/modules/purchases/purchase.schemas"
import { listPurchases } from "@/modules/purchases/purchase.service"

export const dynamic = "force-dynamic"

/** GET — compras registradas en esa mesa (conservan su mesa aunque el jugador se cambie). */
export const GET = withApiHandler<{ id: string; tableId: string }>(
  async (req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.PURCHASES_READ, {
      requestId,
      resource: "GET /api/sessions/:id/tables/:tableId/purchases",
    })
    const { sessionId, tableId } = await parseTableParams(params)
    const query = parseQueryParams(
      req.nextUrl.searchParams,
      purchasesQuerySchema
    )
    return ok(await listPurchases({ ...query, sessionId, tableId }), {
      requestId,
    })
  }
)
