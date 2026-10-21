import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseCashIdParam } from "@/modules/cash/cash.schemas"
import { getCashReconciliation } from "@/modules/cash/reconciliation.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.CASH_READ, {
      requestId,
      resource: "GET /api/cash-box/reconciliations/:id",
    })
    return ok(await getCashReconciliation(await parseCashIdParam(params)), {
      requestId,
    })
  }
)
