import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parsePurchaseIdParam,
  recordPaymentSchema,
} from "@/modules/purchases/purchase.schemas"
import {
  getPurchase,
  recordPayment,
} from "@/modules/purchases/purchase.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.PURCHASES_READ, {
      requestId,
      resource: "GET /api/purchases/:id/payments",
    })
    const p = await getPurchase(await parsePurchaseIdParam(params))
    return ok({ payments: p.payments, financials: p.financials }, { requestId })
  }
)

/**
 * POST — registra un componente de pago: efectivo recibido, transferencia
 * declarada (queda PENDIENTE de verificación en caja) o resultado de la
 * terminal (débito/crédito). Nunca datos de tarjeta.
 */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.PURCHASES_CREATE, {
      requestId,
      resource: "POST /api/purchases/:id/payments",
    })
    const id = await parsePurchaseIdParam(params)
    const input = await parseJsonBody(req, recordPaymentSchema)
    const result = await recordPayment(actor, id, input, { requestId })
    return ok(result.purchase, {
      status: result.replayed ? 200 : 201,
      message: "Pago registrado",
      requestId,
    })
  }
)
