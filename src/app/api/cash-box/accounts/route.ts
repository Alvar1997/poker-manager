import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { listFinancialAccounts } from "@/modules/cash/cash.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler(async (_req, { requestId }) => {
  await requirePermission(PERMISSIONS.CASH_READ, {
    requestId,
    resource: "GET /api/cash-box/accounts",
  })
  return ok(await listFinancialAccounts(), { requestId })
})
