import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { parseTableParams } from "@/modules/session-tables/session-table.schemas"
import { changeSeatSchema } from "@/modules/table-floor/table-floor.schemas"
import { changeSeat } from "@/modules/table-floor/seat.service"

export const dynamic = "force-dynamic"

/** POST — mueve al jugador a un asiento libre (misma participación; sin dinero ni fichas). */
export const POST = withApiHandler<{ id: string; tableId: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
      requestId,
      resource: "POST /api/sessions/:id/tables/:tableId/seats/change",
    })
    const { sessionId, tableId } = await parseTableParams(params)
    const input = await parseJsonBody(req, changeSeatSchema)
    const result = await changeSeat(actor, sessionId, tableId, input, {
      requestId,
    })
    return ok(result, {
      message: `Cambio al asiento ${result.seatNumber}`,
      requestId,
    })
  }
)
