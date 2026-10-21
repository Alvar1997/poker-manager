import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { listUnsettledCardPayments } from "@/modules/cash/card-settlement.service"

export const dynamic = "force-dynamic"

/** GET — cobros con terminal aprobados aún no depositados por el adquirente. */
export const GET = withApiHandler(async (_req, { requestId }) => {
  await requirePermission(PERMISSIONS.CASH_READ, {
    requestId,
    resource: "GET /api/cash-box/card-payments",
  })
  return ok(await listUnsettledCardPayments(), { requestId })
})
