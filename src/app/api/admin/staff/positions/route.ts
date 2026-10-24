import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { createPositionSchema } from "@/modules/staff-tips/tips.schemas"
import {
  createPosition,
  listPositions,
} from "@/modules/staff-tips/staff.service"

export const dynamic = "force-dynamic"

/** GET — Módulo 18.  */
export const GET = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.STAFF_READ, {
    requestId,
    resource: "GET /api/admin/staff/positions",
  })
  void actor
  void req
  const r = await listPositions()
  return ok(r, { status: 200, requestId })
})

/** POST — Módulo 18.  */
export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.STAFF_MANAGE, {
    requestId,
    resource: "POST /api/admin/staff/positions",
  })
  const input = await parseJsonBody(req, createPositionSchema)
  const r = await createPosition(actor, input, { requestId })
  return ok(r, { status: 201, requestId, message: "Puesto creado" })
})
