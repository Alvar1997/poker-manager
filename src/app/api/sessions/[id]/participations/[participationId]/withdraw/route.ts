import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { parseParticipationParams } from "@/modules/session-tables/session-table.schemas"
import { withdrawSchema } from "@/modules/table-floor/table-floor.schemas"
import { withdrawWithoutPurchase } from "@/modules/table-floor/seat.service"

export const dynamic = "force-dynamic"

/**
 * POST — retira de la mesa a un jugador que NUNCA recibió fichas (sin
 * compra confirmada), con motivo y auditoría. Si recibió fichas: liquidación.
 */
export const POST = withApiHandler<{ id: string; participationId: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
      requestId,
      resource:
        "POST /api/sessions/:id/participations/:participationId/withdraw",
    })
    const { sessionId, participationId } =
      await parseParticipationParams(params)
    const input = await parseJsonBody(req, withdrawSchema)
    return ok(
      await withdrawWithoutPurchase(actor, sessionId, participationId, input, {
        requestId,
      }),
      { message: "Jugador retirado sin compra", requestId }
    )
  }
)
