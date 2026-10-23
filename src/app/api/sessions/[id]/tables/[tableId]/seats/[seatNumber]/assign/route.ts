import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  assignSeatSchema,
  parseSeatParams,
} from "@/modules/table-floor/table-floor.schemas"
import { assignSeat } from "@/modules/table-floor/seat.service"

export const dynamic = "force-dynamic"

/**
 * POST — ocupa un asiento libre con un jugador (pendiente de compra). No
 * genera compra, crédito, firma, entrega de fichas ni dinero. Idempotente.
 */
export const POST = withApiHandler<{
  id: string
  tableId: string
  seatNumber: string
}>(async (req, { params, requestId }) => {
  const actor = await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
    requestId,
    resource: "POST /api/sessions/:id/tables/:tableId/seats/:seatNumber/assign",
  })
  const { sessionId, tableId, seatNumber } = await parseSeatParams(params)
  const input = await parseJsonBody(req, assignSeatSchema)
  const result = await assignSeat(
    actor,
    sessionId,
    tableId,
    seatNumber,
    input,
    { requestId }
  )
  return ok(result, {
    status: result.replayed ? 200 : 201,
    message: `Jugador sentado en el asiento ${seatNumber}`,
    requestId,
  })
})
