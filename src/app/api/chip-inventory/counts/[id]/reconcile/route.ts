import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseJsonBody } from "@/lib/validation"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import {
  parseInventoryIdParam,
  reconcileCountSchema,
} from "@/modules/inventory/inventory.schemas"
import { reconcileStockCount } from "@/modules/inventory/stock-count.service"

export const dynamic = "force-dynamic"

/** POST — concilia las diferencias con un ajuste explícito ligado al arqueo (una sola vez). */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.CHIPS_OPERATE, {
      requestId,
      resource: "POST /api/chip-inventory/counts/:id/reconcile",
    })
    const id = await parseInventoryIdParam(params, "id")
    const input = await parseJsonBody(req, reconcileCountSchema)
    return ok(await reconcileStockCount(actor, id, input, { requestId }), {
      message: "Diferencias conciliadas",
      requestId,
    })
  }
)
