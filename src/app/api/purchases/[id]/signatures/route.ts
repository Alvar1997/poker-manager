import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { parsePurchaseIdParam } from "@/modules/purchases/purchase.schemas"
import { captureSignatureSchema } from "@/modules/signatures/signature.schemas"
import {
  captureSignature,
  getSignatureStatus,
} from "@/modules/signatures/signature.service"

export const dynamic = "force-dynamic"

/**
 * POST — registra la firma del jugador (trazos) para el resumen preparado.
 * NO confirma la entrega: no mueve fichas, dinero ni crea deuda.
 */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SIGNATURES_CAPTURE, {
      requestId,
      resource: "POST /api/purchases/:id/signatures",
    })
    const id = await parsePurchaseIdParam(params)
    const input = await parseJsonBody(req, captureSignatureSchema)
    const result = await captureSignature(actor, id, input, { requestId })
    return ok(await getSignatureStatus(id), {
      status: result.replayed ? 200 : 201,
      message: "Firma registrada. El cajero debe confirmar la entrega.",
      requestId,
    })
  }
)
