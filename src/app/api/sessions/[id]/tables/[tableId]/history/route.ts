import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseQueryParams } from "@/lib/validation"
import {
  historyQuerySchema,
  parseTableParams,
} from "@/modules/session-tables/session-table.schemas"
import { getTableHistory } from "@/modules/session-tables/session-table.service"

export const dynamic = "force-dynamic"

/** GET — ciclos, ingresos y transferencias de la mesa (filtros: cycle, from, to). */
export const GET = withApiHandler<{ id: string; tableId: string }>(
  async (req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SESSIONS_READ, {
      requestId,
      resource: "GET /api/sessions/:id/tables/:tableId/history",
    })
    const { sessionId, tableId } = await parseTableParams(params)
    return ok(
      await getTableHistory(
        sessionId,
        tableId,
        parseQueryParams(req.nextUrl.searchParams, historyQuerySchema)
      ),
      { requestId }
    )
  }
)
