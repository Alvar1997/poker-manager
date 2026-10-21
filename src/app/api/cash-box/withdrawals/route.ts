import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { withdrawalSchema } from "@/modules/cash/cash.schemas"
/**
 * POST /api/cash-box/withdrawals — retiro ordinario (no es gasto). Nunca
 * mayor al efectivo disponible. Requiere sesión ABIERTA. Idempotente.
 */
import { registerWithdrawal } from "@/modules/cash/cash.service"

export const dynamic = "force-dynamic"

export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.CASH_OPERATE, {
    requestId,
    resource: "POST /api/cash-box/withdrawals",
  })
  const input = await parseJsonBody(req, withdrawalSchema)
  return ok(await registerWithdrawal(actor, input, { requestId }), {
    status: 201,
    message: "Retiro registrado",
    requestId,
  })
})
