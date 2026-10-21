import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseInventoryIdParam } from "@/modules/inventory/inventory.schemas"
import { getInventoryByChipSet } from "@/modules/inventory/inventory.service"

export const dynamic = "force-dynamic"

/** GET /api/chip-inventory/:chipSetId — existencias por denominación. */
export const GET = withApiHandler<{ chipSetId: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.CHIPS_READ, {
      requestId,
      resource: "GET /api/chip-inventory/:chipSetId",
    })
    return ok(
      await getInventoryByChipSet(
        await parseInventoryIdParam(params, "chipSetId")
      ),
      { requestId }
    )
  }
)
