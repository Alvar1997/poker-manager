import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { getWhatsAppStatus } from "@/modules/settings/settings.service"

export const dynamic = "force-dynamic"

/**
 * GET /api/settings/whatsapp — estado de la integración (PENDIENTE).
 * Solo lectura: no conecta con Meta, no verifica números, no envía mensajes.
 */
export const GET = withApiHandler(async (_req, { requestId }) => {
  await requirePermission(PERMISSIONS.SETTINGS_READ, {
    requestId,
    resource: "GET /api/settings/whatsapp",
  })
  return ok(await getWhatsAppStatus(), { requestId })
})
