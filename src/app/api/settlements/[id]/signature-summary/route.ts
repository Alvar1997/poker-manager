import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseSettlementIdParam } from "@/modules/settlements/settlement.schemas"
import {
  getSettlementSignatureStatus,
  prepareSettlementSignatureSummary,
} from "@/modules/settlements/settlement-signature.service"

export const dynamic = "force-dynamic"

/** GET — estado de la firma y último resumen firmado (solo lectura). */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SETTLEMENTS_READ, {
      requestId,
      resource: "GET /api/settlements/:id/signature-summary",
    })
    return ok(
      await getSettlementSignatureStatus(await parseSettlementIdParam(params)),
      { requestId }
    )
  }
)

/**
 * POST — PREPARA el resumen exacto que firmará el jugador (snapshot
 * inmutable). Los importes y la distribución FIFO los calcula el servidor.
 */
export const POST = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SETTLEMENTS_OPERATE, {
      requestId,
      resource: "POST /api/settlements/:id/signature-summary",
    })
    const id = await parseSettlementIdParam(params)
    return ok(
      await prepareSettlementSignatureSummary(actor, id, { requestId }),
      { message: "Revisa la liquidación antes de firmar.", requestId }
    )
  }
)
