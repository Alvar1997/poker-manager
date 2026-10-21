import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseIdParam } from "@/modules/admin/admin.schemas"
import { getBackup } from "@/modules/backups/backup.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.BACKUPS_READ, {
      requestId,
      resource: "GET /api/admin/backups/:id",
    })
    return ok(await getBackup(await parseIdParam(params, "id")), { requestId })
  }
)
