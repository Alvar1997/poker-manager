import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { withdrawalRequestSchema } from "@/modules/banking/banking.schemas"
import { requestWithdrawal } from "@/modules/banking/reserve.service"

export const dynamic = "force-dynamic"

/** POST — Módulo 17 (privado). Autorización en el servidor + Zod + idempotencia. */
export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.BANKING_OPERATE, {
    requestId,
    resource: "POST /api/admin/banking/reserves/withdrawals",
  })
  const input = await parseJsonBody(req, withdrawalRequestSchema)
  const r = await requestWithdrawal(actor, input, { requestId })
  return ok(r, {
    status: r.replayed ? 200 : 201,
    message: "Retiro solicitado: requiere aprobación digital de un socio",
    requestId,
  })
})
