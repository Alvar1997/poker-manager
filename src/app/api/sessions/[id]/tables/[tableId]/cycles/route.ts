import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseTableParams } from "@/modules/session-tables/session-table.schemas"
import { getTableCycles } from "@/modules/session-tables/session-table.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler<{ id: string; tableId: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SESSIONS_READ, {
      requestId,
      resource: "GET /api/sessions/:id/tables/:tableId/cycles",
    })
    const { sessionId, tableId } = await parseTableParams(params)
    return ok(await getTableCycles(sessionId, tableId), { requestId })
  }
)
