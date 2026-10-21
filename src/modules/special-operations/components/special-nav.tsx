"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { cn } from "@/lib/utils"

const BASE = "/dashboard/operaciones-especiales"
const TABS = [
  { slug: "", label: "Panel" },
  { slug: "canjes", label: "Canjes" },
  { slug: "reversos-compras", label: "Reversos de compras" },
  {
    slug: "correcciones-liquidaciones",
    label: "Correcciones de liquidaciones",
  },
  { slug: "fondos-no-aplicados", label: "Fondos no aplicados" },
]

/** Pestañas de Operaciones especiales (cada página vuelve a autorizar). */
export function SpecialNav() {
  const pathname = usePathname()
  const current =
    pathname === BASE
      ? ""
      : (pathname.slice(BASE.length + 1).split("/")[0] ?? "")
  return (
    <nav
      aria-label="Operaciones especiales"
      className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0"
    >
      <ol className="flex gap-2 pb-1 text-xs">
        {TABS.map((t) => (
          <li key={t.slug}>
            <Link
              href={t.slug ? `${BASE}/${t.slug}` : BASE}
              data-testid={`special-tab-${t.slug || "panel"}`}
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
