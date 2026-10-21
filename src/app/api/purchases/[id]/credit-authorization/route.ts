import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  creditAuthorizationSchema,
  parsePurchaseIdParam,
} from "@/modules/purchases/purchase.schemas"
import { recordCreditAuthorization } from "@/modules/purchases/purchase.service"

export const dynamic = "force-dynamic"

/**
 * POST — registra qué SOCIO autorizó el crédito (verbal o por mensaje).
 * El importe autorizado lo calcula el servidor; no se envía nada al socio.
 */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.PURCHASES_CREATE, {
      requestId,
      resource: "POST /api/purchases/:id/credit-authorization",
    })
    const id = await parsePurchaseIdParam(params)
    const input = await parseJsonBody(req, creditAuthorizationSchema)
    const result = await recordCreditAuthorization(actor, id, input, {
      requestId,
    })
    return ok(result.purchase, {
      status: result.replayed ? 200 : 201,
      message: "Autorización registrada",
      requestId,
    })
  }
)
