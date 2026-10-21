"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { cn } from "@/lib/utils"
import {
  REPORT_TABS,
  REPORTS_BASE,
} from "@/modules/reports/components/report-tabs"

export function ReportsNav() {
  const pathname = usePathname()
  const current =
    pathname === REPORTS_BASE
      ? ""
      : (pathname.slice(REPORTS_BASE.length + 1).split("/")[0] ?? "")
  return (
    <nav
      aria-label="Reportes"
      className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0"
    >
      <ol className="flex gap-2 pb-1 text-xs">
        {REPORT_TABS.map((t) => (
          <li key={t.slug}>
            <Link
              href={t.slug ? `${REPORTS_BASE}/${t.slug}` : REPORTS_BASE}
              data-testid={`report-tab-${t.slug || "dashboard"}`}
              aria-current={current === t.slug ? "page" : undefined}
              className={cn(
                "inline-flex min-h-9 items-center rounded-full border px-3 whitespace-nowrap",
                current === t.slug && "bg-primary text-primary-foreground"
              )}
            >
              {t.label}
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  )
}
