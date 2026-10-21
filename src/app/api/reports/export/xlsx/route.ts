import { NextResponse } from "next/server"

import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { withApiHandler } from "@/lib/api-handler"
import { ValidationError } from "@/lib/errors"
import { REPORT_KINDS, type ReportKind } from "@/modules/reports/report.filters"
import {
  filtersOrThrow,
  REPORT_PERMISSION,
} from "@/modules/reports/report-route"
import {
  buildReportXlsx,
  XLSX_CONTENT_TYPE,
} from "@/modules/reports/xlsx-export.service"

export const dynamic = "force-dynamic"

/**
 * GET — exportación XLSX (única opción: sin CSV ni PDF). Exige
 * `reports:export` y el permiso de lectura del reporte; respeta los filtros
 * validados y se audita (éxito o error).
 */
export const GET = withApiHandler(async (req, { requestId }) => {
  const resource = "GET /api/reports/export/xlsx"
  const user = await requirePermission(PERMISSIONS.REPORTS_EXPORT, {
    requestId,
    resource,
  })
  const params = new URLSearchParams(req.nextUrl.searchParams)
  const report = params.get("report") ?? ""
  params.delete("report")
  params.delete("format")
  const format = req.nextUrl.searchParams.get("format")
  if (format && format.toLowerCase() !== "xlsx")
    throw new ValidationError("Solo se exporta en formato XLSX")
  if (!REPORT_KINDS.includes(report as ReportKind))
    throw new ValidationError("Reporte no válido para exportar")
  const kind = report as ReportKind
  await requirePermission(REPORT_PERMISSION[kind], { requestId, resource })
  const filters = filtersOrThrow(kind, params)
  const { buffer, fileName } = await buildReportXlsx(
    kind,
    filters,
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
