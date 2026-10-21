import { withApiHandler } from "@/lib/api-handler"
import { prisma } from "@/lib/prisma"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseSessionIdParam } from "@/modules/sessions/session.schemas"
import { getInventoryStatus } from "@/modules/closure/closure.data"

export const dynamic = "force-dynamic"

/** GET — inventario: esperado nominal (con su cálculo), arqueo final, diferencia física y circulación. */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SESSIONS_READ, {
      requestId,
      resource: "GET /api/sessions/:id/closure/inventory",
    })
    const id = await parseSessionIdParam(params)
    return ok(await getInventoryStatus(prisma, id), { requestId })
  }
)
