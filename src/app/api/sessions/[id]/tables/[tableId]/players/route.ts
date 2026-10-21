import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { can, PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  addPlayerSchema,
  parseTableParams,
} from "@/modules/session-tables/session-table.schemas"
import {
  addPlayerToTable,
  getActiveParticipants,
  getParticipation,
} from "@/modules/session-tables/participation.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler<{ id: string; tableId: string }>(
  async (_req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_READ, {
      requestId,
      resource: "GET /api/sessions/:id/tables/:tableId/players",
    })
    const { sessionId, tableId } = await parseTableParams(params)
    return ok(
      await getActiveParticipants(sessionId, tableId, {
        showPhone: can(actor, PERMISSIONS.PLAYERS_READ),
      }),
      { requestId }
    )
  }
)

/**
 * POST — incorpora un jugador activo a la mesa (ciclo vigente). Solo recibe
 * playerId e idempotencyKey: hora, responsable, estado y ciclo los fija el
 * servidor. No genera compra, entrega de fichas, crédito ni cobro.
 */
export const POST = withApiHandler<{ id: string; tableId: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
      requestId,
      resource: "POST /api/sessions/:id/tables/:tableId/players",
    })
    const { sessionId, tableId } = await parseTableParams(params)
    const input = await parseJsonBody(req, addPlayerSchema)
    const result = await addPlayerToTable(actor, sessionId, tableId, input, {
      requestId,
    })
    const view = await getParticipation(sessionId, result.participationId, {
      showPhone: can(actor, PERMISSIONS.PLAYERS_READ),
    })
    return ok(view, {
      status: result.replayed ? 200 : 201,
      message: "Jugador registrado",
      requestId,
    })
  }
)
