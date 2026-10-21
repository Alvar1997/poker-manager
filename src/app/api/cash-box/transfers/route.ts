import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { cashDepositSchema } from "@/modules/cash/cash.schemas"
/** POST /api/cash-box/transfers — traslado de efectivo al banco (queda en tránsito hasta verificarse). Requiere sesión ABIERTA. */
import { registerCashDeposit } from "@/modules/cash/cash.service"

export const dynamic = "force-dynamic"

export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.CASH_OPERATE, {
    requestId,
    resource: "POST /api/cash-box/transfers",
  })
  const input = await parseJsonBody(req, cashDepositSchema)
  return ok(await registerCashDeposit(actor, input, { requestId }), {
    status: 201,
    message: "Depósito registrado (pendiente de verificación)",
    requestId,
  })
})
