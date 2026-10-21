import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  listCardSettlements,
  registerCardSettlement,
} from "@/modules/cash/card-settlement.service"
import { cardSettlementSchema } from "@/modules/cash/cash.schemas"

export const dynamic = "force-dynamic"

export const GET = withApiHandler(async (_req, { requestId }) => {
  await requirePermission(PERMISSIONS.CASH_READ, {
    requestId,
    resource: "GET /api/cash-box/card-settlements",
  })
  return ok(await listCardSettlements(), { requestId })
})

/**
 * POST — registra el depósito de la terminal que liquida cobros aprobados:
 * banco + / por liquidar −. No reconoce la venta otra vez; cada cobro se
 * liquida una sola vez. Una diferencia (comisión) queda por conciliar.
 */
export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.CASH_OPERATE, {
    requestId,
    resource: "POST /api/cash-box/card-settlements",
  })
  const input = await parseJsonBody(req, cardSettlementSchema)
  const result = await registerCardSettlement(actor, input, { requestId })
  return ok(result, {
    status: result.replayed ? 200 : 201,
    message: "Depósito de terminal registrado",
    requestId,
  })
})
