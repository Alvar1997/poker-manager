import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { createAgreementSchema } from "@/modules/banking/banking.schemas"
import { createAgreement } from "@/modules/banking/agreement.service"

export const dynamic = "force-dynamic"

/** POST — Módulo 17 (privado). Autorización en el servidor + Zod + idempotencia. */
export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.BANKING_APPROVE, {
    requestId,
    resource: "POST /api/admin/banking/agreements",
  })
  const input = await parseJsonBody(req, createAgreementSchema)
  const r = await createAgreement(actor, input, { requestId })
  return ok(r, {
    status: r.replayed ? 200 : 201,
    message: "Acuerdo registrado (aprobación digital)",
    requestId,
  })
})
