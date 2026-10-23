import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { parseTableParams } from "@/modules/session-tables/session-table.schemas"
import { releaseDealerSchema } from "@/modules/table-floor/table-floor.schemas"
import { releaseDealer } from "@/modules/table-floor/dealer.service"

export const dynamic = "force-dynamic"

/** POST — libera al dealer de la mesa sin reemplazo. Idempotente. */
export const POST = withApiHandler<{ id: string; tableId: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
      requestId,
      resource: "POST /api/sessions/:id/tables/:tableId/dealer/release",
    })
    const { sessionId, tableId } = await parseTableParams(params)
    const input = await parseJsonBody(req, releaseDealerSchema)
    return ok(
      await releaseDealer(actor, sessionId, tableId, input, { requestId }),
      { message: "Dealer liberado", requestId }
    )
  }
)
