import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { listFolioSequences } from "@/modules/settings/folio.service"

export const dynamic = "force-dynamic"

/** GET /api/settings/folios — formatos y consecutivos (sin emitir folios). */
export const GET = withApiHandler(async (_req, { requestId }) => {
  await requirePermission(PERMISSIONS.SETTINGS_READ, {
    requestId,
    resource: "GET /api/settings/folios",
  })
  return ok(await listFolioSequences(), { requestId })
})
