import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody, parseQueryParams } from "@/lib/validation"
import {
  createDealerSchema,
  dealersQuerySchema,
} from "@/modules/table-floor/table-floor.schemas"
import { createDealer, listDealers } from "@/modules/table-floor/dealer.service"

export const dynamic = "force-dynamic"

/** GET — dealers registrados (personas, sin cuenta de acceso). */
export const GET = withApiHandler(async (req, { requestId }) => {
  await requirePermission(PERMISSIONS.SESSIONS_READ, {
    requestId,
    resource: "GET /api/dealers",
  })
  const { status } = parseQueryParams(
    new URL(req.url).searchParams,
    dealersQuerySchema
  )
  return ok(await listDealers(status), { requestId })
})

/** POST — registra un dealer (no crea usuario ni rol). */
export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
    requestId,
    resource: "POST /api/dealers",
  })
  const input = await parseJsonBody(req, createDealerSchema)
  return ok(await createDealer(actor, input, { requestId }), {
    status: 201,
    message: "Dealer registrado",
    requestId,
  })
})
