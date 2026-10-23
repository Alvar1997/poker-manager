"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { cn } from "@/lib/utils"

import { BANKING_BASE } from "./labels"

const TABS = [
  { slug: "", label: "Panel" },
  { slug: "jugadores", label: "Jugadores" },
  { slug: "acuerdos", label: "Acuerdos" },
  { slug: "ciclos", label: "Ciclos" },
  { slug: "anticipos", label: "Anticipos" },
  { slug: "reservas", label: "Reservas" },
  { slug: "retiros", label: "Retiros" },
  { slug: "cortes", label: "Cortes" },
  { slug: "regularizaciones", label: "Regularizaciones" },
]

/** Pestañas de la sección PRIVADA de bancaje (cada página vuelve a autorizar). */
export function BankingNav() {
  const pathname = usePathname()
  const current =
    pathname === BANKING_BASE
      ? ""
      : (pathname.slice(BANKING_BASE.length + 1).split("/")[0] ?? "")
  return (
    <nav
      aria-label="Bancaje"
      className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0"
    >
      <ol className="flex gap-2 pb-1 text-xs">
        {TABS.map((t) => (
          <li key={t.slug}>
            <Link
              href={t.slug ? `${BANKING_BASE}/${t.slug}` : BANKING_BASE}
              data-testid={`banking-tab-${t.slug || "panel"}`}
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
