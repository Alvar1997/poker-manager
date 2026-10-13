import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseJsonBody } from "@/lib/validation"
import { requireUser } from "@/config/permissions"
import { updateProfileSchema } from "@/modules/auth/auth.schemas"
import { updateProfile } from "@/modules/auth/auth.service"

export const dynamic = "force-dynamic"

/**
 * PATCH /api/auth/profile — el propio usuario solo puede cambiar su
 * nombre. Cualquier otro campo (role, email, isActive…) → 400.
 */
export const PATCH = withApiHandler(async (req, { requestId }) => {
  const user = await requireUser()
  const input = await parseJsonBody(req, updateProfileSchema)

  const profile = await updateProfile(user, input, { requestId })
  return ok(profile, { message: "Perfil actualizado", requestId })
})
