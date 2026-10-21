import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody, parseQueryParams } from "@/lib/validation"
import {
  paymentsQuerySchema,
  registerPaymentSchema,
} from "@/modules/credits/credit.schemas"
import {
  getPayment,
  listPayments,
  registerPayment,
} from "@/modules/credits/receivable-payment.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler(async (req, { requestId }) => {
  await requirePermission(PERMISSIONS.CREDITS_READ, {
    requestId,
    resource: "GET /api/credits/payments",
  })
  return ok(
    await listPayments(
      parseQueryParams(req.nextUrl.searchParams, paymentsQuerySchema)
    ),
    { requestId }
  )
})

/**
 * POST — registra un abono. El servidor decide la sesión (solo la OPEN),
 * el custodio, el folio y la distribución FIFO; el cliente solo envía
 * jugador, importe, método, origen y referencias. No acepta importes
 * mayores a la deuda ni crea saldos a favor.
 */
export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.CREDITS_OPERATE, {
    requestId,
    resource: "POST /api/credits/payments",
  })
  const input = await parseJsonBody(req, registerPaymentSchema)
  const result = await registerPayment(actor, input, { requestId })
  const view = await getPayment(result.paymentId)
  return ok(view, {
    status: result.replayed ? 200 : 201,
    message:
      view.status === "PENDING"
        ? "Transferencia registrada: pendiente de verificación (no reduce la deuda todavía)"
        : view.status === "REJECTED"
          ? "Cobro rechazado en la terminal: la deuda no cambia"
          : "Abono confirmado y aplicado por FIFO",
    requestId,
  })
})
