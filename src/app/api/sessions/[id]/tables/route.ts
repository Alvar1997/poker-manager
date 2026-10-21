import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseSessionIdParam } from "@/modules/sessions/session.schemas"
import { getSessionTables } from "@/modules/session-tables/session-table.service"

export const dynamic = "force-dynamic"

/** GET /api/sessions/:id/tables — mesas de la sesión (estado, ciclo vigente, jugadores activos). */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SESSIONS_READ, {
      requestId,
      resource: "GET /api/sessions/:id/tables",
    })
    return ok(await getSessionTables(await parseSessionIdParam(params)), {
      requestId,
    })
  }
)
