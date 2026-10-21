import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { previewSettlementCorrection } from "@/modules/special-operations/settlement-correction.service"
import {
  parseIdParam,
  settlementCorrectionPreviewSchema,
} from "@/modules/special-operations/special.schemas"

export const dynamic = "force-dynamic"

/** POST — (id = liquidación) resumen que firmará el jugador; sin escrituras. */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SPECIAL_OPS_READ, {
      requestId,
      resource:
        "POST /api/special-operations/settlement-corrections/:settlementId/preview",
    })
    const id = await parseIdParam(params)
    void actor
    const input = await parseJsonBody(req, settlementCorrectionPreviewSchema)
    return ok(await previewSettlementCorrection(id, input), { requestId })
  }
)
