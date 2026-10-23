import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { can, PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseIdParam } from "@/modules/admin/admin.schemas"
import { getAuditEvent } from "@/modules/audit/audit-query.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    const user = await requirePermission(PERMISSIONS.AUDIT_READ, {
      requestId,
      resource: "GET /api/admin/audit/:id",
    })
    const id = await parseIdParam(params, "id")
    return ok(
      await getAuditEvent(id, {
        canSecurity: can(user, PERMISSIONS.AUDIT_SECURITY_READ),
        canInfrastructure: can(user, PERMISSIONS.BACKUPS_READ),
        canBanking: can(user, PERMISSIONS.BANKING_READ),
      }),
      { requestId }
    )
  }
)
