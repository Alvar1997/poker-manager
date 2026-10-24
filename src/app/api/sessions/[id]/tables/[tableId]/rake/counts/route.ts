import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseTableParams } from "@/modules/session-tables/session-table.schemas"
import { parseJsonBody } from "@/lib/validation"
import { rakeCountSchema } from "@/modules/rake/rake.schemas"
import { confirmRakeCount } from "@/modules/rake/rake.service"

export const dynamic = "force-dynamic"

/** POST — Módulo 18.  */
export const POST = withApiHandler<{ id: string; tableId: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.RAKE_OPERATE, {
      requestId,
      resource: "POST /api/sessions/:id/tables/:tableId/rake/counts",
    })
    const { sessionId, tableId } = await parseTableParams(params)
    const input = await parseJsonBody(req, rakeCountSchema)
    const r = await confirmRakeCount(actor, sessionId, tableId, input, {
      requestId,
    })
    return ok(r, {
      status: r.replayed ? 200 : 201,
      requestId,
      message: "Conteo de rake confirmado",
    })
  }
)
