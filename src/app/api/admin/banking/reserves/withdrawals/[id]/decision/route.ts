import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parseIdParam,
  withdrawalDecisionSchema,
} from "@/modules/banking/banking.schemas"
import { decideWithdrawal } from "@/modules/banking/reserve.service"

export const dynamic = "force-dynamic"

/** POST — Módulo 17 (privado). Autorización en el servidor + Zod + idempotencia. */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.BANKING_APPROVE, {
      requestId,
      resource: "POST /api/admin/banking/reserves/withdrawals/:id/decision",
    })
    const id = await parseIdParam(params)
    const input = await parseJsonBody(req, withdrawalDecisionSchema)
    const r = await decideWithdrawal(actor, id, input, { requestId })
    return ok(r, {
      status: 200,
      message: "Decisión registrada",
      requestId,
    })
  }
)
