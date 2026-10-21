import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { can, PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseQueryParams } from "@/lib/validation"
import { receivablesQuerySchema } from "@/modules/credits/credit.schemas"
import { listReceivables } from "@/modules/credits/receivable.service"

export const dynamic = "force-dynamic"

/** GET — deudas (cuentas por cobrar) con saldo y estado DERIVADOS. */
export const GET = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.CREDITS_READ, {
    requestId,
    resource: "GET /api/credits",
  })
  return ok(
    await listReceivables(
      parseQueryParams(req.nextUrl.searchParams, receivablesQuerySchema),
      { showPhone: can(actor, PERMISSIONS.PLAYERS_READ) }
    ),
    { requestId }
  )
})
