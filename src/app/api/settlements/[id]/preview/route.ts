import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseSettlementIdParam } from "@/modules/settlements/settlement.schemas"
import { previewSettlement } from "@/modules/settlements/settlement.service"

export const dynamic = "force-dynamic"

/** GET — plan vigente (deudas reales de este momento); informativo. */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SETTLEMENTS_READ, {
      requestId,
      resource: "GET /api/settlements/:id/preview",
    })
    return ok(await previewSettlement(await parseSettlementIdParam(params)), {
      requestId,
    })
  }
)
