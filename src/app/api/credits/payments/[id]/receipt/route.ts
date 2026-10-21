import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseIdParam } from "@/modules/credits/credit.schemas"
import { getCreditReceipt } from "@/modules/credits/credit-receipt.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.CREDITS_READ, {
      requestId,
      resource: "GET /api/credits/payments/:id/receipt",
    })
    return ok(await getCreditReceipt(await parseIdParam(params)), { requestId })
  }
)
