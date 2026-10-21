import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseQueryParams } from "@/lib/validation"
import { movementsQuerySchema } from "@/modules/cash/cash.schemas"
import { listMovements } from "@/modules/cash/cash.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler(async (req, { requestId }) => {
  await requirePermission(PERMISSIONS.CASH_READ, {
    requestId,
    resource: "GET /api/cash-box/movements",
  })
  const query = parseQueryParams(req.nextUrl.searchParams, movementsQuerySchema)
  return ok(await listMovements(query), { requestId })
})
