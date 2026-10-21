import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { custodyDepositSchema } from "@/modules/credits/credit.schemas"
import { depositCustody } from "@/modules/credits/custody.service"

export const dynamic = "force-dynamic"

/**
 * POST — depósito verificado del efectivo administrativo en custodia:
 * custodia − / banco +. No es un abono nuevo ni un ingreso adicional.
 */
export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.CASH_OPERATE, {
    requestId,
    resource: "POST /api/credits/administrative/custody/deposit",
  })
  const input = await parseJsonBody(req, custodyDepositSchema)
  const result = await depositCustody(actor, input, { requestId })
  return ok(result, {
    status: result.replayed ? 200 : 201,
    message: "Depósito registrado",
    requestId,
  })
})
