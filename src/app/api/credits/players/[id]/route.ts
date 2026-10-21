import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { can, PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseIdParam } from "@/modules/credits/credit.schemas"
import { getPlayerCreditSummary } from "@/modules/credits/receivable.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.CREDITS_READ, {
      requestId,
      resource: "GET /api/credits/players/:id",
    })
    return ok(
      await getPlayerCreditSummary(await parseIdParam(params), {
        showPhone: can(actor, PERMISSIONS.PLAYERS_READ),
      }),
      { requestId }
    )
  }
)
