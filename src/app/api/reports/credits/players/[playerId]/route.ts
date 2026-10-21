import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { getPlayerCreditReport } from "@/modules/reports/credit-report.service"
import { assertId, authorizeReport } from "@/modules/reports/report-route"

export const dynamic = "force-dynamic"

/** GET — estado de cuenta: jugador → sesiones de origen → compras → aplicaciones. */
export const GET = withApiHandler<{ playerId: string }>(
  async (req, { params, requestId }) => {
    const { filters } = await authorizeReport("credits", req, requestId)
    const { playerId } = await params
    return ok(
      await getPlayerCreditReport(assertId(playerId, "Jugador"), filters),
      { requestId }
    )
  }
)
