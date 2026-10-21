import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { inventoryCountActionSchema } from "@/modules/closure/closure.schemas"
import {
  confirmClosingChipCount,
  startClosingChipCount,
} from "@/modules/closure/closure.service"
import { parseSessionIdParam } from "@/modules/sessions/session.schemas"

export const dynamic = "force-dynamic"

/**
 * POST — arqueo físico GLOBAL de fichas del cierre (uno para ambas mesas).
 * `start`: inicia o retoma (si el anterior tuvo diferencia, es un recuento).
 * `confirm`: confirma el conteo por denominación y registra la diferencia
 * física, si la hay. La captura usa PATCH /api/chip-inventory/counts/:id.
 */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
      requestId,
      resource: "POST /api/sessions/:id/closure/inventory-count",
    })
    const id = await parseSessionIdParam(params)
    const input = await parseJsonBody(req, inventoryCountActionSchema)
    if (input.action === "start") {
      const result = await startClosingChipCount(actor, id, { requestId })
      return ok(result.count, {
        status: result.resumed ? 200 : 201,
        message: "Arqueo de cierre",
        requestId,
      })
    }
    return ok(await confirmClosingChipCount(actor, id, input, { requestId }), {
      message: "Arqueo de cierre confirmado",
      requestId,
    })
  }
)
