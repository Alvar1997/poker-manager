import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { getPlayerSessionCredit } from "@/modules/reports/credit-report.service"
import { assertId, authorizeReport } from "@/modules/reports/report-route"

export const dynamic = "force-dynamic"

/** GET — obligaciones individuales (compra/recompra) de una sesión de origen. */
export const GET = withApiHandler<{ playerId: string; sessionId: string }>(
  async (req, { params, requestId }) => {
    const { filters } = await authorizeReport("credits", req, requestId)
    const { playerId, sessionId } = await params
    const r = await getPlayerSessionCredit(
      assertId(playerId, "Jugador"),
      assertId(sessionId, "Sesión"),
      filters
    )
    return ok(
      {
        player: r.player,
        session: r.session.session,
        purchases: r.session.debts,
      },
      { requestId }
    )
  }
)
