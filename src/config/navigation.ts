import type { LucideIcon } from "lucide-react"
import { LayoutDashboard } from "lucide-react"

import type { Role } from "@/config/permissions"

export type NavItem = {
  label: string
  href: string
  icon: LucideIcon
  /** Roles que pueden ver este item. Si se omite, todos los roles autenticados. */
  roles?: readonly Role[]
}

/**
 * Navegación del dashboard. Se irá ampliando en cada módulo (mesas,
 * caja, jugadores, reportes…) — ver docs/MODULES.md para el checklist
 * completo. En Módulo 00 solo existe la entrada raíz.
 */
export const dashboardNav: readonly NavItem[] = [
  {
    label: "Inicio",
    href: "/dashboard",
    icon: LayoutDashboard,
  },
]
