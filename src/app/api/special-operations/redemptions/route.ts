import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  createRedemption,
  getRedemption,
} from "@/modules/special-operations/redemption.service"
import { createRedemptionSchema } from "@/modules/special-operations/special.schemas"
import { listRedemptions } from "@/modules/special-operations/special-query.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler(async (req, { requestId }) => {
  await requirePermission(PERMISSIONS.SPECIAL_OPS_READ, {
    requestId,
    resource: "GET /api/special-operations/redemptions",
  })
  const status = req.nextUrl.searchParams.get("status") ?? undefined
  return ok(
    await listRedemptions({
      status: status && /^[A-Z_]+$/.test(status) ? status : undefined,
    }),
    { requestId }
  )
})

/** POST — registra la presentación de fichas (no recibe fichas ni crea obligaciones). */
export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.SPECIAL_OPS_OPERATE, {
    requestId,
    resource: "POST /api/special-operations/redemptions",
  })
  const input = await parseJsonBody(req, createRedemptionSchema)
  const r = await createRedemption(actor, input, { requestId })
  return ok(await getRedemption(r.id), {
    status: r.replayed ? 200 : 201,
    message: "Canje solicitado: falta la validación del valor por un socio",
    requestId,
  })
})
