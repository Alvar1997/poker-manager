import { z } from "zod"

import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { ValidationError } from "@/lib/errors"
import { parseQueryParams } from "@/lib/validation"
import {
  nonNegativeMoneySchema,
  parseIdParam,
} from "@/modules/banking/banking.schemas"
import { getCycle } from "@/modules/banking/banking-query.service"
import { previewClosing } from "@/modules/banking/closing.service"

export const dynamic = "force-dynamic"

const querySchema = z.strictObject({
  reserveAmount: nonNegativeMoneySchema.optional(),
  payAmount: nonNegativeMoneySchema.optional(),
  /** JSON {tramo: importe} (solo vista previa; nada se guarda). */
  lossAllocation: z.string().max(2000).optional(),
})

/**
 * GET — corte del ciclo: versiones guardadas y una VISTA PREVIA calculada
 * en el servidor con la propuesta indicada (no escribe nada).
 */
export const GET = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.BANKING_READ, {
      requestId,
      resource: "GET /api/admin/banking/cycles/:id/closing",
    })
    const id = await parseIdParam(params)
    const q = parseQueryParams(req.nextUrl.searchParams, querySchema)
    let allocation: Record<string, string> | null = null
    if (q.lossAllocation) {
      try {
        const parsed = z
          .record(
            z.string().max(64),
            z.string().regex(/^\d{1,10}(\.\d{1,2})?$/)
          )
          .parse(JSON.parse(q.lossAllocation))
        allocation = parsed
      } catch {
        throw new ValidationError("Distribución de pérdidas inválida")
      }
    }
    const cycle = await getCycle(id)
    const preview =
      cycle.games.length === cycle.gamesPerCycle
        ? await previewClosing(id, {
            reserveAmount: q.reserveAmount,
            payAmount: q.payAmount,
            lossAllocation: allocation,
          }).catch((e: unknown) => ({
            error: e instanceof Error ? e.message : "No disponible",
          }))
        : null
    return ok({ closings: cycle.closings, preview }, { requestId })
  }
)
