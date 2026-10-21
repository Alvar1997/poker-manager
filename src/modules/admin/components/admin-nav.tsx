"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { cn } from "@/lib/utils"

export type AdminTab = { slug: string; label: string }

/** Pestañas visibles según permisos (el servidor vuelve a autorizar cada página). */
export function AdminNav({ tabs }: { tabs: AdminTab[] }) {
  const pathname = usePathname()
  const base = "/dashboard/administracion"
  const current =
    pathname === base
      ? ""
      : (pathname.slice(base.length + 1).split("/")[0] ?? "")
  return (
    <nav
      aria-label="Administración"
      className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0"
    >
      <ol className="flex gap-2 pb-1 text-xs">
        {tabs.map((t) => (
          <li key={t.slug}>
            <Link
              href={t.slug ? `${base}/${t.slug}` : base}
              data-testid={`admin-tab-${t.slug || "panel"}`}
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
