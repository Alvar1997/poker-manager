import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseInventoryIdParam } from "@/modules/inventory/inventory.schemas"
import { cancelStockCount } from "@/modules/inventory/stock-count.service"

export const dynamic = "force-dynamic"

/** POST — cancela un arqueo en borrador (no afecta inventario). */
export const POST = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.CHIPS_OPERATE, {
      requestId,
      resource: "POST /api/chip-inventory/counts/:id/cancel",
    })
    return ok(
      await cancelStockCount(actor, await parseInventoryIdParam(params, "id"), {
        requestId,
      }),
      { message: "Arqueo cancelado", requestId }
    )
  }
)
