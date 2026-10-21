import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseQueryParams } from "@/lib/validation"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { movementsQuerySchema } from "@/modules/inventory/inventory.schemas"
import { listNominalMovements } from "@/modules/inventory/inventory.service"

export const dynamic = "force-dynamic"

/** GET /api/chip-inventory/nominal-movements — libro nominal (por importe), filtrable por mesa. */
export const GET = withApiHandler(async (req, { requestId }) => {
  await requirePermission(PERMISSIONS.CHIPS_READ, {
    requestId,
    resource: "GET /api/chip-inventory/nominal-movements",
  })
  const query = parseQueryParams(req.nextUrl.searchParams, movementsQuerySchema)
  return ok(await listNominalMovements(query), { requestId })
})
