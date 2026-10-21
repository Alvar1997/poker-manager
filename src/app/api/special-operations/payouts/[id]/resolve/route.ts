import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { prisma } from "@/lib/prisma"
import {
  parseIdParam,
  resolvePayoutSchema,
} from "@/modules/special-operations/special.schemas"
import { getPayable } from "@/modules/special-operations/special-query.service"
import { resolveSpecialPayout } from "@/modules/special-operations/special-payout.service"

export const dynamic = "force-dynamic"

/** POST — confirma (con referencia), marca fallida o cancela una transferencia pendiente. */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SPECIAL_OPS_OPERATE, {
      requestId,
      resource: "POST /api/special-operations/payouts/:id/resolve",
    })
    const id = await parseIdParam(params)
    const input = await parseJsonBody(req, resolvePayoutSchema)
    await resolveSpecialPayout(actor, id, input, { requestId })
    const payout = await prisma.specialPayout.findUniqueOrThrow({
      where: { id },
      select: { payableId: true },
    })
    return ok(await getPayable(payout.payableId), {
      message:
        input.outcome === "EXECUTED"
          ? "Transferencia confirmada como realizada"
          : "Transferencia marcada sin efecto: el saldo vuelve a estar pendiente",
      requestId,
    })
  }
)
