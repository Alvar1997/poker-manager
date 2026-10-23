import { NextResponse } from "next/server"

import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { withApiHandler } from "@/lib/api-handler"
import { ValidationError } from "@/lib/errors"
import { buildBankingXlsx } from "@/modules/banking/banking-report.service"
import { XLSX_CONTENT_TYPE } from "@/modules/reports/xlsx-export.service"

export const dynamic = "force-dynamic"

/** GET — reporte PRIVADO de bancaje, exclusivamente XLSX (auditado). */
export const GET = withApiHandler(async (req, { requestId }) => {
  const resource = "GET /api/admin/banking/reports/export"
  const user = await requirePermission(PERMISSIONS.BANKING_READ, {
    requestId,
    resource,
  })
  await requirePermission(PERMISSIONS.REPORTS_EXPORT, { requestId, resource })
  const format = req.nextUrl.searchParams.get("format")
  if (format && format.toLowerCase() !== "xlsx")
    throw new ValidationError("Solo se exporta en formato XLSX")
  const { buffer, fileName } = await buildBankingXlsx(
    { id: user.id, name: user.name },
    { requestId }
  )
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": XLSX_CONTENT_TYPE,
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "x-request-id": requestId,
    },
  })
})
