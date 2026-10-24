import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseTableParams } from "@/modules/session-tables/session-table.schemas"
import { getTableRake } from "@/modules/rake/rake.service"

export const dynamic = "force-dynamic"

/** GET — Módulo 18. Rake de la mesa: modalidad, ciclos, historial y acumulado. */
export const GET = withApiHandler<{ id: string; tableId: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.RAKE_READ, {
      requestId,
      resource: "GET /api/sessions/:id/tables/:tableId/rake",
    })
    const { sessionId, tableId } = await parseTableParams(params)
    void actor
    const r = await getTableRake(sessionId, tableId)
    return ok(r, { status: 200, requestId })
  }
)
