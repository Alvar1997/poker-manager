import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { planOpeningTable } from "@/modules/sessions/opening-wizard.service"
import {
  openingTableSchema,
  parseSessionIdParam,
} from "@/modules/sessions/session.schemas"

export const dynamic = "force-dynamic"

/**
 * POST — agrega una mesa del catálogo a la preparación. No abre la mesa ni
 * mueve fichas o dinero: se abre al confirmar la apertura. Idempotente.
 */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
      requestId,
      resource: "POST /api/sessions/:id/opening/tables",
    })
    const id = await parseSessionIdParam(params)
    const { tableId } = await parseJsonBody(req, openingTableSchema)
    return ok(await planOpeningTable(actor, id, tableId, { requestId }), {
      message: "Mesa agregada a la preparación",
      requestId,
    })
  }
)
