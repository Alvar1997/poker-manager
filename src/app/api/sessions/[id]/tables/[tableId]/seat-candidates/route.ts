import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { can, PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseQueryParams } from "@/lib/validation"
import { parseTableParams } from "@/modules/session-tables/session-table.schemas"
import { seatCandidatesQuerySchema } from "@/modules/table-floor/table-floor.schemas"
import { searchSeatCandidates } from "@/modules/table-floor/seat.service"

export const dynamic = "force-dynamic"

/**
 * GET — busca jugadores para un asiento (nombre, apodo o teléfono; sin
 * acentos) e indica si pueden sentarse o por qué no.
 */
export const GET = withApiHandler<{ id: string; tableId: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.PLAYERS_READ, {
      requestId,
      resource: "GET /api/sessions/:id/tables/:tableId/seat-candidates",
    })
    const { sessionId, tableId } = await parseTableParams(params)
    const { q } = parseQueryParams(
      new URL(req.url).searchParams,
      seatCandidatesQuerySchema
    )
    return ok(
      await searchSeatCandidates(sessionId, tableId, q, {
        showPhone: can(actor, PERMISSIONS.PLAYERS_READ),
      }),
      { requestId }
    )
  }
)
