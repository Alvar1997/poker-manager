import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseIdParam } from "@/modules/special-operations/special.schemas"
import { getPayable } from "@/modules/special-operations/special-query.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SPECIAL_OPS_READ, {
      requestId,
      resource: "GET /api/special-operations/payables/:id",
    })
    return ok(await getPayable(await parseIdParam(params)), { requestId })
  }
)
