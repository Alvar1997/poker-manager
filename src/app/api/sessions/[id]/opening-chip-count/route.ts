import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseSessionIdParam } from "@/modules/sessions/session.schemas"
import {
  createOpeningChipCount,
  getOpeningInventoryStatus,
} from "@/modules/sessions/opening.service"

export const dynamic = "force-dynamic"

/** GET — arqueo de apertura de la sesión (o null). */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SESSIONS_READ, {
      requestId,
      resource: "GET /api/sessions/:id/opening-chip-count",
    })
    return ok(
      await getOpeningInventoryStatus(await parseSessionIdParam(params)),
      { requestId }
    )
  }
)

/**
 * POST — inicia o retoma el arqueo OPENING del inventario COMPARTIDO (uno
 * para ambas mesas). Captura, confirmación y conciliación se hacen con
 * /api/chip-inventory/counts/:id/*, que aplican la regla del creador.
 */
export const POST = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
      requestId,
      resource: "POST /api/sessions/:id/opening-chip-count",
    })
    const result = await createOpeningChipCount(
      actor,
      await parseSessionIdParam(params),
      { requestId }
    )
    return ok(result.count, {
      status: result.resumed ? 200 : 201,
      message: "Arqueo de apertura",
      requestId,
    })
  }
)
