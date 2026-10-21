import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { listContainers } from "@/modules/inventory/inventory.service"

export const dynamic = "force-dynamic"

/** GET /api/chip-containers — maletines (solo lectura: se crean por seed). */
export const GET = withApiHandler(async (_req, { requestId }) => {
  await requirePermission(PERMISSIONS.CHIPS_READ, {
    requestId,
    resource: "GET /api/chip-containers",
  })
  return ok(await listContainers(), { requestId })
})
