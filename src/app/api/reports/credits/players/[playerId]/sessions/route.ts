import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { getPlayerCreditReport } from "@/modules/reports/credit-report.service"
import { assertId, authorizeReport } from "@/modules/reports/report-route"

export const dynamic = "force-dynamic"

/** GET — deudas del jugador agrupadas por SESIÓN DE ORIGEN (sin el detalle por compra). */
export const GET = withApiHandler<{ playerId: string }>(
  async (req, { params, requestId }) => {
    const { filters } = await authorizeReport("credits", req, requestId)
    const { playerId } = await params
    const r = await getPlayerCreditReport(
      assertId(playerId, "Jugador"),
      filters
    )
    return ok(
      {
        player: r.player,
        totals: r.totals,
        sessions: r.sessions.map((s) => ({ ...s, debts: undefined })),
      },
      { requestId }
    )
  }
)
