import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseJsonBody } from "@/lib/validation"
import { can, PERMISSIONS, requirePermission } from "@/config/permissions"
import {
  createDenomination,
  listDenominations,
} from "@/modules/chips/chip-set.service"
import {
  createDenominationSchema,
  parseIdParam,
} from "@/modules/settings/settings.schemas"

export const dynamic = "force-dynamic"

type Params = { id: string }

/** GET /api/chip-sets/:id/denominations — CASHIER ve solo las activas. */
export const GET = withApiHandler<Params>(
  async (_req, { params, requestId }) => {
    const user = await requirePermission(PERMISSIONS.CATALOGS_READ, {
      requestId,
      resource: "GET /api/chip-sets/:id/denominations",
    })
    const includeInactive = can(user, PERMISSIONS.SETTINGS_READ)
    return ok(
      await listDenominations(await parseIdParam(params), { includeInactive }),
      { requestId }
    )
  }
)

/** POST /api/chip-sets/:id/denominations — valor > 0, único dentro del juego. Solo SUPERADMIN. */
export const POST = withApiHandler<Params>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SETTINGS_MANAGE, {
      requestId,
      resource: "POST /api/chip-sets/:id/denominations",
    })
    const chipSetId = await parseIdParam(params)
    const input = await parseJsonBody(req, createDenominationSchema)
    return ok(
      await createDenomination(actor, chipSetId, input, { requestId }),
      {
        status: 201,
        message: "Denominación creada",
        requestId,
      }
    )
  }
)
