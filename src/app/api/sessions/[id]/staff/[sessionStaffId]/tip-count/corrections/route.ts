import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { ValidationError } from "@/lib/errors"

async function ids(params: Promise<{ id: string; sessionStaffId: string }>) {
  const { id, sessionStaffId } = await params
  const re = /^[A-Za-z0-9_-]{1,64}$/
  if (!re.test(id) || !re.test(sessionStaffId))
    throw new ValidationError("Identificador inválido")
  return { sessionId: id, sessionStaffId }
}
import { parseJsonBody } from "@/lib/validation"
import { correctTipCountSchema } from "@/modules/staff-tips/tips.schemas"
import { correctTipCount } from "@/modules/staff-tips/tips.service"

export const dynamic = "force-dynamic"

/** POST — Módulo 18. Autorización → Zod → servicio. */
export const POST = withApiHandler<{ id: string; sessionStaffId: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.TIPS_OPERATE, {
      requestId,
      resource:
        "POST /api/sessions/:id/staff/:sessionStaffId/tip-count/corrections",
    })
    const { sessionId, sessionStaffId } = await ids(params)
    const input = await parseJsonBody(req, correctTipCountSchema)
    const r = await correctTipCount(actor, sessionId, sessionStaffId, input, {
      requestId,
    })
    return ok(r, {
      status: r.replayed ? 200 : 201,
      message: "Corrección registrada",
      requestId,
    })
  }
)
