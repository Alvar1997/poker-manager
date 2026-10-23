import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody, parseQueryParams } from "@/lib/validation"
import {
  createSessionSchema,
  sessionsQuerySchema,
} from "@/modules/sessions/session.schemas"
import { createSession, listSessions } from "@/modules/sessions/session.service"

export const dynamic = "force-dynamic"

/** GET /api/sessions — historial paginado (folio, estado, fechas). */
export const GET = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.SESSIONS_READ, {
    requestId,
    resource: "GET /api/sessions",
  })
  const query = parseQueryParams(req.nextUrl.searchParams, sessionsQuerySchema)
  return ok(await listSessions(query, actor), { requestId })
})

/**
 * POST /api/sessions — crea una sesión en DRAFT. El servidor asigna folio
 * (S-0001-YYYYMMDD), consecutivo, fecha operativa, creador y fechas reales.
 * Una sola sesión vigente: 409. Con `historical: true` + `businessDate`
 * registra una sesión HISTÓRICA de una fecha anterior: SOLO SUPERADMIN
 * (`sessions:historical-create`, validado en el servicio; el rechazo se
 * audita) y sin caja, inventario ni operación en vivo.
 */
export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
    requestId,
    resource: "POST /api/sessions",
  })
  const input = await parseJsonBody(req, createSessionSchema)
  const session = await createSession(actor, input, { requestId })
  return ok(session, {
    status: session.replayed ? 200 : 201,
    message: "Sesión creada",
    requestId,
  })
})
