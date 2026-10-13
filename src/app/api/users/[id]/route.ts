import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseJsonBody } from "@/lib/validation"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { getUserById, updateUser } from "@/modules/users/user.service"
import {
  parseUserIdParam,
  updateUserSchema,
} from "@/modules/users/user.schemas"

export const dynamic = "force-dynamic"

type Params = { id: string }

/** GET /api/users/:id — detalle sanitizado. Solo SUPERADMIN. */
export const GET = withApiHandler<Params>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.USERS_READ, {
      requestId,
      resource: "GET /api/users/:id",
    })
    const id = await parseUserIdParam(params)

    return ok(await getUserById(id), { requestId })
  }
)

/**
 * PATCH /api/users/:id — nombre, correo y rol. Cambiar el rol exige
 * roles:manage; el servicio impide cambiar el propio rol y dejar el
 * sistema sin SUPERADMIN activo.
 */
export const PATCH = withApiHandler<Params>(
  async (req, { params, requestId }) => {
    const ctx = { requestId, resource: "PATCH /api/users/:id" }
    const actor = await requirePermission(PERMISSIONS.USERS_UPDATE, ctx)
    const id = await parseUserIdParam(params)
    const input = await parseJsonBody(req, updateUserSchema)
    if (input.role !== undefined) {
      await requirePermission(PERMISSIONS.ROLES_MANAGE, ctx)
    }

    const user = await updateUser(actor, id, input, { requestId })
    return ok(user, { message: "Usuario actualizado", requestId })
  }
)
