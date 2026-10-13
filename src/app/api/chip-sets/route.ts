import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseJsonBody } from "@/lib/validation"
import { can, PERMISSIONS, requirePermission } from "@/config/permissions"
import { createChipSet, listChipSets } from "@/modules/chips/chip-set.service"
import { createChipSetSchema } from "@/modules/settings/settings.schemas"

export const dynamic = "force-dynamic"

/** GET /api/chip-sets — juegos físicos de fichas. CASHIER ve solo los activos. */
export const GET = withApiHandler(async (_req, { requestId }) => {
  const user = await requirePermission(PERMISSIONS.CATALOGS_READ, {
    requestId,
    resource: "GET /api/chip-sets",
  })
  const includeInactive = can(user, PERMISSIONS.SETTINGS_READ)
  return ok(await listChipSets({ includeInactive }), { requestId })
})

/** POST /api/chip-sets — solo SUPERADMIN. Sin denominaciones ni existencias. */
export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.SETTINGS_MANAGE, {
    requestId,
    resource: "POST /api/chip-sets",
  })
  const input = await parseJsonBody(req, createChipSetSchema)
  return ok(await createChipSet(actor, input, { requestId }), {
    status: 201,
    message: "Juego de fichas creado",
    requestId,
  })
})
