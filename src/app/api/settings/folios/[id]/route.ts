import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseJsonBody } from "@/lib/validation"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { updateFolioSequence } from "@/modules/settings/folio.service"
import {
  parseIdParam,
  updateFolioSequenceSchema,
} from "@/modules/settings/settings.schemas"

export const dynamic = "force-dynamic"

/** PATCH /api/settings/folios/:id — solo antes del primer folio emitido; solo SUPERADMIN. */
export const PATCH = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SETTINGS_MANAGE, {
      requestId,
      resource: "PATCH /api/settings/folios/:id",
    })
    const id = await parseIdParam(params)
    const input = await parseJsonBody(req, updateFolioSequenceSchema)
    return ok(await updateFolioSequence(actor, id, input, { requestId }), {
      message: "Consecutivo actualizado",
      requestId,
    })
  }
)
