import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parseIdParam,
  regularizationReceiptSchema,
} from "@/modules/banking/banking.schemas"
import { recordRegularizationFunds } from "@/modules/banking/regularization.service"

export const dynamic = "force-dynamic"

/** POST — Módulo 17 (privado). Autorización en el servidor + Zod + idempotencia. */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.BANKING_OPERATE, {
      requestId,
      resource: "POST /api/admin/banking/regularizations/:id/receipts",
    })
    const id = await parseIdParam(params)
    const input = await parseJsonBody(req, regularizationReceiptSchema)
    const r = await recordRegularizationFunds(
      actor,
      id,
      { amount: input.amount, idempotencyKey: input.idempotencyKey },
      { requestId }
    )
    return ok(r, {
      status: r.replayed ? 200 : 201,
      message: "Devolución recibida y registrada",
      requestId,
    })
  }
)
