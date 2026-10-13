import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseUserIdParam } from "@/modules/users/user.schemas"
import { resetUserPassword } from "@/modules/users/user.service"

export const dynamic = "force-dynamic"

/**
 * POST /api/users/:id/reset-password — genera una credencial temporal
 * (se devuelve una sola vez, no se envía por correo), obliga a cambiarla
 * en el siguiente acceso e invalida las sesiones abiertas del usuario.
 */
export const POST = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.USERS_RESET_PASSWORD, {
      requestId,
      resource: "POST /api/users/:id/reset-password",
    })
    const id = await parseUserIdParam(params)

    const result = await resetUserPassword(actor, id, { requestId })
    const response = ok(result, {
      message: "Contraseña restablecida",
      requestId,
    })
    response.headers.set("Cache-Control", "no-store")
    return response
  }
)
