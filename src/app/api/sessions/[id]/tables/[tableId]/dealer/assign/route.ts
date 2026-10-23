import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { parseTableParams } from "@/modules/session-tables/session-table.schemas"
import { assignDealerSchema } from "@/modules/table-floor/table-floor.schemas"
import { assignDealer } from "@/modules/table-floor/dealer.service"

export const dynamic = "force-dynamic"

/** POST — asigna (o cambia) el dealer del ciclo vigente de la mesa. Idempotente. */
export const POST = withApiHandler<{ id: string; tableId: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
      requestId,
      resource: "POST /api/sessions/:id/tables/:tableId/dealer/assign",
    })
    const { sessionId, tableId } = await parseTableParams(params)
    const input = await parseJsonBody(req, assignDealerSchema)
    const result = await assignDealer(actor, sessionId, tableId, input, {
      requestId,
    })
    return ok(result, {
      status: result.replayed ? 200 : 201,
      message: "Dealer asignado",
      requestId,
    })
  }
)
