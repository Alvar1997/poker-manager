import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseSettlementIdParam } from "@/modules/settlements/settlement.schemas"
import { getSettlement } from "@/modules/settlements/settlement.service"

export const dynamic = "force-dynamic"

/** GET — detalle (importes acordados, compensaciones, cuenta por pagar y pagos). */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SETTLEMENTS_READ, {
      requestId,
      resource: "GET /api/settlements/:id",
    })
    return ok(await getSettlement(await parseSettlementIdParam(params)), {
      requestId,
    })
  }
)
