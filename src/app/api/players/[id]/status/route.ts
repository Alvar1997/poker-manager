import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseJsonBody } from "@/lib/validation"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import {
  parsePlayerIdParam,
  playerStatusSchema,
} from "@/modules/players/player.schemas"
import { setPlayerStatus } from "@/modules/players/player.service"

export const dynamic = "force-dynamic"

/** PATCH /api/players/:id/status — activar/desactivar (sin borrar historial ni deudas). */
export const PATCH = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.PLAYERS_MANAGE, {
      requestId,
      resource: "PATCH /api/players/:id/status",
    })
    const id = await parsePlayerIdParam(params)
    const { isActive, reason } = await parseJsonBody(req, playerStatusSchema)
    const player = await setPlayerStatus(actor, id, isActive, reason, {
      requestId,
    })
    return ok(player, {
      message: isActive ? "Jugador activado" : "Jugador desactivado",
      requestId,
    })
  }
)
