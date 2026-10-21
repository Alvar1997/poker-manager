import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseQueryParams } from "@/lib/validation"
import {
  fifoPreviewSchema,
  parseIdParam,
} from "@/modules/credits/credit.schemas"
import { fifoPreview } from "@/modules/credits/receivable-payment.service"

export const dynamic = "force-dynamic"

/** GET — vista previa FIFO (informativa; el servidor recalcula al confirmar). */
export const GET = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.CREDITS_READ, {
      requestId,
      resource: "GET /api/credits/players/:id/fifo-preview",
    })
    return ok(
      await fifoPreview(
        await parseIdParam(params),
        parseQueryParams(req.nextUrl.searchParams, fifoPreviewSchema).amount
      ),
      { requestId }
    )
  }
)
