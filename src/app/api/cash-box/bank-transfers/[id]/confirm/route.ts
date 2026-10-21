import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parseCashIdParam,
  confirmBankTransferSchema,
} from "@/modules/cash/cash.schemas"
/** POST — confirmación MANUAL tras verificar el ingreso en el banco (los tres roles). Idempotente. */
import { confirmBankTransfer } from "@/modules/cash/bank-transfer.service"

export const dynamic = "force-dynamic"

export const POST = withApiHandler<{ id: string }>(
  async (req, { requestId, params }) => {
    const actor = await requirePermission(PERMISSIONS.CASH_OPERATE, {
      requestId,
      resource: "POST /api/cash-box/bank-transfers/:id/confirm",
    })
    const id = await parseCashIdParam(params)
    const input = await parseJsonBody(req, confirmBankTransferSchema)
    return ok(await confirmBankTransfer(actor, id, input, { requestId }), {
      status: 200,
      message: "Transferencia confirmada",
      requestId,
    })
  }
)
