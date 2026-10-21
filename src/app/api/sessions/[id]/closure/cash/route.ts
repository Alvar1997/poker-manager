import { withApiHandler } from "@/lib/api-handler"
import { prisma } from "@/lib/prisma"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseSessionIdParam } from "@/modules/sessions/session.schemas"
import { getCashStatus } from "@/modules/closure/closure.data"

export const dynamic = "force-dynamic"

/** GET — efectivo esperado por el libro (desglose), arqueo de cierre y retiro final. */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SESSIONS_READ, {
      requestId,
      resource: "GET /api/sessions/:id/closure/cash",
    })
    const id = await parseSessionIdParam(params)
    return ok(await getCashStatus(prisma, id), { requestId })
  }
)
