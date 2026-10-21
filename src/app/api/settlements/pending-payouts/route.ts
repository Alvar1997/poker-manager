import { z } from "zod"

import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseQueryParams } from "@/lib/validation"
import { idSchema } from "@/modules/settlements/settlement.schemas"
import { listPendingPayables } from "@/modules/settlements/settlement-payout.service"

export const dynamic = "force-dynamic"

/** GET — obligaciones por pagar a jugadores (sobreviven al cierre de mesa y sesión). */
export const GET = withApiHandler(async (req, { requestId }) => {
  await requirePermission(PERMISSIONS.SETTLEMENTS_READ, {
    requestId,
    resource: "GET /api/settlements/pending-payouts",
  })
  const filters = parseQueryParams(
    req.nextUrl.searchParams,
    z.object({ sessionId: idSchema.optional(), playerId: idSchema.optional() })
  )
  return ok(await listPendingPayables(filters), { requestId })
})
