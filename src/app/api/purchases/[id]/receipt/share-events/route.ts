import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { parsePurchaseIdParam } from "@/modules/purchases/purchase.schemas"
import { recordReceiptEvent } from "@/modules/signatures/receipt.service"
import { receiptShareSchema } from "@/modules/signatures/signature.schemas"

export const dynamic = "force-dynamic"

/**
 * POST — registra que el usuario SOLICITÓ compartir manualmente (menú del
 * dispositivo o copia del texto). No envía nada ni afirma que se envió.
 */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.PURCHASES_READ, {
      requestId,
      resource: "POST /api/purchases/:id/receipt/share-events",
    })
    const id = await parsePurchaseIdParam(params)
    const input = await parseJsonBody(req, receiptShareSchema)
    await recordReceiptEvent(actor, id, "SHARE_REQUESTED", input, { requestId })
    return ok({ recorded: true }, { requestId })
  }
)
