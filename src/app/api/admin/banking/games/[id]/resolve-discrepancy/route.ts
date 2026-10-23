import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parseIdParam,
  resolveDiscrepancySchema,
} from "@/modules/banking/banking.schemas"
import { resolveDiscrepancy } from "@/modules/banking/game.service"

export const dynamic = "force-dynamic"

/** POST — Módulo 17 (privado). Autorización en el servidor + Zod + idempotencia. */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.BANKING_APPROVE, {
      requestId,
      resource: "POST /api/admin/banking/games/:id/resolve-discrepancy",
    })
    const id = await parseIdParam(params)
    const input = await parseJsonBody(req, resolveDiscrepancySchema)
    const r = await resolveDiscrepancy(actor, id, input, { requestId })
    return ok(r, {
      status: 200,
      message: "Discrepancia aclarada",
      requestId,
    })
  }
)
