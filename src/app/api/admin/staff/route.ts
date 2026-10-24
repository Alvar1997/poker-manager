import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { createStaffSchema } from "@/modules/staff-tips/tips.schemas"
import { createStaff, listStaff } from "@/modules/staff-tips/staff.service"

export const dynamic = "force-dynamic"

/** GET — Módulo 18.  */
export const GET = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.STAFF_READ, {
    requestId,
    resource: "GET /api/admin/staff",
  })
  void actor
  const active = req.nextUrl.searchParams.get("active")
  const r = await listStaff(
    active === null ? {} : { active: active === "true" }
  )
  return ok(r, { status: 200, requestId })
})

/** POST — Módulo 18.  */
export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.STAFF_MANAGE, {
    requestId,
    resource: "POST /api/admin/staff",
  })
  const input = await parseJsonBody(req, createStaffSchema)
  const r = await createStaff(actor, input, { requestId })
  return ok(r, { status: 201, requestId, message: "Empleado registrado" })
})
