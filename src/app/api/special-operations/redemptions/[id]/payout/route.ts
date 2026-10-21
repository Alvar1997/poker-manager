import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { NotFoundError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import { getRedemption } from "@/modules/special-operations/redemption.service"
import {
  parseIdParam,
  registerPayoutSchema,
} from "@/modules/special-operations/special.schemas"
import { registerSpecialPayout } from "@/modules/special-operations/special-payout.service"

export const dynamic = "force-dynamic"

/** POST — pago REAL del canje (efectivo entregado o transferencia en trámite). */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SPECIAL_OPS_OPERATE, {
      requestId,
      resource: "POST /api/special-operations/redemptions/:id/payout",
    })
    const id = await parseIdParam(params)
    const input = await parseJsonBody(req, registerPayoutSchema)
    const payable = await prisma.specialPayable.findUnique({
      where: { kind_sourceId: { kind: "REDEMPTION", sourceId: id } },
      select: { id: true },
    })
    if (!payable)
      throw new NotFoundError(
        "El canje aún no tiene fichas recibidas: no hay nada que pagar"
      )
    const r = await registerSpecialPayout(actor, payable.id, input, {
      requestId,
    })
    return ok(await getRedemption(id), {
      status: r.replayed ? 200 : 201,
      message:
        input.method === "CASH"
          ? "Pago en efectivo registrado"
          : "Transferencia en trámite: no cuenta como pagada hasta confirmarla",
      requestId,
    })
  }
)
