import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { confirmBankTransfer } from "@/modules/cash/bank-transfer.service"
import { confirmBankTransferSchema } from "@/modules/cash/cash.schemas"
import { BusinessRuleError } from "@/lib/errors"
import { parseIdParam } from "@/modules/credits/credit.schemas"
import { getPayment } from "@/modules/credits/receivable-payment.service"

export const dynamic = "force-dynamic"

/**
 * POST — verifica la transferencia de un abono. NO es un segundo flujo:
 * delega en la verificación manual del Módulo 05 (mismo servicio, mismo
 * asiento único), que aplica por FIFO y deja el excedente sin aplicar.
 */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.CASH_OPERATE, {
      requestId,
      resource: "POST /api/credits/payments/:id/confirm",
    })
    const id = await parseIdParam(params)
    const input = await parseJsonBody(req, confirmBankTransferSchema)
    const payment = await getPayment(id)
    if (!payment.bankTransfer)
      throw new BusinessRuleError(
        "Solo las transferencias se confirman después; este abono ya está resuelto."
      )
    await confirmBankTransfer(actor, payment.bankTransfer.id, input, {
      requestId,
    })
    return ok(await getPayment(id), {
      message: "Transferencia verificada y aplicada",
      requestId,
    })
  }
)
