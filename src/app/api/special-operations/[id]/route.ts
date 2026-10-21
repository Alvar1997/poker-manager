import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseIdParam } from "@/modules/special-operations/special.schemas"
import { resolveSpecialOperation } from "@/modules/special-operations/special-query.service"

export const dynamic = "force-dynamic"

/** GET — localiza una operación especial por id (cualquiera de los cuatro procesos). */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SPECIAL_OPS_READ, {
      requestId,
      resource: "GET /api/special-operations/:id",
    })
    return ok(await resolveSpecialOperation(await parseIdParam(params)), {
      requestId,
    })
  }
)
