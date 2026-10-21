import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseQueryParams } from "@/lib/validation"
import { listBankTransfers } from "@/modules/cash/bank-transfer.service"
import { bankTransfersQuerySchema } from "@/modules/cash/cash.schemas"

export const dynamic = "force-dynamic"

export const GET = withApiHandler(async (req, { requestId }) => {
  await requirePermission(PERMISSIONS.CASH_READ, {
    requestId,
    resource: "GET /api/cash-box/bank-transfers",
  })
  const query = parseQueryParams(
    req.nextUrl.searchParams,
    bankTransfersQuerySchema
  )
  return ok(await listBankTransfers(query), { requestId })
})
