import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseJsonBody } from "@/lib/validation"
import { can, PERMISSIONS, requirePermission } from "@/config/permissions"
import {
  parsePlayerIdParam,
  updatePlayerSchema,
} from "@/modules/players/player.schemas"
import { getPlayer, updatePlayer } from "@/modules/players/player.service"

export const dynamic = "force-dynamic"

type Params = { id: string }

/** GET /api/players/:id — perfil (sin deudas ni saldos: no existen todavía). */
export const GET = withApiHandler<Params>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.PLAYERS_READ, {
      requestId,
      resource: "GET /api/players/:id",
    })
    const response = ok(await getPlayer(await parsePlayerIdParam(params)), {
      requestId,
    })
    response.headers.set("Cache-Control", "no-store")
    return response
  }
)

/**
 * PATCH /api/players/:id — nombre, apodo, teléfono (con historial) y
 * notas. Estado y consentimiento van por sus propios endpoints.
 */
export const PATCH = withApiHandler<Params>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.PLAYERS_UPDATE, {
      requestId,
      resource: "PATCH /api/players/:id",
    })
    const id = await parsePlayerIdParam(params)
    const input = await parseJsonBody(req, updatePlayerSchema)
    const player = await updatePlayer(actor, id, input, {
      requestId,
      revealExisting: can(actor, PERMISSIONS.PLAYERS_READ),
    })
    return ok(player, { message: "Jugador actualizado", requestId })
  }
)
