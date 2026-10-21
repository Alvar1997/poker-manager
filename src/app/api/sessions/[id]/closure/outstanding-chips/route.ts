import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseSessionIdParam } from "@/modules/sessions/session.schemas"
import { getOutstandingChips } from "@/modules/closure/chip-circulation.service"

export const dynamic = "force-dynamic"

/** GET — fichas no retornadas de la sesión, circulación global y atribución informativa. */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SESSIONS_READ, {
      requestId,
      resource: "GET /api/sessions/:id/closure/outstanding-chips",
    })
    const id = await parseSessionIdParam(params)
    return ok(await getOutstandingChips(id), { requestId })
  }
)
