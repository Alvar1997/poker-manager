import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody, parseQueryParams } from "@/lib/validation"
import {
  createSettlementSchema,
  settlementsQuerySchema,
} from "@/modules/settlements/settlement.schemas"
import {
  createSettlement,
  getSettlement,
  listSettlements,
} from "@/modules/settlements/settlement.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler(async (req, { requestId }) => {
  await requirePermission(PERMISSIONS.SETTLEMENTS_READ, {
    requestId,
    resource: "GET /api/settlements",
  })
  return ok(
    await listSettlements(
      parseQueryParams(req.nextUrl.searchParams, settlementsQuerySchema)
    ),
    { requestId }
  )
})

/**
 * POST — inicia la liquidación (DRAFT) de una participación ACTIVE. El
 * cliente solo envía la participación, el valor NOMINAL devuelto (puede ser
 * $0) y la decisión explícita de compensar; el servidor deriva jugador,
 * sesión, mesa, ciclo, folio y responsables. Sin efectos financieros.
 */
export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.SETTLEMENTS_OPERATE, {
    requestId,
    resource: "POST /api/settlements",
  })
  const input = await parseJsonBody(req, createSettlementSchema)
  const result = await createSettlement(actor, input, { requestId })
  return ok(await getSettlement(result.settlementId), {
    status: result.replayed ? 200 : 201,
    message: "Liquidación preparada. El jugador debe firmar el resumen.",
    requestId,
  })
})
