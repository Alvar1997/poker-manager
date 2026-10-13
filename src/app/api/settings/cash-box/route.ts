import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseJsonBody } from "@/lib/validation"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { updateCashBoxSchema } from "@/modules/settings/settings.schemas"
import { getCashBox, updateCashBox } from "@/modules/settings/settings.service"

export const dynamic = "force-dynamic"

/** GET /api/settings/cash-box — la caja central única (sin saldos). */
export const GET = withApiHandler(async (_req, { requestId }) => {
  await requirePermission(PERMISSIONS.SETTINGS_READ, {
    requestId,
    resource: "GET /api/settings/cash-box",
  })
  return ok(await getCashBox(), { requestId })
})

/** PATCH /api/settings/cash-box — solo el nombre; solo SUPERADMIN. */
export const PATCH = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.SETTINGS_MANAGE, {
    requestId,
    resource: "PATCH /api/settings/cash-box",
  })
  const input = await parseJsonBody(req, updateCashBoxSchema)
  return ok(await updateCashBox(actor, input, { requestId }), {
    message: "Caja actualizada",
    requestId,
  })
})
