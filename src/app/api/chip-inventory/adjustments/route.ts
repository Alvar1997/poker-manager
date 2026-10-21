import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseJsonBody } from "@/lib/validation"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { adjustmentSchema } from "@/modules/inventory/inventory.schemas"
import { registerInventoryAdjustment } from "@/modules/inventory/inventory.service"

export const dynamic = "force-dynamic"

/**
 * POST /api/chip-inventory/adjustments — ajuste (faltante/sobrante/corrección) con motivo; sin aprobación adicional.
 * Idempotente por `idempotencyKey`: un reintento devuelve la operación
 * original (`replayed: true`) sin volver a mover fichas.
 */
export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.CHIPS_OPERATE, {
    requestId,
    resource: "POST /api/chip-inventory/adjustments",
  })
  const input = await parseJsonBody(req, adjustmentSchema)
  const result = await registerInventoryAdjustment(actor, input, { requestId })
  return ok(result, { status: 201, message: "Ajuste registrado", requestId })
})
