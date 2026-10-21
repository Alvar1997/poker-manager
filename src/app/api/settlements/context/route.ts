import { z } from "zod"

import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseQueryParams } from "@/lib/validation"
import { idSchema } from "@/modules/settlements/settlement.schemas"
import { getSettlementContext } from "@/modules/settlements/settlement.service"

export const dynamic = "force-dynamic"

/** GET — jugador, mesa, sesión y deudas vigentes (Módulo 10) para liquidar. */
export const GET = withApiHandler(async (req, { requestId }) => {
  await requirePermission(PERMISSIONS.SETTLEMENTS_READ, {
    requestId,
    resource: "GET /api/settlements/context",
  })
  const { participationId } = parseQueryParams(
    req.nextUrl.searchParams,
    z.object({ participationId: idSchema })
  )
  return ok(await getSettlementContext(participationId), { requestId })
})
