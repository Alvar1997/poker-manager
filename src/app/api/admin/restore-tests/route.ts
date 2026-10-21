import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { listRestoreValidations } from "@/modules/backups/restore.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler(async (_req, { requestId }) => {
  await requirePermission(PERMISSIONS.BACKUPS_READ, {
    requestId,
    resource: "GET /api/admin/restore-tests",
  })
  return ok(await listRestoreValidations(), { requestId })
})
