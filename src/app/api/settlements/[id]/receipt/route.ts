import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseSettlementIdParam } from "@/modules/settlements/settlement.schemas"
import { getSettlementReceipts } from "@/modules/settlements/settlement-receipt.service"

export const dynamic = "force-dynamic"

/** GET — comprobante de recepción y anexos de pago (snapshots inmutables). Sin PDF. */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SETTLEMENTS_READ, {
      requestId,
      resource: "GET /api/settlements/:id/receipt",
    })
    return ok(
      await getSettlementReceipts(await parseSettlementIdParam(params)),
      {
        requestId,
      }
    )
  }
)
