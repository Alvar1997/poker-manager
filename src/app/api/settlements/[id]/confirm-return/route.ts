import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  confirmReturnSchema,
  parseSettlementIdParam,
} from "@/modules/settlements/settlement.schemas"
import { confirmReturn } from "@/modules/settlements/settlement.service"

export const dynamic = "force-dynamic"

/**
 * POST — el cajero confirma la RECEPCIÓN física de las fichas (después de
 * la firma). En una transacción: entrada nominal única, compensación FIFO
 * decidida, cuenta por pagar, pago inmediato opcional, participación y
 * comprobante. Idempotente.
 */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SETTLEMENTS_OPERATE, {
      requestId,
      resource: "POST /api/settlements/:id/confirm-return",
    })
    const id = await parseSettlementIdParam(params)
    const input = await parseJsonBody(req, confirmReturnSchema)
    const result = await confirmReturn(actor, id, input, { requestId })
    return ok(result.settlement, {
      status: result.replayed ? 200 : 201,
      message:
        result.settlement.status === "COMPLETED"
          ? "Recepción confirmada. Liquidación pagada por completo."
          : "Recepción confirmada. Queda pago pendiente al jugador.",
      requestId,
    })
  }
)
