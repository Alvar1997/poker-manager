"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import {
  NAV_SECTION_LABEL,
  navigationFor,
  type NavItem,
  type NavSection,
} from "@/config/navigation"
import type { Role } from "@/config/permission-matrix"
import { cn } from "@/lib/utils"

const SECTION_ORDER: NavSection[] = ["operation", "finance", "admin", "account"]

function isActive(pathname: string, href: string) {
  if (href === "/dashboard") return pathname === "/dashboard"
  return pathname === href || pathname.startsWith(`${href}/`)
}

/**
 * Lista de navegación filtrada por las capacidades del rol (calculadas
 * con la misma matriz que usa el servidor). Los módulos no construidos
 * aparecen como "Próximamente", sin enlace.
 */
export function AppNav({
  role,
  onNavigate,
}: {
  role: Role
  onNavigate?: () => void
}) {
  const pathname = usePathname()
  const items = navigationFor(role)

  return (
    <nav aria-label="Navegación principal" className="space-y-5">
      {SECTION_ORDER.map((section) => {
        const sectionItems = items.filter((item) => item.section === section)
        if (sectionItems.length === 0) return null

        return (
          <div key={section} className="space-y-1">
            <p className="text-muted-foreground px-3 text-xs font-medium tracking-wide uppercase">
              {NAV_SECTION_LABEL[section]}
            </p>
            <ul className="space-y-0.5">
              {sectionItems.map((item) => (
                <li key={item.id}>
                  <NavEntry
                    item={item}
                    active={isActive(pathname, item.href)}
                    onNavigate={onNavigate}
                  />
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </nav>
  )
}

function NavEntry({
  item,
  active,
  onNavigate,
}: {
  item: NavItem
  active: boolean
  onNavigate?: () => void
}) {
  const Icon = item.icon
  const base =
    "flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm md:min-h-9"

  if (!item.available) {
    return (
      <span
        aria-disabled="true"
        data-nav-id={item.id}
        className={cn(base, "text-muted-foreground/70 cursor-not-allowed")}
      >
        <Icon className="size-4" aria-hidden="true" />
        <span className="flex-1">{item.label}</span>
        <span className="bg-muted rounded px-1.5 py-0.5 text-[10px] font-medium uppercase">
          Próximamente
        </span>
      </span>
    )
  }

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      data-nav-id={item.id}
      aria-current={active ? "page" : undefined}
      className={cn(
        base,
        "hover:bg-muted",
        active && "bg-muted text-foreground font-medium"
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
      {item.label}
    </Link>
  )
}
