import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import {
  getCreditSummary,
  listCreditPlayers,
} from "@/modules/reports/credit-report.service"
import { authorizeReport } from "@/modules/reports/report-route"

export const dynamic = "force-dynamic"

/** GET — resumen global de créditos + jugadores (deudas más antiguas primero). */
export const GET = withApiHandler(async (req, { requestId }) => {
  const { filters } = await authorizeReport("credits", req, requestId)
  const [summary, players] = await Promise.all([
    getCreditSummary(filters),
    listCreditPlayers(filters),
  ])
  return ok({ summary, players }, { requestId })
})
