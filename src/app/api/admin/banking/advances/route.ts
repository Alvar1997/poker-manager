import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { createAdvanceSchema } from "@/modules/banking/banking.schemas"
import { registerAdvance } from "@/modules/banking/advance.service"

export const dynamic = "force-dynamic"

/** POST — Módulo 17 (privado). Autorización en el servidor + Zod + idempotencia. */
export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.BANKING_OPERATE, {
    requestId,
    resource: "POST /api/admin/banking/advances",
  })
  const input = await parseJsonBody(req, createAdvanceSchema)
  const r = await registerAdvance(actor, input, { requestId })
  return ok(r, {
    status: r.replayed ? 200 : 201,
    message:
      "Anticipo registrado (autorización verbal o por mensaje): aún no se paga",
    requestId,
  })
})
