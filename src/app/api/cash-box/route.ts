import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { getCashBoxOverview } from "@/modules/cash/cash.service"

/** GET /api/cash-box — caja central única: sesión abierta (si existe), saldos conocidos, flujos y últimos movimientos. */

export const dynamic = "force-dynamic"

export const GET = withApiHandler(async (_req, { requestId }) => {
  await requirePermission(PERMISSIONS.CASH_READ, {
    requestId,
    resource: "GET /api/cash-box",
  })
  const response = ok(await getCashBoxOverview(), { requestId })
  response.headers.set("Cache-Control", "no-store")
  return response
})
