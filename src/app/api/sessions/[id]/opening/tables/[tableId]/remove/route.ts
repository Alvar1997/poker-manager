import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseTableParams } from "@/modules/session-tables/session-table.schemas"
import { unplanOpeningTable } from "@/modules/sessions/opening-wizard.service"

export const dynamic = "force-dynamic"

/** POST — quita la mesa de la preparación (queda registrado). Idempotente. */
export const POST = withApiHandler<{ id: string; tableId: string }>(
  async (_req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
      requestId,
      resource: "POST /api/sessions/:id/opening/tables/:tableId/remove",
    })
    const { sessionId, tableId } = await parseTableParams(params)
    return ok(
      await unplanOpeningTable(actor, sessionId, tableId, { requestId }),
      { message: "Mesa quitada de la preparación", requestId }
    )
  }
)
