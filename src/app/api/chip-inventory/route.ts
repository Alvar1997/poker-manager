import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { getInventorySummary } from "@/modules/inventory/inventory.service"

export const dynamic = "force-dynamic"

/** GET /api/chip-inventory — resumen por juego físico (sin valores ficticios). */
export const GET = withApiHandler(async (_req, { requestId }) => {
  await requirePermission(PERMISSIONS.CHIPS_READ, {
    requestId,
    resource: "GET /api/chip-inventory",
  })
  return ok(await getInventorySummary(), { requestId })
})
