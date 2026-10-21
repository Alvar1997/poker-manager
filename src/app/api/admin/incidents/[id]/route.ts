import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { can, PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parseIdParam,
  updateIncidentSchema,
} from "@/modules/admin/admin.schemas"
import {
  getIncident,
  updateIncident,
} from "@/modules/incidents/incident.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.AUDIT_READ, {
      requestId,
      resource: "GET /api/admin/incidents/:id",
    })
    return ok(await getIncident(await parseIdParam(params, "id")), {
      requestId,
    })
  }
)

/** PATCH — estado, responsable, observaciones y evidencias (nunca borra). */
export const PATCH = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.INCIDENTS_MANAGE, {
      requestId,
      resource: "PATCH /api/admin/incidents/:id",
    })
    const id = await parseIdParam(params, "id")
    const input = await parseJsonBody(req, updateIncidentSchema)
    return ok(
      await updateIncident(
        actor,
        id,
        input,
        { canResolve: can(actor, PERMISSIONS.INCIDENTS_RESOLVE) },
        { requestId }
      ),
      { requestId, message: "Incidencia actualizada" }
    )
  }
)
