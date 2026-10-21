import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parseSessionIdParam,
  openingCashSchema,
} from "@/modules/sessions/session.schemas"
/** Conteo físico de la caja inicial (esperado $0). No crea movimientos de dinero. */
import { confirmOpeningCashCount } from "@/modules/sessions/opening.service"

export const dynamic = "force-dynamic"

export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
      requestId,
      resource: "POST /api/sessions/:id/opening-cash",
    })
    const id = await parseSessionIdParam(params)
    const input = await parseJsonBody(req, openingCashSchema)
    return ok(await confirmOpeningCashCount(actor, id, input, { requestId }), {
      message: "Caja inicial registrada",
      requestId,
    })
  }
)
