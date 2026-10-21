import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parsePurchaseIdParam } from "@/modules/purchases/purchase.schemas"
import {
  getSignatureStatus,
  prepareSignatureSummary,
} from "@/modules/signatures/signature.service"

export const dynamic = "force-dynamic"

/** GET — estado de firma y último resumen firmado (solo lectura). */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SIGNATURES_READ, {
      requestId,
      resource: "GET /api/purchases/:id/signature-summary",
    })
    return ok(await getSignatureStatus(await parsePurchaseIdParam(params)), {
      requestId,
    })
  }
)

/**
 * POST — PREPARA el reconocimiento de crédito exacto que verá el jugador
 * (snapshot inmutable con huella). Idempotente: si nada cambió, devuelve el
 * mismo. Los importes los calcula el servidor; el cliente no envía nada.
 */
export const POST = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SIGNATURES_CAPTURE, {
      requestId,
      resource: "POST /api/purchases/:id/signature-summary",
    })
    const id = await parsePurchaseIdParam(params)
    return ok(await prepareSignatureSummary(actor, id, { requestId }), {
      message: "Revisa el importe antes de firmar.",
      requestId,
    })
  }
)
