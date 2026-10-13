import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseJsonBody } from "@/lib/validation"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { updateDenomination } from "@/modules/chips/chip-set.service"
import {
  parseIdParam,
  updateDenominationSchema,
} from "@/modules/settings/settings.schemas"

export const dynamic = "force-dynamic"

/** PATCH /api/denominations/:id — valor, nombre, color, orden. Solo SUPERADMIN. */
export const PATCH = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SETTINGS_MANAGE, {
      requestId,
      resource: "PATCH /api/denominations/:id",
    })
    const id = await parseIdParam(params)
    const input = await parseJsonBody(req, updateDenominationSchema)
    return ok(await updateDenomination(actor, id, input, { requestId }), {
      message: "Denominación actualizada",
      requestId,
    })
  }
)
