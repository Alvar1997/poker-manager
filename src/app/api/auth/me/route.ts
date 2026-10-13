import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { permissionsForRole } from "@/config/permission-matrix"
import { requireUser } from "@/config/permissions"
import { getProfile } from "@/modules/auth/auth.service"

export const dynamic = "force-dynamic"

/**
 * GET /api/auth/me — perfil vigente (leído de la base, no del JWT) y
 * permisos efectivos del rol actual. Útil para refrescar la UI tras un
 * cambio de rol sin confiar en datos del navegador.
 */
export const GET = withApiHandler(async (_req, { requestId }) => {
  const user = await requireUser()
  const profile = await getProfile(user.id)

  const response = ok(
    {
      user: profile,
      permissions: user.mustChangePassword ? [] : permissionsForRole(user.role),
    },
    { requestId }
  )
  response.headers.set("Cache-Control", "no-store")
  return response
})
