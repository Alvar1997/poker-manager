import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseJsonBody } from "@/lib/validation"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { updateBusinessSettingsSchema } from "@/modules/settings/settings.schemas"
import {
  getBusinessSettings,
  updateBusinessSettings,
} from "@/modules/settings/settings.service"

export const dynamic = "force-dynamic"

/** GET /api/settings/general — parámetros generales (los tres roles: los necesita para operar). */
export const GET = withApiHandler(async (_req, { requestId }) => {
  await requirePermission(PERMISSIONS.CATALOGS_READ, {
    requestId,
    resource: "GET /api/settings/general",
  })
  return ok(await getBusinessSettings(), { requestId })
})

/** PATCH /api/settings/general — solo SUPERADMIN. Moneda y zona horaria son fijas. */
export const PATCH = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.SETTINGS_MANAGE, {
    requestId,
    resource: "PATCH /api/settings/general",
  })
  const input = await parseJsonBody(req, updateBusinessSettingsSchema)
  return ok(await updateBusinessSettings(actor, input, { requestId }), {
    message: "Configuración actualizada",
    requestId,
  })
})
