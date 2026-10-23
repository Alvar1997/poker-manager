import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseIdParam } from "@/modules/banking/banking.schemas"
import { getCycle } from "@/modules/banking/banking-query.service"

export const dynamic = "force-dynamic"

/** GET — Módulo 17 (privado): solo con `banking:read`. */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.BANKING_READ, {
      requestId,
      resource: "GET /api/admin/banking/cycles/:id",
    })
    const id = await parseIdParam(params)
    return ok(await getCycle(id), { requestId })
  }
)
