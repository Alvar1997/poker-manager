import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parseCashIdParam,
  adjustReconciliationSchema,
} from "@/modules/cash/cash.schemas"
/** POST — ajuste explícito y único de la diferencia (CONTROL/CLOSING; nunca en apertura). */
import { adjustCashReconciliation } from "@/modules/cash/reconciliation.service"

export const dynamic = "force-dynamic"

export const POST = withApiHandler<{ id: string }>(
  async (req, { requestId, params }) => {
    const actor = await requirePermission(PERMISSIONS.CASH_OPERATE, {
      requestId,
      resource: "POST /api/cash-box/reconciliations/:id/adjust",
    })
    const id = await parseCashIdParam(params)
    const input = await parseJsonBody(req, adjustReconciliationSchema)
    return ok(await adjustCashReconciliation(actor, id, input, { requestId }), {
      status: 200,
      message: "Diferencia ajustada",
      requestId,
    })
  }
)
