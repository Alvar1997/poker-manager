import { NextResponse } from "next/server"

import { withApiHandler } from "@/lib/api-handler"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { renderSpecialReceiptPng } from "@/modules/special-operations/special-evidence"
import { parseIdParam } from "@/modules/special-operations/special.schemas"

export const dynamic = "force-dynamic"

/** GET — PNG del comprobante complementario (desde su snapshot inmutable; sin PDF). */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.SPECIAL_OPS_READ, {
      requestId,
      resource: "GET /api/special-operations/receipts/:id/image",
    })
    const { png, filename } = await renderSpecialReceiptPng(
      await parseIdParam(params)
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
