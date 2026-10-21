import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { listCreditAuthorizers } from "@/modules/purchases/purchase.service"

export const dynamic = "force-dynamic"

/** GET — socios ACTIVOS que pueden figurar como autorizadores de crédito (no cajeros). */
export const GET = withApiHandler(async (_req, { requestId }) => {
  await requirePermission(PERMISSIONS.PURCHASES_CREATE, {
    requestId,
    resource: "GET /api/purchases/authorizers",
  })
  return ok(await listCreditAuthorizers(), { requestId })
})
