import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody, parseQueryParams } from "@/lib/validation"
import {
  createPurchaseSchema,
  purchasesQuerySchema,
} from "@/modules/purchases/purchase.schemas"
import {
  createPurchase,
  getPurchase,
  listPurchases,
} from "@/modules/purchases/purchase.service"

export const dynamic = "force-dynamic"

/** GET — historial de compras con filtros (sesión, mesa, jugador, tipo, estado, fecha, cajero, socio, método, crédito). */
export const GET = withApiHandler(async (req, { requestId }) => {
  await requirePermission(PERMISSIONS.PURCHASES_READ, {
    requestId,
    resource: "GET /api/purchases",
  })
  const query = parseQueryParams(req.nextUrl.searchParams, purchasesQuerySchema)
  return ok(await listPurchases(query), { requestId })
})

/**
 * POST — crea el BORRADOR de una compra por IMPORTE (sin denominaciones).
 * Solo recibe participación, importe, notas y clave: sesión, mesa, ciclo,
 * jugador, folio y responsable los deriva el servidor. No descuenta
 * inventario ni registra dinero.
 */
export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.PURCHASES_CREATE, {
    requestId,
    resource: "POST /api/purchases",
  })
  const input = await parseJsonBody(req, createPurchaseSchema)
  const result = await createPurchase(actor, input, { requestId })
  return ok(await getPurchase(result.purchaseId), {
    status: result.replayed ? 200 : 201,
    message: "Compra iniciada",
    requestId,
  })
})
