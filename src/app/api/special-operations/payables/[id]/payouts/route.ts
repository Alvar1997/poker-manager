import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parseIdParam,
  registerPayoutSchema,
} from "@/modules/special-operations/special.schemas"
import { getPayable } from "@/modules/special-operations/special-query.service"
import { registerSpecialPayout } from "@/modules/special-operations/special-payout.service"

export const dynamic = "force-dynamic"

/** POST — pago real de cualquier obligación especial (reembolso, corrección, devolución). */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SPECIAL_OPS_OPERATE, {
      requestId,
      resource: "POST /api/special-operations/payables/:id/payouts",
    })
    const id = await parseIdParam(params)
    const input = await parseJsonBody(req, registerPayoutSchema)
    const r = await registerSpecialPayout(actor, id, input, { requestId })
    return ok(await getPayable(id), {
      status: r.replayed ? 200 : 201,
      message:
        input.method === "CASH"
          ? "Pago en efectivo registrado"
          : "Transferencia en trámite: no cuenta como pagada hasta confirmarla",
      requestId,
    })
  }
)
