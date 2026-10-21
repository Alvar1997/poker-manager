import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody, parseQueryParams } from "@/lib/validation"
import {
  correctionsQuerySchema,
  createCorrectionSchema,
} from "@/modules/corrections/correction.schemas"
import {
  createCorrection,
  listCorrections,
} from "@/modules/corrections/correction.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler(async (req, { requestId }) => {
  await requirePermission(PERMISSIONS.CORRECTIONS_REQUEST, {
    requestId,
    resource: "GET /api/admin/corrections",
  })
  const q = parseQueryParams(req.nextUrl.searchParams, correctionsQuerySchema)
  return ok(await listCorrections(q), { requestId })
})

/** POST — solicitar una corrección excepcional (los tres roles). No mueve dinero. */
export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.CORRECTIONS_REQUEST, {
    requestId,
    resource: "POST /api/admin/corrections",
  })
  const input = await parseJsonBody(req, createCorrectionSchema)
  const r = await createCorrection(actor, input, { requestId })
  return ok(r, {
    requestId,
    status: r.replayed ? 200 : 201,
    message: "Solicitud registrada",
  })
})
