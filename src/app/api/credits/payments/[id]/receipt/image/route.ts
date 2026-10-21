import { NextResponse } from "next/server"

import { withApiHandler } from "@/lib/api-handler"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseIdParam } from "@/modules/credits/credit.schemas"
import {
  recordCreditReceiptEvent,
  renderCreditReceiptPng,
} from "@/modules/credits/credit-receipt.service"

export const dynamic = "force-dynamic"

/** GET — PNG del comprobante de abono (descarga). Sin PDF. */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.CREDITS_READ, {
      requestId,
      resource: "GET /api/credits/payments/:id/receipt/image",
    })
    const id = await parseIdParam(params)
    const { png, folio } = await renderCreditReceiptPng(id)
    await recordCreditReceiptEvent(
      actor,
      id,
      "DOWNLOADED",
      { format: "PNG" },
      { requestId }
    )
    return new NextResponse(new Uint8Array(png), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Disposition": `attachment; filename="abono-${folio}.png"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "x-request-id": requestId,
      },
    })
  }
)
