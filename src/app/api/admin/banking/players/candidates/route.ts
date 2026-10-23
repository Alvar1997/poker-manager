import { z } from "zod"

import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseQueryParams } from "@/lib/validation"
import { bankablePlayers } from "@/modules/banking/banking-query.service"

export const dynamic = "force-dynamic"

const querySchema = z.strictObject({ q: z.string().trim().max(80).optional() })

/** GET — jugadores activos SIN acuerdo vigente (para crear uno). */
export const GET = withApiHandler(async (req, { requestId }) => {
  await requirePermission(PERMISSIONS.BANKING_APPROVE, {
    requestId,
    resource: "GET /api/admin/banking/players/candidates",
  })
  const { q } = parseQueryParams(req.nextUrl.searchParams, querySchema)
  return ok(await bankablePlayers(q ?? ""), { requestId })
})
