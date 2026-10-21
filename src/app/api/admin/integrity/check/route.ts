import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { runIntegrityCheck } from "@/modules/integrity/integrity.service"

export const dynamic = "force-dynamic"
export const maxDuration = 120

/** POST — diagnóstico de SOLO LECTURA (no repara ni crea movimientos). */
export const POST = withApiHandler(async (_req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.INTEGRITY_RUN, {
    requestId,
    resource: "POST /api/admin/integrity/check",
  })
  return ok(await runIntegrityCheck(actor, { trigger: "MANUAL", requestId }), {
    requestId,
    message: "Diagnóstico completado",
  })
})
