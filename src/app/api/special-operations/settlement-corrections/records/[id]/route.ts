import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { getSettlementCorrection } from "@/modules/special-operations/settlement-correction.service"
import { parseIdParam } from "@/modules/special-operations/special.schemas"

export const dynamic = "force-dynamic"

export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SPECIAL_OPS_READ, {
      requestId,
      resource:
        "GET /api/special-operations/settlement-corrections/records/:id",
    })
    return ok(await getSettlementCorrection(await parseIdParam(params)), {
      requestId,
    })
  }
)
