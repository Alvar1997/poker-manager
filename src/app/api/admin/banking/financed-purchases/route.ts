import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { financedPurchaseSchema } from "@/modules/banking/banking.schemas"
import { recordFinancedPurchase } from "@/modules/banking/game.service"

export const dynamic = "force-dynamic"

/** POST — Módulo 17 (privado). Autorización en el servidor + Zod + idempotencia. */
export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.BANKING_OPERATE, {
    requestId,
    resource: "POST /api/admin/banking/financed-purchases",
  })
  const input = await parseJsonBody(req, financedPurchaseSchema)
  const r = await recordFinancedPurchase(actor, input, { requestId })
  return ok(r, {
    status: r.replayed ? 200 : 201,
    message: "Entrega registrada",
    requestId,
  })
})
