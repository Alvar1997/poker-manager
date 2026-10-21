import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseIdParam } from "@/modules/admin/admin.schemas"
import { getIntegrityRun } from "@/modules/integrity/integrity.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.AUDIT_READ, {
      requestId,
      resource: "GET /api/admin/integrity/runs/:id",
    })
    return ok(await getIntegrityRun(await parseIdParam(params, "id")), {
      requestId,
    })
  }
)
