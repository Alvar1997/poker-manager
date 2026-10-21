import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { getPlayerSessionCredit } from "@/modules/reports/credit-report.service"
import { assertId, authorizeReport } from "@/modules/reports/report-route"

export const dynamic = "force-dynamic"

/** GET — una sesión de origen del jugador con sus compras y aplicaciones. */
export const GET = withApiHandler<{ playerId: string; sessionId: string }>(
  async (req, { params, requestId }) => {
    const { filters } = await authorizeReport("credits", req, requestId)
    const { playerId, sessionId } = await params
    return ok(
      await getPlayerSessionCredit(
        assertId(playerId, "Jugador"),
        assertId(sessionId, "Sesión"),
        filters
      ),
      { requestId }
    )
  }
)
