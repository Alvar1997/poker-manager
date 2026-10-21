import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parsePlayerIdParam } from "@/modules/players/player.schemas"
import { getPhoneHistory } from "@/modules/players/player.service"

export const dynamic = "force-dynamic"

/**
 * GET /api/players/:id/phone-history — números anteriores completos:
 * datos personales históricos, solo para quien consulta auditoría.
 */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.PLAYERS_HISTORY_READ, {
      requestId,
      resource: "GET /api/players/:id/phone-history",
    })
    const response = ok(
      await getPhoneHistory(await parsePlayerIdParam(params)),
      {
        requestId,
      }
    )
    response.headers.set("Cache-Control", "no-store")
    return response
  }
)
