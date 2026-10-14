import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseJsonBody, parseQueryParams } from "@/lib/validation"
import { can, PERMISSIONS, requirePermission } from "@/config/permissions"
import {
  createPlayerSchema,
  listPlayersQuerySchema,
} from "@/modules/players/player.schemas"
import { createPlayer, listPlayers } from "@/modules/players/player.service"

export const dynamic = "force-dynamic"

/**
 * GET /api/players — búsqueda paginada en servidor por nombre, apodo o
 * teléfono (`q`), filtro `status`, orden `sort`/`order` controlados.
 */
export const GET = withApiHandler(async (req, { requestId }) => {
  await requirePermission(PERMISSIONS.PLAYERS_READ, {
    requestId,
    resource: "GET /api/players",
  })
  const query = parseQueryParams(
    req.nextUrl.searchParams,
    listPlayersQuerySchema
  )
  const response = ok(await listPlayers(query), { requestId })
  response.headers.set("Cache-Control", "no-store")
  return response
})

/** POST /api/players — alta; teléfono normalizado E.164 y único (409 si existe). */
export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.PLAYERS_CREATE, {
    requestId,
    resource: "POST /api/players",
  })
  const input = await parseJsonBody(req, createPlayerSchema)
  if (input.whatsappConsent) {
    await requirePermission(PERMISSIONS.PLAYERS_CONSENT, {
      requestId,
      resource: "POST /api/players (consentimiento)",
    })
  }

  const player = await createPlayer(
    actor,
    { ...input, countryCode: input.countryCode! },
    { requestId, revealExisting: can(actor, PERMISSIONS.PLAYERS_READ) }
  )
  return ok(player, { status: 201, message: "Jugador registrado", requestId })
})
