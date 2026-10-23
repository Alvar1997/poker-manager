import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parseIdParam,
  prepareClosingSchema,
} from "@/modules/banking/banking.schemas"
import { prepareClosing } from "@/modules/banking/closing.service"

export const dynamic = "force-dynamic"

/** POST — Módulo 17 (privado). Autorización en el servidor + Zod + idempotencia. */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.BANKING_OPERATE, {
      requestId,
      resource: "POST /api/admin/banking/cycles/:id/prepare-closing",
    })
    const id = await parseIdParam(params)
    const input = await parseJsonBody(req, prepareClosingSchema)
    const r = await prepareClosing(actor, id, input, { requestId })
    return ok(r, {
      status: r.replayed ? 200 : 201,
      message: "Corte preparado: requiere aprobación digital de un socio",
      requestId,
    })
  }
)
