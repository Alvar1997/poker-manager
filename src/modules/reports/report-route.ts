import "server-only"

import type { NextRequest } from "next/server"

import { PERMISSIONS, type Permission } from "@/config/permission-matrix"
import { requirePermission } from "@/config/permissions"
import { ValidationError } from "@/lib/errors"
import {
  parseReportFilters,
  type ReportFilters,
  type ReportKind,
} from "@/modules/reports/report.filters"

/**
 * Autorización + validación comunes de los endpoints de reportes
 * (Módulo 14): primero el permiso (401/403), luego los filtros (400).
 * Los reportes financieros exigen `reports:financial`; los operativos
 * `reports:view`. Los tres roles tienen ambos (DEC-06..08).
 */
export const REPORT_PERMISSION: Record<ReportKind, Permission> = {
  dashboard: PERMISSIONS.REPORTS_FINANCIAL,
  sessions: PERMISSIONS.REPORTS_VIEW,
  tables: PERMISSIONS.REPORTS_VIEW,
  purchases: PERMISSIONS.REPORTS_VIEW,
  players: PERMISSIONS.REPORTS_VIEW,
  chips: PERMISSIONS.REPORTS_VIEW,
  comparisons: PERMISSIONS.REPORTS_FINANCIAL,
  financial: PERMISSIONS.REPORTS_FINANCIAL,
  credits: PERMISSIONS.REPORTS_FINANCIAL,
  payments: PERMISSIONS.REPORTS_FINANCIAL,
  settlements: PERMISSIONS.REPORTS_FINANCIAL,
  // Módulo 18
  rake: PERMISSIONS.REPORTS_VIEW,
  tips: PERMISSIONS.REPORTS_FINANCIAL,
  nominal: PERMISSIONS.REPORTS_VIEW,
}

export function filtersOrThrow(
  kind: ReportKind,
  params: URLSearchParams
): ReportFilters {
  const parsed = parseReportFilters(kind, Object.fromEntries(params.entries()))
  if (!parsed.ok) throw new ValidationError("Filtros inválidos", parsed.issues)
  return parsed.filters
}

export async function authorizeReport(
  kind: ReportKind,
  req: NextRequest,
  requestId: string
) {
  const user = await requirePermission(REPORT_PERMISSION[kind], {
    requestId,
    resource: `GET ${req.nextUrl.pathname}`,
  })
  return { user, filters: filtersOrThrow(kind, req.nextUrl.searchParams) }
}

const ID = /^[A-Za-z0-9_-]{1,64}$/

export function assertId(value: string, label = "Identificador") {
  if (!ID.test(value)) throw new ValidationError(`${label} inválido`)
  return value
}
