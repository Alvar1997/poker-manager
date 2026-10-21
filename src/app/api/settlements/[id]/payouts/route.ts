import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import {
  parseSettlementIdParam,
  registerPayoutSchema,
} from "@/modules/settlements/settlement.schemas"
import {
  listSettlementPayouts,
  registerPayout,
} from "@/modules/settlements/settlement-payout.service"
import { getSettlement } from "@/modules/settlements/settlement.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SETTLEMENTS_READ, {
      requestId,
      resource: "GET /api/settlements/:id/payouts",
    })
    return ok(
      await listSettlementPayouts(await parseSettlementIdParam(params)),
      {
        requestId,
      }
    )
  }
)

/**
 * POST — registra un pago al jugador. Efectivo: se entrega y contabiliza
 * ya (caja de la sesión, o custodia administrativa si la sesión cerró).
 * Transferencia: queda en trámite (no cuenta como pagada) hasta verificarla.
 */
export const POST = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SETTLEMENTS_OPERATE, {
      requestId,
      resource: "POST /api/settlements/:id/payouts",
    })
    const id = await parseSettlementIdParam(params)
    const input = await parseJsonBody(req, registerPayoutSchema)
    const result = await registerPayout(actor, id, input, { requestId })
    return ok(await getSettlement(id), {
      status: result.replayed ? 200 : 201,
      message:
        input.method === "CASH"
          ? "Pago en efectivo registrado"
          : "Transferencia registrada en trámite: no cuenta como pagada hasta verificarla",
      requestId,
    })
  }
)
