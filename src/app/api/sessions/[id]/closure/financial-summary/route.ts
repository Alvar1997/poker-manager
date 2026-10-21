import { withApiHandler } from "@/lib/api-handler"
import { prisma } from "@/lib/prisma"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseSessionIdParam } from "@/modules/sessions/session.schemas"
import { getFinancialSummary } from "@/modules/closure/closure.data"

export const dynamic = "force-dynamic"

/** GET — indicadores reales de la sesión (sin utilidad ficticia). */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SESSIONS_READ, {
      requestId,
      resource: "GET /api/sessions/:id/closure/financial-summary",
    })
    const id = await parseSessionIdParam(params)
    return ok(await getFinancialSummary(prisma, id), { requestId })
  }
)
