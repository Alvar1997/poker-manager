import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { listPlayersWithDebt } from "@/modules/credits/receivable.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler(async (req, { requestId }) => {
  await requirePermission(PERMISSIONS.CREDITS_READ, {
    requestId,
    resource: "GET /api/credits/players",
  })
  return ok(
    await listPlayersWithDebt(
      req.nextUrl.searchParams.get("q")?.trim().slice(0, 80) || undefined
    ),
    { requestId }
  )
})
