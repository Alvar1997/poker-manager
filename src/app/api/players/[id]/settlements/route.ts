import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseSettlementIdParam } from "@/modules/settlements/settlement.schemas"
import { listPendingPayables } from "@/modules/settlements/settlement-payout.service"
import { listSettlements } from "@/modules/settlements/settlement.service"

export const dynamic = "force-dynamic"

/** GET — historial de liquidaciones del jugador y lo que se le debe pagar. */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SETTLEMENTS_READ, {
      requestId,
      resource: "GET /api/players/:id/settlements",
    })
    const playerId = await parseSettlementIdParam(params)
    const [list, pending] = await Promise.all([
      listSettlements({ playerId, page: 1, pageSize: 100 }),
      listPendingPayables({ playerId }),
    ])
    return ok({ ...list, pendingPayables: pending }, { requestId })
  }
)
