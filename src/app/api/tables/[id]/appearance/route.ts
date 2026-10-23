import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  appearanceSchema,
  parseIdParam,
} from "@/modules/table-floor/table-floor.schemas"
import { setTableFeltColor } from "@/modules/table-floor/appearance.service"

export const dynamic = "force-dynamic"

/**
 * PATCH — color del paño de la mesa (solo visual, paleta cerrada con
 * contraste verificado). No afecta caja, inventario ni registros financieros.
 */
export const PATCH = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
      requestId,
      resource: "PATCH /api/tables/:id/appearance",
    })
    const tableId = await parseIdParam(params)
    const { feltColor } = await parseJsonBody(req, appearanceSchema)
    return ok(
      await setTableFeltColor(actor, tableId, feltColor, { requestId }),
      {
        message: "Paño actualizado",
        requestId,
      }
    )
  }
)
