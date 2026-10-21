import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parseSettlementIdParam,
  updateSettlementDraftSchema,
} from "@/modules/settlements/settlement.schemas"
import { updateSettlementDraft } from "@/modules/settlements/settlement.service"

export const dynamic = "force-dynamic"

/**
 * PATCH — cambia valor devuelto, decisión o importe a compensar ANTES de
 * recibir las fichas. Un cambio material invalida la firma (hay que firmar
 * de nuevo). Después de la recepción la liquidación no se edita.
 */
export const PATCH = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SETTLEMENTS_OPERATE, {
      requestId,
      resource: "PATCH /api/settlements/:id/draft",
    })
    const id = await parseSettlementIdParam(params)
    const input = await parseJsonBody(req, updateSettlementDraftSchema)
    return ok(await updateSettlementDraft(actor, id, input, { requestId }), {
      message:
        "Liquidación actualizada. Si cambió el resumen, el jugador debe firmar de nuevo.",
      requestId,
    })
  }
)
