import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseTableParams } from "@/modules/session-tables/session-table.schemas"
import { getDealerHistory } from "@/modules/table-floor/dealer.service"

export const dynamic = "force-dynamic"

/** GET — historial de dealers de la mesa en la sesión. */
export const GET = withApiHandler<{ id: string; tableId: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SESSIONS_READ, {
      requestId,
      resource: "GET /api/sessions/:id/tables/:tableId/dealer/history",
    })
    const { sessionId, tableId } = await parseTableParams(params)
    return ok(await getDealerHistory(sessionId, tableId), { requestId })
  }
)
