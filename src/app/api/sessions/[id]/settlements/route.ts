import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { prisma } from "@/lib/prisma"
import { parseSettlementIdParam } from "@/modules/settlements/settlement.schemas"
import { listPendingPayables } from "@/modules/settlements/settlement-payout.service"
import {
  getSessionSettlementOverview,
  listSettlements,
} from "@/modules/settlements/settlement.service"

export const dynamic = "force-dynamic"

/**
 * GET — liquidaciones de la sesión, las que están en curso (bloquean el
 * cierre) y las obligaciones por pagar que sobrevivirán al cierre.
 */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SETTLEMENTS_READ, {
      requestId,
      resource: "GET /api/sessions/:id/settlements",
    })
    const sessionId = await parseSettlementIdParam(params)
    const [list, overview, pending] = await Promise.all([
      listSettlements({ sessionId, page: 1, pageSize: 100 }),
      getSessionSettlementOverview(prisma, sessionId),
      listPendingPayables({ sessionId }),
    ])
    return ok({ ...list, overview, pendingPayables: pending }, { requestId })
  }
)
