import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { getSpecialOperationsOverview } from "@/modules/special-operations/special-query.service"

export const dynamic = "force-dynamic"

/** GET — resumen de operaciones especiales (obligaciones abiertas, pendientes). */
export const GET = withApiHandler(async (_req, { requestId }) => {
  await requirePermission(PERMISSIONS.SPECIAL_OPS_READ, {
    requestId,
    resource: "GET /api/special-operations",
  })
  return ok(await getSpecialOperationsOverview(), { requestId })
})
