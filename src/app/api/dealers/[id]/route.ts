import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parseIdParam,
  updateDealerSchema,
} from "@/modules/table-floor/table-floor.schemas"
import { updateDealer } from "@/modules/table-floor/dealer.service"

export const dynamic = "force-dynamic"

/** PATCH — corrige nombre/apodo o activa/desactiva (sin borrado físico). */
export const PATCH = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
      requestId,
      resource: "PATCH /api/dealers/:id",
    })
    const id = await parseIdParam(params)
    const input = await parseJsonBody(req, updateDealerSchema)
    return ok(await updateDealer(actor, id, input, { requestId }), {
      message: "Dealer actualizado",
      requestId,
    })
  }
)
