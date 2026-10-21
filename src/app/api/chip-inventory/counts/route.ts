import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseJsonBody, parseQueryParams } from "@/lib/validation"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import {
  countsQuerySchema,
  createCountSchema,
} from "@/modules/inventory/inventory.schemas"
import {
  createStockCount,
  listStockCounts,
} from "@/modules/inventory/stock-count.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler(async (req, { requestId }) => {
  await requirePermission(PERMISSIONS.CHIPS_READ, {
    requestId,
    resource: "GET /api/chip-inventory/counts",
  })
  const query = parseQueryParams(req.nextUrl.searchParams, countsQuerySchema)
  return ok(await listStockCounts(query), { requestId })
})

/** POST — inicia un arqueo en borrador (CONTROL, o INITIAL para capturar el inicial por partes). */
export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.CHIPS_OPERATE, {
    requestId,
    resource: "POST /api/chip-inventory/counts",
  })
  const input = await parseJsonBody(req, createCountSchema)
  return ok(await createStockCount(actor, input, { requestId }), {
    status: 201,
    message: "Arqueo iniciado",
    requestId,
  })
})
