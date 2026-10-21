import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  executeSettlementCorrection,
  getSettlementCorrection,
} from "@/modules/special-operations/settlement-correction.service"
import {
  executeSettlementCorrectionSchema,
  parseIdParam,
} from "@/modules/special-operations/special.schemas"

export const dynamic = "force-dynamic"

/** POST — ejecuta la corrección APROBADA con la firma del jugador. */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SPECIAL_OPS_OPERATE, {
      requestId,
      resource:
        "POST /api/special-operations/settlement-corrections/:settlementId/execute",
    })
    const id = await parseIdParam(params)
    const input = await parseJsonBody(req, executeSettlementCorrectionSchema)
    const r = await executeSettlementCorrection(actor, id, input, { requestId })
    return ok(await getSettlementCorrection(r.correctionRecordId), {
      status: r.replayed ? 200 : 201,
      message: "Corrección ejecutada: el nuevo importe queda pendiente de pago",
      requestId,
    })
  }
)
