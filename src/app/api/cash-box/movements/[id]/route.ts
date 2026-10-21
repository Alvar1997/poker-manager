import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseCashIdParam } from "@/modules/cash/cash.schemas"
import { getMovement } from "@/modules/cash/cash.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler<{ id: string }>(
  async (_req, { requestId, params }) => {
    await requirePermission(PERMISSIONS.CASH_READ, {
      requestId,
      resource: "GET /api/cash-box/movements/:id",
    })
    return ok(await getMovement(await parseCashIdParam(params)), { requestId })
  }
)
