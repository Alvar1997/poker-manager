import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { listBankingClosings } from "@/modules/banking/banking-query.service"

export const dynamic = "force-dynamic"

/** GET — Módulo 17 (privado): solo con `banking:read`. */
export const GET = withApiHandler(async (_req, { requestId }) => {
  await requirePermission(PERMISSIONS.BANKING_READ, {
    requestId,
    resource: "GET /api/admin/banking/closings",
  })
  return ok(await listBankingClosings(), { requestId })
})
