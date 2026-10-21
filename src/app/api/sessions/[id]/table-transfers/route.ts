import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { parseSessionIdParam } from "@/modules/sessions/session.schemas"
import { transferSchema } from "@/modules/session-tables/session-table.schemas"
import {
  listTransfers,
  transferPlayer,
} from "@/modules/session-tables/participation.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SESSIONS_READ, {
      requestId,
      resource: "GET /api/sessions/:id/table-transfers",
    })
    return ok(await listTransfers(await parseSessionIdParam(params)), {
      requestId,
    })
  }
)

/**
 * POST — cambia al jugador de mesa. El servidor deriva jugador, sesión,
 * mesas y ciclos. Sin liquidación, sin conteo de fichas, sin cobro ni pago,
 * sin movimiento de inventario. Atómica e idempotente.
 */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
      requestId,
      resource: "POST /api/sessions/:id/table-transfers",
    })
    const sessionId = await parseSessionIdParam(params)
    const input = await parseJsonBody(req, transferSchema)
    const result = await transferPlayer(actor, sessionId, input, { requestId })
    return ok(result, {
      status: result.replayed ? 200 : 201,
      message: "La transferencia se realizó correctamente.",
      requestId,
    })
  }
)
