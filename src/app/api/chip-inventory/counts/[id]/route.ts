import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseJsonBody } from "@/lib/validation"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import {
  parseInventoryIdParam,
  updateCountSchema,
} from "@/modules/inventory/inventory.schemas"
import {
  getStockCount,
  updateStockCount,
} from "@/modules/inventory/stock-count.service"

export const dynamic = "force-dynamic"

type Params = { id: string }

export const GET = withApiHandler<Params>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.CHIPS_READ, {
      requestId,
      resource: "GET /api/chip-inventory/counts/:id",
    })
    return ok(await getStockCount(await parseInventoryIdParam(params, "id")), {
      requestId,
    })
  }
)

/** PATCH — captura de cantidades / notas / actualizar esperado (solo borrador; no mueve inventario). */
export const PATCH = withApiHandler<Params>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.CHIPS_OPERATE, {
      requestId,
      resource: "PATCH /api/chip-inventory/counts/:id",
    })
    const id = await parseInventoryIdParam(params, "id")
    const input = await parseJsonBody(req, updateCountSchema)
    return ok(await updateStockCount(actor, id, input), {
      message: "Arqueo actualizado",
      requestId,
    })
  }
)
