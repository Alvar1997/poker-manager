import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parseCashIdParam,
  confirmReconciliationSchema,
} from "@/modules/cash/cash.schemas"
/** POST — confirma el conteo (inmutable). Una diferencia exige explicación; no ajusta el saldo. */
import { confirmCashReconciliation } from "@/modules/cash/reconciliation.service"

export const dynamic = "force-dynamic"

export const POST = withApiHandler<{ id: string }>(
  async (req, { requestId, params }) => {
    const actor = await requirePermission(PERMISSIONS.CASH_OPERATE, {
      requestId,
      resource: "POST /api/cash-box/reconciliations/:id/confirm",
    })
    const id = await parseCashIdParam(params)
    const input = await parseJsonBody(req, confirmReconciliationSchema)
    return ok(
      await confirmCashReconciliation(actor, id, input, { requestId }),
      { status: 200, message: "Arqueo de efectivo confirmado", requestId }
    )
  }
)
