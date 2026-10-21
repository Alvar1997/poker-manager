import { NextResponse } from "next/server"

import { withApiHandler } from "@/lib/api-handler"
import { can, PERMISSIONS, requirePermission } from "@/config/permissions"
import { parsePurchaseIdParam } from "@/modules/purchases/purchase.schemas"
import { renderReceiptPng } from "@/modules/signatures/receipt-image"
import {
  getReceipt,
  recordReceiptEvent,
} from "@/modules/signatures/receipt.service"
import { deliverySignaturePng } from "@/modules/signatures/signature.service"

export const dynamic = "force-dynamic"

/**
 * GET — imagen PNG del comprobante (descarga). Generada en el servidor a
 * partir del snapshot confirmado; incluye la firma solo si el usuario puede
 * consultarla. No se genera PDF ni se envía nada.
 */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.PURCHASES_READ, {
      requestId,
      resource: "GET /api/purchases/:id/receipt/image",
    })
    const id = await parsePurchaseIdParam(params)
    const receipt = await getReceipt(id, actor)
    const signaturePng =
      receipt.hasSignature && can(actor, PERMISSIONS.SIGNATURES_READ)
        ? await deliverySignaturePng(id)
        : null
    const png = await renderReceiptPng({
      content: receipt.content,
      status: receipt.status,
      signaturePng,
    })
    await recordReceiptEvent(
      actor,
      id,
      "DOWNLOADED",
      { format: "PNG", includesSignature: Boolean(signaturePng) },
      { requestId }
    )
    return new NextResponse(new Uint8Array(png), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Disposition": `attachment; filename="comprobante-${receipt.content.folio}.png"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "x-request-id": requestId,
      },
    })
  }
)
