import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parsePurchaseIdParam,
  reversalRequestSchema,
} from "@/modules/purchases/purchase.schemas"
import { requestReversal } from "@/modules/purchases/purchase.service"

export const dynamic = "force-dynamic"

/** POST — solicitud justificada de reverso (no mueve fichas ni dinero; ejecución en Módulos 10/11). */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.PURCHASES_CREATE, {
      requestId,
      resource: "POST /api/purchases/:id/reversal-request",
    })
    const id = await parsePurchaseIdParam(params)
    const input = await parseJsonBody(req, reversalRequestSchema)
    const result = await requestReversal(actor, id, input, { requestId })
    return ok(result.purchase, {
      status: result.replayed ? 200 : 201,
      message: "Solicitud de reverso registrada",
      requestId,
    })
  }
)
