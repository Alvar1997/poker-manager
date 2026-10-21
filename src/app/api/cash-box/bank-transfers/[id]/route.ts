import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { getBankTransfer } from "@/modules/cash/bank-transfer.service"
import { parseCashIdParam } from "@/modules/cash/cash.schemas"

export const dynamic = "force-dynamic"

export const GET = withApiHandler<{ id: string }>(
  async (_req, { requestId, params }) => {
    await requirePermission(PERMISSIONS.CASH_READ, {
      requestId,
      resource: "GET /api/cash-box/bank-transfers/:id",
    })
    return ok(await getBankTransfer(await parseCashIdParam(params)), {
      requestId,
    })
  }
)
