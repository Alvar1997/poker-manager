import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { listIntegrityRuns } from "@/modules/integrity/integrity.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler(async (_req, { requestId }) => {
  await requirePermission(PERMISSIONS.AUDIT_READ, {
    requestId,
    resource: "GET /api/admin/integrity",
  })
  return ok(await listIntegrityRuns(), { requestId })
})
