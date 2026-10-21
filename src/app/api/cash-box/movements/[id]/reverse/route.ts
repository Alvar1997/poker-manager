import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { parseCashIdParam, reverseSchema } from "@/modules/cash/cash.schemas"
/** POST — contraasiento con motivo; el original se conserva; un solo reverso. Si toca efectivo, requiere su sesión ABIERTA. */
import { reverseTransaction } from "@/modules/cash/cash.service"

export const dynamic = "force-dynamic"

export const POST = withApiHandler<{ id: string }>(
  async (req, { requestId, params }) => {
    const actor = await requirePermission(PERMISSIONS.CASH_OPERATE, {
      requestId,
      resource: "POST /api/cash-box/movements/:id/reverse",
    })
    const id = await parseCashIdParam(params)
    const input = await parseJsonBody(req, reverseSchema)
    return ok(await reverseTransaction(actor, id, input, { requestId }), {
      status: 201,
      message: "Movimiento revertido",
      requestId,
    })
  }
)
