import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parseDiscrepancyIdParam,
  resolveDiscrepancySchema,
} from "@/modules/closure/closure.schemas"
import { resolveDiscrepancy } from "@/modules/closure/closure.service"
import { parseSessionIdParam } from "@/modules/sessions/session.schemas"

export const dynamic = "force-dynamic"

/**
 * POST — `note`: seguimiento de la investigación (los tres roles).
 * `authorize-adjustment`: ajuste EXCEPCIONAL; además de este permiso, el
 * servicio exige PARTNER o SUPERADMIN (CASHIER → 403).
 */
export const POST = withApiHandler<{ id: string; discrepancyId: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
      requestId,
      resource:
        "POST /api/sessions/:id/closure/discrepancies/:discrepancyId/resolve",
    })
    if (
      (
        await req
          .clone()
          .json()
          .catch(() => ({}))
      )?.action === "authorize-adjustment"
    ) {
      await requirePermission(PERMISSIONS.SESSIONS_CLOSE_AUTHORIZE, {
        requestId,
        resource:
          "POST /api/sessions/:id/closure/discrepancies/:discrepancyId/resolve",
      })
    }
    const id = await parseSessionIdParam(params)
    const discrepancyId = await parseDiscrepancyIdParam(params)
    const input = await parseJsonBody(req, resolveDiscrepancySchema)
    return ok(
      await resolveDiscrepancy(actor, id, discrepancyId, input, { requestId }),
      { message: "Diferencia actualizada", requestId }
    )
  }
)
