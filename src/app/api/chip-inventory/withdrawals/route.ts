import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseJsonBody } from "@/lib/validation"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { stockWithdrawalSchema } from "@/modules/inventory/inventory.schemas"
import { registerStockWithdrawal } from "@/modules/inventory/inventory.service"

export const dynamic = "force-dynamic"

/**
 * POST /api/chip-inventory/withdrawals — baja definitiva de fichas disponibles en el maletín (causa y motivo).
 * Idempotente por `idempotencyKey`: un reintento devuelve la operación
 * original (`replayed: true`) sin volver a mover fichas.
 */
export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.CHIPS_OPERATE, {
    requestId,
    resource: "POST /api/chip-inventory/withdrawals",
  })
  const input = await parseJsonBody(req, stockWithdrawalSchema)
  const result = await registerStockWithdrawal(actor, input, { requestId })
  return ok(result, { status: 201, message: "Baja registrada", requestId })
})
