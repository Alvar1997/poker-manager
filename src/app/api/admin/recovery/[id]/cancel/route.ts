import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parseIdParam,
  cancelRecoverySchema,
} from "@/modules/admin/admin.schemas"
import * as svc from "@/modules/backups/recovery.service"

export const dynamic = "force-dynamic"

export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.RECOVERY_MANAGE, {
      requestId,
      resource: "POST /api/admin/recovery/:id/cancel",
    })
    const id = await parseIdParam(params, "id")
    const input = await parseJsonBody(req, cancelRecoverySchema)
    await svc.cancelRecovery(actor, id, input.notes, { requestId })
    return ok({ id }, { requestId, message: "Solicitud cancelada" })
  }
)
