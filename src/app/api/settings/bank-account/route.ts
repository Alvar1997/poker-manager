import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseJsonBody } from "@/lib/validation"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import {
  getBankAccount,
  updateBankAccount,
} from "@/modules/settings/bank-account.service"
import { updateBankAccountSchema } from "@/modules/settings/settings.schemas"

export const dynamic = "force-dynamic"

/**
 * GET /api/settings/bank-account — SUPERADMIN y PARTNER, siempre
 * enmascarada (últimos 4 dígitos). CASHIER no tiene acceso.
 */
export const GET = withApiHandler(async (_req, { requestId }) => {
  await requirePermission(PERMISSIONS.SETTINGS_READ, {
    requestId,
    resource: "GET /api/settings/bank-account",
  })
  const response = ok(await getBankAccount(), { requestId })
  response.headers.set("Cache-Control", "no-store")
  return response
})

/** PATCH /api/settings/bank-account — solo SUPERADMIN. */
export const PATCH = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.SETTINGS_MANAGE, {
    requestId,
    resource: "PATCH /api/settings/bank-account",
  })
  const input = await parseJsonBody(req, updateBankAccountSchema)
  const response = ok(await updateBankAccount(actor, input, { requestId }), {
    message: "Cuenta bancaria actualizada",
    requestId,
  })
  response.headers.set("Cache-Control", "no-store")
  return response
})
