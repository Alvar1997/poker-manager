import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseJsonBody } from "@/lib/validation"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseIdParam, statusSchema } from "@/modules/settings/settings.schemas"
import { setDenominationStatus } from "@/modules/chips/chip-set.service"

export const dynamic = "force-dynamic"

/** PATCH /api/denominations/:id/status — activar/desactivar (sin borrado físico). Solo SUPERADMIN. */
export const PATCH = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SETTINGS_MANAGE, {
      requestId,
      resource: "PATCH /api/denominations/:id/status",
    })
    const id = await parseIdParam(params)
    const { isActive } = await parseJsonBody(req, statusSchema)
    return ok(await setDenominationStatus(actor, id, isActive, { requestId }), {
      message: isActive ? "Denominación activada" : "Denominación desactivada",
      requestId,
    })
  }
)
