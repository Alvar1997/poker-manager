import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { NotFoundError } from "@/lib/errors"
import { parseJsonBody } from "@/lib/validation"
import { can, PERMISSIONS, requirePermission } from "@/config/permissions"
import { getChipSet, updateChipSet } from "@/modules/chips/chip-set.service"
import {
  parseIdParam,
  updateChipSetSchema,
} from "@/modules/settings/settings.schemas"

export const dynamic = "force-dynamic"

type Params = { id: string }

export const GET = withApiHandler<Params>(
  async (_req, { params, requestId }) => {
    const user = await requirePermission(PERMISSIONS.CATALOGS_READ, {
      requestId,
      resource: "GET /api/chip-sets/:id",
    })
    const set = await getChipSet(await parseIdParam(params))
    if (!set.isActive && !can(user, PERMISSIONS.SETTINGS_READ)) {
      throw new NotFoundError("Juego de fichas no encontrado")
    }
    return ok(set, { requestId })
  }
)

/** PATCH /api/chip-sets/:id — nombre y descripción (el código es inmutable). */
export const PATCH = withApiHandler<Params>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SETTINGS_MANAGE, {
      requestId,
      resource: "PATCH /api/chip-sets/:id",
    })
    const id = await parseIdParam(params)
    const input = await parseJsonBody(req, updateChipSetSchema)
    return ok(await updateChipSet(actor, id, input, { requestId }), {
      message: "Juego de fichas actualizado",
      requestId,
    })
  }
)
