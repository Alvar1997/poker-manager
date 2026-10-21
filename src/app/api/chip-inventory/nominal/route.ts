import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { getAvailableNominalValue } from "@/modules/inventory/reservation.service"

export const dynamic = "force-dynamic"

/**
 * GET /api/chip-inventory/nominal — saldo nominal del inventario compartido:
 * custodia, reservado, disponible y en circulación (las compras se validan
 * contra `available`).
 */
export const GET = withApiHandler(async (_req, { requestId }) => {
  await requirePermission(PERMISSIONS.CHIPS_READ, {
    requestId,
    resource: "GET /api/chip-inventory/nominal",
  })
  return ok(await getAvailableNominalValue(), { requestId })
})
