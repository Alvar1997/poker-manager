import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parseIdParam,
  resolvePayoutSchema,
} from "@/modules/banking/banking.schemas"
import { resolveBankingPayout } from "@/modules/banking/payout.service"

export const dynamic = "force-dynamic"

/** POST — Módulo 17 (privado). Autorización en el servidor + Zod + idempotencia. */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.BANKING_OPERATE, {
      requestId,
      resource: "POST /api/admin/banking/payouts/:id/resolve",
    })
    const id = await parseIdParam(params)
    const input = await parseJsonBody(req, resolvePayoutSchema)
    const r = await resolveBankingPayout(actor, id, input, { requestId })
    return ok(r, {
      status: 200,
      message: "Transferencia resuelta",
      requestId,
    })
  }
)
