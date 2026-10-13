import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { can, PERMISSIONS, requirePermission } from "@/config/permissions"
import { listPaymentMethods } from "@/modules/payments/payment-method.service"

export const dynamic = "force-dynamic"

/** GET /api/payment-methods — CASHIER ve solo los disponibles (activos). */
export const GET = withApiHandler(async (_req, { requestId }) => {
  const user = await requirePermission(PERMISSIONS.CATALOGS_READ, {
    requestId,
    resource: "GET /api/payment-methods",
  })
  const includeInactive = can(user, PERMISSIONS.SETTINGS_READ)
  return ok(await listPaymentMethods({ includeInactive }), { requestId })
})
