import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseJsonBody } from "@/lib/validation"
import { can, PERMISSIONS, requirePermission } from "@/config/permissions"
import { createTableSchema } from "@/modules/settings/settings.schemas"
import { createTable, listTables } from "@/modules/tables/table.service"

export const dynamic = "force-dynamic"

/** GET /api/tables — CASHIER ve solo mesas activas; SUPERADMIN/PARTNER, todas. */
export const GET = withApiHandler(async (_req, { requestId }) => {
  const user = await requirePermission(PERMISSIONS.CATALOGS_READ, {
    requestId,
    resource: "GET /api/tables",
  })
  const includeInactive = can(user, PERMISSIONS.SETTINGS_READ)
  return ok(await listTables({ includeInactive }), { requestId })
})

/** POST /api/tables — solo SUPERADMIN. No crea ninguna caja. */
export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.SETTINGS_MANAGE, {
    requestId,
    resource: "POST /api/tables",
  })
  const input = await parseJsonBody(req, createTableSchema)
  return ok(await createTable(actor, input, { requestId }), {
    status: 201,
    message: "Mesa creada",
    requestId,
  })
})
