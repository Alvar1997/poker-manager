import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody, parseQueryParams } from "@/lib/validation"
import {
  createIncidentSchema,
  incidentsQuerySchema,
} from "@/modules/admin/admin.schemas"
import {
  createManualIncident,
  listIncidents,
} from "@/modules/incidents/incident.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler(async (req, { requestId }) => {
  await requirePermission(PERMISSIONS.AUDIT_READ, {
    requestId,
    resource: "GET /api/admin/incidents",
  })
  return ok(
    await listIncidents(
      parseQueryParams(req.nextUrl.searchParams, incidentsQuerySchema)
    ),
    { requestId }
  )
})

export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.INCIDENTS_MANAGE, {
    requestId,
    resource: "POST /api/admin/incidents",
  })
  const input = await parseJsonBody(req, createIncidentSchema)
  return ok(await createManualIncident(actor, input, { requestId }), {
    requestId,
    status: 201,
    message: "Incidencia registrada",
  })
})
