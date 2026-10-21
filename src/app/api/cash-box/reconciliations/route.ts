import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { z } from "zod"

import { parseJsonBody, parseQueryParams } from "@/lib/validation"
import { createReconciliationSchema } from "@/modules/cash/cash.schemas"
import {
  createCashReconciliation,
  listCashReconciliations,
} from "@/modules/cash/reconciliation.service"

export const dynamic = "force-dynamic"

const query = z.object({
  sessionId: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(64)
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
})

export const GET = withApiHandler(async (req, { requestId }) => {
  await requirePermission(PERMISSIONS.CASH_READ, {
    requestId,
    resource: "GET /api/cash-box/reconciliations",
  })
  return ok(
    await listCashReconciliations(
      parseQueryParams(req.nextUrl.searchParams, query)
    ),
    { requestId }
  )
})

/** POST — arqueo de efectivo de una sesión (OPENING en preparación con esperado $0; CONTROL/CLOSING abierta). */
export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.CASH_OPERATE, {
    requestId,
    resource: "POST /api/cash-box/reconciliations",
  })
  const input = await parseJsonBody(req, createReconciliationSchema)
  return ok(await createCashReconciliation(actor, input, { requestId }), {
    status: 201,
    message: "Arqueo de efectivo registrado",
    requestId,
  })
})
