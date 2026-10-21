import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseJsonBody } from "@/lib/validation"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { initialStockSchema } from "@/modules/inventory/inventory.schemas"
import { initializeStock } from "@/modules/inventory/stock-count.service"

export const dynamic = "force-dynamic"

/**
 * POST /api/chip-inventory/initial-stock — inventario inicial de un juego (una sola vez; todas las denominaciones activas).
 * Idempotente por `idempotencyKey`: un reintento devuelve la operación
 * original (`replayed: true`) sin volver a mover fichas.
 */
export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.CHIPS_OPERATE, {
    requestId,
    resource: "POST /api/chip-inventory/initial-stock",
  })
  const input = await parseJsonBody(req, initialStockSchema)
  const result = await initializeStock(actor, input, { requestId })
  return ok(result, {
    status: 201,
    message: "Inventario inicial registrado",
    requestId,
  })
})
