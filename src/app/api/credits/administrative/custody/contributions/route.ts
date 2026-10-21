import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { custodyContributionSchema } from "@/modules/credits/credit.schemas"
import { contributeToCustody } from "@/modules/credits/custody.service"

export const dynamic = "force-dynamic"

/**
 * POST — aportación REAL de efectivo a la custodia administrativa de quien
 * la recibe (p. ej. para pagar liquidaciones pendientes tras el cierre).
 * Documentada y auditada; nunca toca cajas de sesión.
 */
export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.CASH_OPERATE, {
    requestId,
    resource: "POST /api/credits/administrative/custody/contributions",
  })
  const input = await parseJsonBody(req, custodyContributionSchema)
  const result = await contributeToCustody(actor, input, { requestId })
  return ok(result, {
    status: result.replayed ? 200 : 201,
    message: "Aportación registrada en tu custodia administrativa",
    requestId,
  })
})
