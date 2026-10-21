import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { contributionSchema } from "@/modules/cash/cash.schemas"
/**
 * POST /api/cash-box/contributions — aportación REAL de efectivo a una sesión
 * ABIERTA. Sin sesión abierta responde 422 (Módulo 06). Idempotente.
 */
import { registerContribution } from "@/modules/cash/cash.service"

export const dynamic = "force-dynamic"

export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.CASH_OPERATE, {
    requestId,
    resource: "POST /api/cash-box/contributions",
  })
  const input = await parseJsonBody(req, contributionSchema)
  return ok(await registerContribution(actor, input, { requestId }), {
    status: 201,
    message: "Aportación registrada",
    requestId,
  })
})
