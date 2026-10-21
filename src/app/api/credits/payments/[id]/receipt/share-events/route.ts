import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parseIdParam,
  receiptShareSchema,
} from "@/modules/credits/credit.schemas"
import { recordCreditReceiptEvent } from "@/modules/credits/credit-receipt.service"

export const dynamic = "force-dynamic"

/** POST — registra que se SOLICITÓ compartir manualmente (no envía nada). */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.CREDITS_READ, {
      requestId,
      resource: "POST /api/credits/payments/:id/receipt/share-events",
    })
    const id = await parseIdParam(params)
    const input = await parseJsonBody(req, receiptShareSchema)
    await recordCreditReceiptEvent(actor, id, "SHARE_REQUESTED", input, {
      requestId,
    })
    return ok({ recorded: true }, { requestId })
  }
)
