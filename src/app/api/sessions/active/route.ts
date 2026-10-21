import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { getActiveSession } from "@/modules/sessions/session.service"

export const dynamic = "force-dynamic"

/** GET /api/sessions/active — la sesión vigente (DRAFT/PREPARATION/OPEN/CLOSING) o null. */
export const GET = withApiHandler(async (_req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.SESSIONS_READ, {
    requestId,
    resource: "GET /api/sessions/active",
  })
  return ok(await getActiveSession(actor), { requestId })
})
