import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { can, PERMISSIONS, requirePermission } from "@/config/permissions"
import { ValidationError } from "@/lib/errors"
import { parseAuditFilters } from "@/modules/audit/audit.filters"
import { listAuditEvents } from "@/modules/audit/audit-query.service"

export const dynamic = "force-dynamic"

/** GET — auditoría transversal (solo lectura; sin edición ni borrado). */
export const GET = withApiHandler(async (req, { requestId }) => {
  const user = await requirePermission(PERMISSIONS.AUDIT_READ, {
    requestId,
    resource: "GET /api/admin/audit",
  })
  const r = parseAuditFilters(Object.fromEntries(req.nextUrl.searchParams))
  if (!r.ok) throw new ValidationError("Filtros inválidos", r.issues)
  return ok(
    await listAuditEvents(r.filters, {
      canSecurity: can(user, PERMISSIONS.AUDIT_SECURITY_READ),
      canInfrastructure: can(user, PERMISSIONS.BACKUPS_READ),
      canBanking: can(user, PERMISSIONS.BANKING_READ),
    }),
    { requestId }
  )
})
