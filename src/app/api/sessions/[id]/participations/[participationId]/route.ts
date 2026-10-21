import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { can, PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseParticipationParams } from "@/modules/session-tables/session-table.schemas"
import { getParticipation } from "@/modules/session-tables/participation.service"

export const dynamic = "force-dynamic"

/** GET — detalle de una participación. No existe escritura genérica (SETTLED solo vía liquidación). */
export const GET = withApiHandler<{ id: string; participationId: string }>(
  async (_req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_READ, {
      requestId,
      resource: "GET /api/sessions/:id/participations/:participationId",
    })
    const { sessionId, participationId } =
      await parseParticipationParams(params)
    return ok(
      await getParticipation(sessionId, participationId, {
        showPhone: can(actor, PERMISSIONS.PLAYERS_READ),
      }),
      { requestId }
    )
  }
)
