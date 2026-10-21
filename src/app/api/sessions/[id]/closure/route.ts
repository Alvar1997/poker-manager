import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseSessionIdParam } from "@/modules/sessions/session.schemas"
import { getClosureOverview } from "@/modules/closure/closure.service"

export const dynamic = "force-dynamic"

/**
 * GET — panel del cierre: estado, prevalidación, inventario, efectivo,
 * diferencias, requisitos, intentos (regresos a Abierta) y comprobante.
 * No hay endpoint genérico para cambiar el estado de una sesión: cada
 * transición tiene su acción (start, return-to-open, confirm).
 */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SESSIONS_READ, {
      requestId,
      resource: "GET /api/sessions/:id/closure",
    })
    return ok(await getClosureOverview(await parseSessionIdParam(params)), {
      requestId,
    })
  }
)
