import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { parseSessionIdParam } from "@/modules/sessions/session.schemas"
import { addSessionStaffSchema } from "@/modules/staff-tips/tips.schemas"
import {
  addStaffToSession,
  getSessionTips,
} from "@/modules/staff-tips/tips.service"

export const dynamic = "force-dynamic"

/** GET — staff de la sesión con sus propinas y el total (Módulo 18). */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.STAFF_READ, {
      requestId,
      resource: "GET /api/sessions/:id/staff",
    })
    const id = await parseSessionIdParam(params)
    return ok(await getSessionTips(id), { requestId })
  }
)

/** POST — agrega un empleado a la sesión (idempotente por empleado). */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.TIPS_OPERATE, {
      requestId,
      resource: "POST /api/sessions/:id/staff",
    })
    const id = await parseSessionIdParam(params)
    const input = await parseJsonBody(req, addSessionStaffSchema)
    const r = await addStaffToSession(actor, id, input.staffMemberId, {
      requestId,
    })
    return ok(r, {
      status: r.replayed ? 200 : 201,
      message: "Empleado agregado a la sesión",
      requestId,
    })
  }
)
