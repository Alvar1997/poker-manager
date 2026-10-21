import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseJsonBody } from "@/lib/validation"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { stockEntrySchema } from "@/modules/inventory/inventory.schemas"
import { registerStockEntry } from "@/modules/inventory/inventory.service"

export const dynamic = "force-dynamic"

/**
 * POST /api/chip-inventory/entries — entrada de fichas (una o varias denominaciones, con motivo).
 * Idempotente por `idempotencyKey`: un reintento devuelve la operación
 * original (`replayed: true`) sin volver a mover fichas.
 */
export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.CHIPS_OPERATE, {
    requestId,
    resource: "POST /api/chip-inventory/entries",
  })
  const input = await parseJsonBody(req, stockEntrySchema)
  const result = await registerStockEntry(actor, input, { requestId })
  return ok(result, { status: 201, message: "Entrada registrada", requestId })
})
