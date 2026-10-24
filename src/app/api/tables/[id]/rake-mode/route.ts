import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseIdParam } from "@/modules/banking/banking.schemas"
import { parseJsonBody } from "@/lib/validation"
import { rakeModeSchema } from "@/modules/rake/rake.schemas"
import { setTableRakeMode } from "@/modules/rake/rake.service"

export const dynamic = "force-dynamic"

/** POST — Módulo 18. El servicio exige rake:authorize (y lo audita). */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.RAKE_READ, {
      requestId,
      resource: "POST /api/tables/:id/rake-mode",
    })
    const id = await parseIdParam(params)
    const input = await parseJsonBody(req, rakeModeSchema)
    const r = await setTableRakeMode(actor, id, input, { requestId })
    return ok(r, {
      status: 200,
      requestId,
      message: "Modalidad de rake actualizada",
    })
  }
)
