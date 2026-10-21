import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { getPurchaseAvailability } from "@/modules/purchases/purchase.service"

export const dynamic = "force-dynamic"

/** GET — valor nominal disponible del inventario compartido. */
export const GET = withApiHandler(async (_req, { requestId }) => {
  await requirePermission(PERMISSIONS.PURCHASES_READ, {
    requestId,
    resource: "GET /api/purchases/availability",
  })
  return ok(await getPurchaseAvailability(), { requestId })
})
