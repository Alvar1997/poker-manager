import { withApiHandler } from "@/lib/api-handler"
import { prisma } from "@/lib/prisma"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseSessionIdParam } from "@/modules/sessions/session.schemas"
import { buildClosurePreview } from "@/modules/closure/closure.data"

export const dynamic = "force-dynamic"

/** GET — resumen completo, requisitos del cierre definitivo y huella del resumen. */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SESSIONS_READ, {
      requestId,
      resource: "GET /api/sessions/:id/closure/preview",
    })
    const id = await parseSessionIdParam(params)
    return ok(await buildClosurePreview(prisma, id), { requestId })
  }
)
