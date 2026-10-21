import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parseSettlementIdParam,
  reverseSettlementSchema,
} from "@/modules/settlements/settlement.schemas"
import { reverseSettlement } from "@/modules/settlements/settlement.service"

export const dynamic = "force-dynamic"

/**
 * POST — reverso auditado de una recepción confirmada SIN pagos reales
 * (contraasientos; nada se borra). Con pagos ejecutados o en trámite se
 * rechaza: requiere resolución administrativa documentada.
 */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SETTLEMENTS_OPERATE, {
      requestId,
      resource: "POST /api/settlements/:id/reverse",
    })
    const id = await parseSettlementIdParam(params)
    const input = await parseJsonBody(req, reverseSettlementSchema)
    const result = await reverseSettlement(actor, id, input, { requestId })
    return ok(result.settlement, {
      message: "Liquidación revertida con contraasientos",
      requestId,
    })
  }
)
