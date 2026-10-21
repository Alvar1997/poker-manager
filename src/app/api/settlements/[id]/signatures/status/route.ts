import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseSettlementIdParam } from "@/modules/settlements/settlement.schemas"
import { getSettlementSignatureStatus } from "@/modules/settlements/settlement-signature.service"

export const dynamic = "force-dynamic"

/** GET — firma requerida (siempre), vigente o no, e historial (sin imágenes). */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SETTLEMENTS_READ, {
      requestId,
      resource: "GET /api/settlements/:id/signatures/status",
    })
    return ok(
      await getSettlementSignatureStatus(await parseSettlementIdParam(params)),
      { requestId }
    )
  }
)
