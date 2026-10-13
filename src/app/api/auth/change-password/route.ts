import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseJsonBody } from "@/lib/validation"
import { requireUser } from "@/config/permissions"
import { changePasswordSchema } from "@/modules/auth/auth.schemas"
import { changeOwnPassword } from "@/modules/auth/auth.service"

export const dynamic = "force-dynamic"

/**
 * POST /api/auth/change-password — verifica la contraseña actual y
 * aplica la nueva. Invalida TODAS las sesiones del usuario (incluida la
 * actual): el cliente debe cerrar sesión e iniciar de nuevo.
 */
export const POST = withApiHandler(async (req, { requestId }) => {
  const user = await requireUser()
  const input = await parseJsonBody(req, changePasswordSchema)

  await changeOwnPassword(user, input, { requestId })
  return ok(
    { reauthenticate: true },
    { message: "Contraseña actualizada", requestId }
  )
})
