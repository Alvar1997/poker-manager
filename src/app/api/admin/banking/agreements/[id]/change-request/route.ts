import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parseIdParam,
  changeRequestSchema,
} from "@/modules/banking/banking.schemas"
import { requestPercentageChange } from "@/modules/banking/agreement.service"

export const dynamic = "force-dynamic"

/** POST — Módulo 17 (privado). Autorización en el servidor + Zod + idempotencia. */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.BANKING_OPERATE, {
      requestId,
      resource: "POST /api/admin/banking/agreements/:id/change-request",
    })
    const id = await parseIdParam(params)
    const input = await parseJsonBody(req, changeRequestSchema)
    const r = await requestPercentageChange(actor, id, input, { requestId })
    return ok(r, {
      status: 200,
      message:
        "Cambio de porcentaje solicitado: requiere aprobación digital de un socio",
      requestId,
    })
  }
)
