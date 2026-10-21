import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  openTableSchema,
  parseTableParams,
} from "@/modules/session-tables/session-table.schemas"
import { openSessionTable } from "@/modules/session-tables/session-table.service"

export const dynamic = "force-dynamic"

/**
 * POST — abre (o reabre con un ciclo nuevo) la mesa en la sesión OPEN. Hora
 * del servidor; sin arqueo, sin dinero, sin fichas, sin jugadores. Idempotente.
 */
export const POST = withApiHandler<{ id: string; tableId: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
      requestId,
      resource: "POST /api/sessions/:id/tables/:tableId/open",
    })
    const { sessionId, tableId } = await parseTableParams(params)
    const input = await parseJsonBody(req, openTableSchema)
    const result = await openSessionTable(actor, sessionId, tableId, input, {
      requestId,
    })
    return ok(result.table, {
      status: result.replayed ? 200 : 201,
      message: "Mesa abierta",
      requestId,
    })
  }
)
