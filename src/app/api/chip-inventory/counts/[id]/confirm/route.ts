import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseJsonBody } from "@/lib/validation"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import {
  confirmCountSchema,
  parseInventoryIdParam,
} from "@/modules/inventory/inventory.schemas"
import { confirmStockCount } from "@/modules/inventory/stock-count.service"

export const dynamic = "force-dynamic"

/** POST — confirma el conteo (snapshot inmutable). No ajusta inventario. 409 si el esperado es obsoleto. */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.CHIPS_OPERATE, {
      requestId,
      resource: "POST /api/chip-inventory/counts/:id/confirm",
    })
    const id = await parseInventoryIdParam(params, "id")
    const { idempotencyKey } = await parseJsonBody(req, confirmCountSchema)
    return ok(
      await confirmStockCount(actor, id, idempotencyKey, { requestId }),
      { message: "Arqueo confirmado", requestId }
    )
  }
)
