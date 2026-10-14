import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parsePlayerIdParam } from "@/modules/players/player.schemas"
import { getPlayerAudit } from "@/modules/players/player.service"

export const dynamic = "force-dynamic"

/** GET /api/players/:id/audit — eventos del jugador, sanitizados (teléfonos enmascarados). */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.AUDIT_READ, {
      requestId,
      resource: "GET /api/players/:id/audit",
    })
    return ok(await getPlayerAudit(await parsePlayerIdParam(params)), {
      requestId,
    })
  }
)
