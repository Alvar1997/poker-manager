import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { getSystemHealth } from "@/modules/admin/system-health.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler(async (_req, { requestId }) => {
  await requirePermission(PERMISSIONS.SYSTEM_HEALTH_READ, {
    requestId,
    resource: "GET /api/admin/system/health",
  })
  return ok(await getSystemHealth(), { requestId })
})
