import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseIdParam } from "@/modules/banking/banking.schemas"
import { parseJsonBody } from "@/lib/validation"
import { updateStaffSchema } from "@/modules/staff-tips/tips.schemas"
import { updateStaff } from "@/modules/staff-tips/staff.service"

export const dynamic = "force-dynamic"

/** PATCH — Módulo 18.  */
export const PATCH = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.STAFF_MANAGE, {
      requestId,
      resource: "PATCH /api/admin/staff/:id",
    })
    const id = await parseIdParam(params)
    const input = await parseJsonBody(req, updateStaffSchema)
    const r = await updateStaff(actor, id, input, { requestId })
    return ok(r, { status: 200, requestId, message: "Empleado actualizado" })
  }
)
