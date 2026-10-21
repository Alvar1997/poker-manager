import { Suspense, type ReactNode } from "react"

import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { REPORTS_BASE } from "@/modules/reports/components/report-ui"
import { ReportsNav } from "@/modules/reports/components/report-nav"
import { FilterMemory } from "@/modules/reports/components/report-filters"

/** Reportes (Módulo 14): solo lectura para SUPERADMIN, PARTNER y CASHIER. */
export default async function ReportsLayout({
  children,
}: {
  children: ReactNode
}) {
  await requirePagePermission(PERMISSIONS.REPORTS_VIEW, REPORTS_BASE)
  return (
    <div className="mx-auto max-w-5xl space-y-4 pb-8">
      <ReportsNav />
      <Suspense fallback={null}>
        <FilterMemory />
      </Suspense>
      {children}
    </div>
  )
}
