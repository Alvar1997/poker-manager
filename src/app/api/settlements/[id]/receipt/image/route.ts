import { NextResponse } from "next/server"

import { withApiHandler } from "@/lib/api-handler"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import {
  parseOptionalId,
  parseSettlementIdParam,
} from "@/modules/settlements/settlement.schemas"
import {
  recordSettlementReceiptEvent,
  renderSettlementReceiptPng,
} from "@/modules/settlements/settlement-receipt.service"

export const dynamic = "force-dynamic"

/** GET — PNG del comprobante (recepción por defecto, o `?receiptId=` de un anexo). */
export const GET = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SETTLEMENTS_READ, {
      requestId,
      resource: "GET /api/settlements/:id/receipt/image",
    })
    const id = await parseSettlementIdParam(params)
    const receiptId = parseOptionalId(req.nextUrl.searchParams.get("receiptId"))
    const {
      png,
      filename,
      receiptId: rid,
    } = await renderSettlementReceiptPng(id, receiptId)
    await recordSettlementReceiptEvent(
      actor,
      id,
      rid,
      "DOWNLOADED",
      { format: "PNG" },
      { requestId }
    )
    return new NextResponse(new Uint8Array(png), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "x-request-id": requestId,
      },
    })
  }
)
