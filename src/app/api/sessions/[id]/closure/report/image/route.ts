import { NextResponse } from "next/server"

import { withApiHandler } from "@/lib/api-handler"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import {
  recordClosureReportEvent,
  renderClosureReportPng,
} from "@/modules/closure/closure.service"
import { parseSessionIdParam } from "@/modules/sessions/session.schemas"

export const dynamic = "force-dynamic"

/** GET — PNG del comprobante de cierre (sin PDF, sin enlaces públicos). */
export const GET = withApiHandler<{ id: string }>(
  async (_req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SESSIONS_READ, {
      requestId,
      resource: "GET /api/sessions/:id/closure/report/image",
    })
    const id = await parseSessionIdParam(params)
    const { png, filename } = await renderClosureReportPng(id)
    await recordClosureReportEvent(
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
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "x-request-id": requestId,
      },
    })
  }
)
