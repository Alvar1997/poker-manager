import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { businessDateOf } from "@/lib/format"
import { ValidationError } from "@/lib/errors"
import { parseQueryParams } from "@/lib/validation"
import { folioPreviewQuerySchema } from "@/modules/sessions/session.schemas"
import { isCalendarDate } from "@/modules/sessions/session-folio"
import { previewSessionFolio } from "@/modules/settings/folio.service"

export const dynamic = "force-dynamic"

/**
 * GET — folio PROVISIONAL de la siguiente sesión (S-000X-YYYYMMDD) para la
 * fecha operativa indicada (o la de hoy). No reserva el consecutivo: el
 * definitivo lo asigna el servidor al crear la sesión.
 */
export const GET = withApiHandler(async (req, { requestId }) => {
  await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
    requestId,
    resource: "GET /api/sessions/folio-preview",
  })
  const { businessDate } = parseQueryParams(
    new URL(req.url).searchParams,
    folioPreviewQuerySchema
  )
  const date = businessDate ?? businessDateOf(new Date())
  if (!isCalendarDate(date)) throw new ValidationError("Fecha inválida")
  return ok(await previewSessionFolio(date), { requestId })
})
