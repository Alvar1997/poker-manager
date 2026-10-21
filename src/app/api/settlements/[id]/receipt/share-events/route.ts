import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parseSettlementIdParam,
  settlementReceiptShareSchema,
} from "@/modules/settlements/settlement.schemas"
import { recordSettlementReceiptEvent } from "@/modules/settlements/settlement-receipt.service"

export const dynamic = "force-dynamic"

/** POST — registra que se SOLICITÓ compartir manualmente (no envía nada). */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SETTLEMENTS_READ, {
      requestId,
      resource: "POST /api/settlements/:id/receipt/share-events",
    })
    const id = await parseSettlementIdParam(params)
    const { receiptId, channel } = await parseJsonBody(
      req,
      settlementReceiptShareSchema
    )
    await recordSettlementReceiptEvent(
      actor,
      id,
      receiptId ?? null,
      "SHARE_REQUESTED",
      { channel },
      { requestId }
    )
    return ok({ recorded: true }, { requestId })
  }
)
