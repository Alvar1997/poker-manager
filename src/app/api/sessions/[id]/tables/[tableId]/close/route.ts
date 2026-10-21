import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  closeTableSchema,
  parseTableParams,
} from "@/modules/session-tables/session-table.schemas"
import { closeSessionTable } from "@/modules/session-tables/session-table.service"

export const dynamic = "force-dynamic"

/** POST — cierra el ciclo vigente (sin jugadores activos). La sesión sigue abierta. */
export const POST = withApiHandler<{ id: string; tableId: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
      requestId,
      resource: "POST /api/sessions/:id/tables/:tableId/close",
    })
    const { sessionId, tableId } = await parseTableParams(params)
    const input = await parseJsonBody(req, closeTableSchema)
    const result = await closeSessionTable(actor, sessionId, tableId, input, {
      requestId,
    })
    return ok(result.table, { message: "Mesa cerrada", requestId })
  }
)
