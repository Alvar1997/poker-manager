import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { requestRecoverySchema } from "@/modules/admin/admin.schemas"
import {
  getRecoveryOverview,
  requestRecovery,
} from "@/modules/backups/recovery.service"

export const dynamic = "force-dynamic"

/** GET — controles de recuperación (solo SUPERADMIN). */
export const GET = withApiHandler(async (_req, { requestId }) => {
  await requirePermission(PERMISSIONS.RECOVERY_MANAGE, {
    requestId,
    resource: "GET /api/admin/recovery",
  })
  return ok(await getRecoveryOverview(), { requestId })
})

/**
 * POST — SOLICITA una recuperación (con contraseña). No restaura nada: la
 * ejecución es un procedimiento protegido por CLI tras validar y aprobar.
 */
export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.RECOVERY_MANAGE, {
    requestId,
    resource: "POST /api/admin/recovery",
  })
  const input = await parseJsonBody(req, requestRecoverySchema)
  return ok(await requestRecovery(actor, input, { requestId }), {
    requestId,
    status: 201,
    message: "Solicitud de recuperación registrada (no ejecutada)",
  })
})
