import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseIdParam } from "@/modules/credits/credit.schemas"
import { getPlayerStatement } from "@/modules/credits/receivable.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.CREDITS_READ, {
      requestId,
      resource: "GET /api/credits/players/:id/statement",
    })
    return ok(await getPlayerStatement(await parseIdParam(params)), {
      requestId,
    })
  }
)
