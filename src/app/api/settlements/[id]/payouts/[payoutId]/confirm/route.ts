import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { ValidationError } from "@/lib/errors"
import { parseJsonBody } from "@/lib/validation"
import {
  idSchema,
  parseSettlementIdParam,
  resolvePayoutSchema,
} from "@/modules/settlements/settlement.schemas"
import { resolvePayout } from "@/modules/settlements/settlement-payout.service"
import { getSettlement } from "@/modules/settlements/settlement.service"

export const dynamic = "force-dynamic"

/**
 * POST — resuelve una transferencia saliente en trámite tras verificarla
 * MANUALMENTE en el banco: EXECUTED (cuenta como pagada; banco −), FAILED o
 * CANCELLED (libera la reserva). Permiso financiero de caja.
 */
export const POST = withApiHandler<{ id: string; payoutId: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.CASH_OPERATE, {
      requestId,
      resource: "POST /api/settlements/:id/payouts/:payoutId/confirm",
    })
    const { id, payoutId } = await params
    const settlementId = await parseSettlementIdParam(Promise.resolve({ id }))
    if (!idSchema.safeParse(payoutId).success)
      throw new ValidationError("Identificador inválido")
    const input = await parseJsonBody(req, resolvePayoutSchema)
    await resolvePayout(actor, settlementId, payoutId, input, { requestId })
    return ok(await getSettlement(settlementId), {
      message:
        input.outcome === "EXECUTED"
          ? "Transferencia ejecutada y registrada"
          : "Transferencia marcada como no realizada: el importe sigue pendiente",
      requestId,
    })
  }
)
