import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { can, PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseQueryParams } from "@/lib/validation"
import { parseSessionIdParam } from "@/modules/sessions/session.schemas"
import { participationsQuerySchema } from "@/modules/session-tables/session-table.schemas"
import { listParticipations } from "@/modules/session-tables/participation.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_READ, {
      requestId,
      resource: "GET /api/sessions/:id/participations",
    })
    const sessionId = await parseSessionIdParam(params)
    const filters = parseQueryParams(
      req.nextUrl.searchParams,
      participationsQuerySchema
    )
    return ok(
      await listParticipations(sessionId, filters, {
        showPhone: can(actor, PERMISSIONS.PLAYERS_READ),
      }),
      { requestId }
    )
  }
)
