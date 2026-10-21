import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseQueryParams } from "@/lib/validation"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { movementsQuerySchema } from "@/modules/inventory/inventory.schemas"
import { listMovements } from "@/modules/inventory/inventory.service"

export const dynamic = "force-dynamic"

/** GET /api/chip-inventory/movements — libro paginado (juego, tipo, fecha, usuario, denominación). */
export const GET = withApiHandler(async (req, { requestId }) => {
  await requirePermission(PERMISSIONS.CHIPS_READ, {
    requestId,
    resource: "GET /api/chip-inventory/movements",
  })
  const query = parseQueryParams(req.nextUrl.searchParams, movementsQuerySchema)
  return ok(await listMovements(query), { requestId })
})
