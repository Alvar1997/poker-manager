import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseCashIdParam } from "@/modules/cash/cash.schemas"
import { cancelCashReconciliation } from "@/modules/cash/reconciliation.service"

export const dynamic = "force-dynamic"

export const POST = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.CASH_OPERATE, {
      requestId,
      resource: "POST /api/cash-box/reconciliations/:id/cancel",
    })
    return ok(
      await cancelCashReconciliation(actor, await parseCashIdParam(params), {
        requestId,
      }),
      { message: "Arqueo cancelado", requestId }
    )
  }
)
