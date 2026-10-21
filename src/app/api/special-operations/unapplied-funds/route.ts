import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { listUnappliedFunds } from "@/modules/special-operations/unapplied-funds.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler(async (_req, { requestId }) => {
  await requirePermission(PERMISSIONS.SPECIAL_OPS_READ, {
    requestId,
    resource: "GET /api/special-operations/unapplied-funds",
  })
  return ok(await listUnappliedFunds(), { requestId })
})
