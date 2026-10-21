import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parseCashIdParam,
  rejectBankTransferSchema,
} from "@/modules/cash/cash.schemas"
/** POST — rechazo con motivo: no genera entrada financiera. */
import { rejectBankTransfer } from "@/modules/cash/bank-transfer.service"

export const dynamic = "force-dynamic"

export const POST = withApiHandler<{ id: string }>(
  async (req, { requestId, params }) => {
    const actor = await requirePermission(PERMISSIONS.CASH_OPERATE, {
      requestId,
      resource: "POST /api/cash-box/bank-transfers/:id/reject",
    })
    const id = await parseCashIdParam(params)
    const input = await parseJsonBody(req, rejectBankTransferSchema)
    return ok(await rejectBankTransfer(actor, id, input, { requestId }), {
      status: 200,
      message: "Transferencia rechazada",
      requestId,
    })
  }
)
