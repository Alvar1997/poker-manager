import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  cancelSettlementSchema,
  parseSettlementIdParam,
} from "@/modules/settlements/settlement.schemas"
import { cancelSettlement } from "@/modules/settlements/settlement.service"

export const dynamic = "force-dynamic"

/** POST — cancela un borrador (sin efectos). La firma, si existía, queda CANCELLED. */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SETTLEMENTS_OPERATE, {
      requestId,
      resource: "POST /api/settlements/:id/cancel",
    })
    const id = await parseSettlementIdParam(params)
    const input = await parseJsonBody(req, cancelSettlementSchema)
    return ok(await cancelSettlement(actor, id, input, { requestId }), {
      message: "Liquidación cancelada",
      requestId,
    })
  }
)
