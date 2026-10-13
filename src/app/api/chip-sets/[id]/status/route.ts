import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseJsonBody } from "@/lib/validation"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseIdParam, statusSchema } from "@/modules/settings/settings.schemas"
import { setChipSetStatus } from "@/modules/chips/chip-set.service"

export const dynamic = "force-dynamic"

/** PATCH /api/chip-sets/:id/status — activar/desactivar (sin borrado físico). Solo SUPERADMIN. */
export const PATCH = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SETTINGS_MANAGE, {
      requestId,
      resource: "PATCH /api/chip-sets/:id/status",
    })
    const id = await parseIdParam(params)
    const { isActive } = await parseJsonBody(req, statusSchema)
    return ok(await setChipSetStatus(actor, id, isActive, { requestId }), {
      message: isActive
        ? "Juego de fichas activado"
        : "Juego de fichas desactivado",
      requestId,
    })
  }
)
