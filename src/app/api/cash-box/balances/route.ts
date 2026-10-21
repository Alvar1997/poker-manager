import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { getBalances } from "@/modules/cash/cash.service"

/** GET /api/cash-box/balances — efectivo SOLO de la sesión abierta; banco = neto conocido (no saldo real). */

export const dynamic = "force-dynamic"

export const GET = withApiHandler(async (_req, { requestId }) => {
  await requirePermission(PERMISSIONS.CASH_READ, {
    requestId,
    resource: "GET /api/cash-box/balances",
  })
  return ok(await getBalances(), { requestId })
})
