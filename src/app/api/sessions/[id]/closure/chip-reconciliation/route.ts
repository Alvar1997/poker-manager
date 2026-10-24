import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { sessionChipReconciliationSchema } from "@/modules/closure/closure.schemas"
import { reconcileSessionChips } from "@/modules/closure/closure.service"
import { parseSessionIdParam } from "@/modules/sessions/session.schemas"

export const dynamic = "force-dynamic"

/**
 * POST — concilia la diferencia nominal GLOBAL de la sesión en cierre:
 * retorno identificado en el arqueo (entrada nominal real respaldada por
 * fichas contadas) o diferencia documentada y autorizada (sin movimientos).
 * Solo PARTNER o SUPERADMIN.
 */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(
      PERMISSIONS.SESSIONS_CLOSE_AUTHORIZE,
      {
        requestId,
        resource: "POST /api/sessions/:id/closure/chip-reconciliation",
      }
    )
    const id = await parseSessionIdParam(params)
    const input = await parseJsonBody(req, sessionChipReconciliationSchema)
    const r = await reconcileSessionChips(actor, id, input, { requestId })
    return ok(r, {
      status: r.replayed ? 200 : 201,
      message:
        input.kind === "RETURN_IDENTIFIED_IN_COUNT"
          ? "Retorno identificado registrado: vuelve a contar las fichas"
          : "Diferencia documentada y autorizada",
      requestId,
    })
  }
)
