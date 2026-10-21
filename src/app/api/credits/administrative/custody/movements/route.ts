import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { listCustodyMovements } from "@/modules/credits/custody.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler(async (_req, { requestId }) => {
  await requirePermission(PERMISSIONS.CREDITS_READ, {
    requestId,
    resource: "GET /api/credits/administrative/custody/movements",
  })
  return ok(await listCustodyMovements(), { requestId })
})
