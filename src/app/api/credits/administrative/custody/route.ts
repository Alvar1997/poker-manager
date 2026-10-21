import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import {
  getCustodySummary,
  listCustodyDeposits,
} from "@/modules/credits/custody.service"

export const dynamic = "force-dynamic"

/** GET — efectivo administrativo en custodia por custodio (no es una caja de juego). */
export const GET = withApiHandler(async (_req, { requestId }) => {
  await requirePermission(PERMISSIONS.CREDITS_READ, {
    requestId,
    resource: "GET /api/credits/administrative/custody",
  })
  return ok(
    { ...(await getCustodySummary()), deposits: await listCustodyDeposits() },
    { requestId }
  )
})
