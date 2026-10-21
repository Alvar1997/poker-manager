import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  captureSettlementSignatureSchema,
  parseSettlementIdParam,
} from "@/modules/settlements/settlement.schemas"
import {
  captureSettlementSignature,
  getSettlementSignatureStatus,
} from "@/modules/settlements/settlement-signature.service"

export const dynamic = "force-dynamic"

/**
 * POST — firma del jugador (trazos) para el resumen preparado. NO recibe
 * fichas, no compensa deuda ni mueve dinero: el cajero confirma después.
 */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SETTLEMENTS_OPERATE, {
      requestId,
      resource: "POST /api/settlements/:id/signatures",
    })
    const id = await parseSettlementIdParam(params)
    const input = await parseJsonBody(req, captureSettlementSignatureSchema)
    const result = await captureSettlementSignature(actor, id, input, {
      requestId,
    })
    return ok(await getSettlementSignatureStatus(id), {
      status: result.replayed ? 200 : 201,
      message:
        "Firma registrada. El cajero debe confirmar la recepción de las fichas.",
      requestId,
    })
  }
)
