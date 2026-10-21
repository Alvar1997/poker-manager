import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  executePurchaseReversal,
  getPurchaseReversal,
} from "@/modules/special-operations/purchase-reversal.service"
import {
  executePurchaseReversalSchema,
  parseIdParam,
} from "@/modules/special-operations/special.schemas"

export const dynamic = "force-dynamic"

/** POST — ejecuta el reverso APROBADO (exige devolución física completa). */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SPECIAL_OPS_OPERATE, {
      requestId,
      resource:
        "POST /api/special-operations/purchase-reversals/:purchaseId/execute",
    })
    const id = await parseIdParam(params)
    const input = await parseJsonBody(req, executePurchaseReversalSchema)
    const r = await executePurchaseReversal(actor, id, input, { requestId })
    return ok(await getPurchaseReversal(r.reversalId), {
      status: r.replayed ? 200 : 201,
      message:
        "Reverso ejecutado: fichas recibidas; el reembolso se paga aparte",
      requestId,
    })
  }
)
