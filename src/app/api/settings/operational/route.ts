import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { getOperationalSettings } from "@/modules/settings/settings.service"

export const dynamic = "force-dynamic"

/** GET /api/settings/operational — políticas y reglas operativas (solo lectura). */
export const GET = withApiHandler(async (_req, { requestId }) => {
  await requirePermission(PERMISSIONS.CATALOGS_READ, {
    requestId,
    resource: "GET /api/settings/operational",
  })
  return ok(await getOperationalSettings(), { requestId })
})
