import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { can, PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseTableParams } from "@/modules/session-tables/session-table.schemas"
import { getTableBoard } from "@/modules/table-floor/seat.service"

export const dynamic = "force-dynamic"

/**
 * GET — mesa interactiva: nueve asientos con su ocupante (estado derivado
 * de compras reales), jugadores activos sin asiento, dealer vigente, paño y
 * asientos libres de las otras mesas abiertas. Solo lectura.
 */
export const GET = withApiHandler<{ id: string; tableId: string }>(
  async (_req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_READ, {
      requestId,
      resource: "GET /api/sessions/:id/tables/:tableId/seats",
    })
    const { sessionId, tableId } = await parseTableParams(params)
    return ok(
      await getTableBoard(sessionId, tableId, {
        showPhone: can(actor, PERMISSIONS.PLAYERS_READ),
      }),
      { requestId }
    )
  }
)
