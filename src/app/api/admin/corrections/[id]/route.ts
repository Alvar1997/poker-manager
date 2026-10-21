import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseIdParam } from "@/modules/admin/admin.schemas"
import { getCorrection } from "@/modules/corrections/correction.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.CORRECTIONS_REQUEST, {
      requestId,
      resource: "GET /api/admin/corrections/:id",
    })
    return ok(await getCorrection(await parseIdParam(params, "id")), {
      requestId,
    })
  }
)
