import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { NotFoundError } from "@/lib/errors"
import { parseJsonBody } from "@/lib/validation"
import { can, PERMISSIONS, requirePermission } from "@/config/permissions"
import {
  parseIdParam,
  updateTableSchema,
} from "@/modules/settings/settings.schemas"
import { getTable, updateTable } from "@/modules/tables/table.service"

export const dynamic = "force-dynamic"

type Params = { id: string }

/** GET /api/tables/:id — una mesa inactiva no es visible para CASHIER. */
export const GET = withApiHandler<Params>(
  async (_req, { params, requestId }) => {
    const user = await requirePermission(PERMISSIONS.CATALOGS_READ, {
      requestId,
      resource: "GET /api/tables/:id",
    })
    const table = await getTable(await parseIdParam(params))
    if (!table.isActive && !can(user, PERMISSIONS.SETTINGS_READ)) {
      throw new NotFoundError("Mesa no encontrada")
    }
    return ok(table, { requestId })
  }
)

/** PATCH /api/tables/:id — nombre, ciegas, juego asignado, orden. Solo SUPERADMIN. */
export const PATCH = withApiHandler<Params>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SETTINGS_MANAGE, {
      requestId,
      resource: "PATCH /api/tables/:id",
    })
    const id = await parseIdParam(params)
    const input = await parseJsonBody(req, updateTableSchema)
    return ok(await updateTable(actor, id, input, { requestId }), {
      message: "Mesa actualizada",
      requestId,
    })
  }
)
