import { z } from "zod"

import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  getClosureWizard,
  saveClosureWizardProgress,
} from "@/modules/closure/closure-wizard.service"
import { parseSessionIdParam } from "@/modules/sessions/session.schemas"

export const dynamic = "force-dynamic"

const progressSchema = z
  .strictObject({
    currentStep: z.number().int().min(1).max(6).optional(),
    nominalReason: z.string().max(1000).optional(),
    physicalReason: z.string().max(1000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nada que guardar")

/** GET — asistente de cierre: 6 pasos validados en el servidor. */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SESSIONS_READ, {
      requestId,
      resource: "GET /api/sessions/:id/closure/wizard",
    })
    const id = await parseSessionIdParam(params)
    return ok(await getClosureWizard(id), { requestId })
  }
)

/** PATCH — paso actual y borradores de motivos (no cambia importes). */
export const PATCH = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_MANAGE, {
      requestId,
      resource: "PATCH /api/sessions/:id/closure/wizard",
    })
    const id = await parseSessionIdParam(params)
    const input = await parseJsonBody(req, progressSchema)
    const r = await saveClosureWizardProgress(actor, id, input, { requestId })
    return ok(r, { requestId })
  }
)
