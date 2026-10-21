import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { listPayments } from "@/modules/credits/receivable-payment.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler(async (_req, { requestId }) => {
  await requirePermission(PERMISSIONS.CREDITS_READ, {
    requestId,
    resource: "GET /api/credits/administrative",
  })
  return ok(
    await listPayments({ origin: "ADMINISTRATIVE", page: 1, pageSize: 100 }),
    { requestId }
  )
})
