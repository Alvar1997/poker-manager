import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { parseIdParam } from "@/modules/admin/admin.schemas"
import { failExecutionSchema } from "@/modules/corrections/correction.schemas"
import * as svc from "@/modules/corrections/correction.service"

export const dynamic = "force-dynamic"

export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.CORRECTIONS_OPERATE, {
      requestId,
      resource: "POST /api/admin/corrections/:id/fail",
    })
    const id = await parseIdParam(params, "id")
    const input = await parseJsonBody(req, failExecutionSchema)
    return ok(await svc.markExecutionFailed(actor, id, input, { requestId }), {
      requestId,
      message: "Fallo de ejecución registrado",
    })
  }
)
