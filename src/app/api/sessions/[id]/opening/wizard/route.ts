import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  getOpeningWizard,
  saveOpeningWizardProgress,
} from "@/modules/sessions/opening-wizard.service"
import {
  openingWizardProgressSchema,
  parseSessionIdParam,
} from "@/modules/sessions/session.schemas"

export const dynamic = "force-dynamic"

/** GET — asistente de apertura: 4 pasos validados en el servidor. */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_READ, {
      requestId,
      resource: "GET /api/sessions/:id/opening/wizard",
    })
    const id = await parseSessionIdParam(params)
    return ok(await getOpeningWizard(id, actor), { requestId })
  }
)

/** PATCH — paso actual, observación y «continuar sin mesas» (solo el creador o SUPERADMIN). */
export const PATCH = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
      requestId,
      resource: "PATCH /api/sessions/:id/opening/wizard",
    })
    const id = await parseSessionIdParam(params)
    const input = await parseJsonBody(req, openingWizardProgressSchema)
    return ok(
      await saveOpeningWizardProgress(actor, id, input, { requestId }),
      {
        requestId,
      }
    )
  }
)
