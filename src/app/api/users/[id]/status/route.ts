import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseJsonBody } from "@/lib/validation"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { setUserStatus } from "@/modules/users/user.service"
import {
  parseUserIdParam,
  userStatusSchema,
} from "@/modules/users/user.schemas"

export const dynamic = "force-dynamic"

/** PATCH /api/users/:id/status — activar/desactivar (sin borrado físico). */
export const PATCH = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.USERS_DISABLE, {
      requestId,
      resource: "PATCH /api/users/:id/status",
    })
    const id = await parseUserIdParam(params)
    const { isActive } = await parseJsonBody(req, userStatusSchema)

    const user = await setUserStatus(actor, id, isActive, { requestId })
    return ok(user, {
      message: isActive ? "Usuario activado" : "Usuario desactivado",
      requestId,
    })
  }
)
