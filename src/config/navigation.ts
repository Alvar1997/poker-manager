import type { LucideIcon } from "lucide-react"
import {
  ArrowLeftRight,
  BarChart3,
  Coins,
  CreditCard,
  HandCoins,
  LayoutDashboard,
  ScrollText,
  Settings,
  ShoppingCart,
  UserCircle,
  Users,
  UsersRound,
  Wallet,
} from "lucide-react"

import {
  PERMISSIONS,
  roleHasPermission,
  type Permission,
  type Role,
} from "@/config/permission-matrix"

export type NavSection = "operation" | "finance" | "admin" | "account"

export const NAV_SECTION_LABEL: Record<NavSection, string> = {
  operation: "Operación",
  finance: "Finanzas y control",
  admin: "Administración",
  account: "Cuenta",
}

export type NavItem = {
  id: string
  label: string
  href: string
  icon: LucideIcon
  section: NavSection
  /** Capacidad requerida para VER la opción. Sin permiso → visible para cualquier usuario autenticado. */
  permission?: Permission
  /**
   * false = módulo aún no construido: se muestra como "Próximamente", sin
   * enlace ni acción (no aparenta operaciones inexistentes).
   */
  available: boolean
}

/**
 * Navegación centralizada por capacidades. Mostrar u ocultar una opción
 * es solo UX: cada página y endpoint vuelve a verificar el permiso en el
 * servidor. Al implementar un módulo, cambia `available` a true.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    id: "home",
    label: "Inicio",
    href: "/dashboard",
    icon: LayoutDashboard,
    section: "operation",
    permission: PERMISSIONS.DASHBOARD_VIEW,
    available: true,
  },
  {
    id: "sessions",
    label: "Sesiones y mesas",
    href: "/dashboard/sessions",
    icon: ArrowLeftRight,
    section: "operation",
    permission: PERMISSIONS.SESSIONS_READ,
    available: false,
  },
  {
    id: "players",
    label: "Jugadores",
    href: "/dashboard/players",
    icon: UsersRound,
    section: "operation",
    permission: PERMISSIONS.PLAYERS_READ,
    available: false,
  },
  {
    id: "purchases",
    label: "Compras y recompras",
    href: "/dashboard/purchases",
    icon: ShoppingCart,
    section: "operation",
    permission: PERMISSIONS.PURCHASES_READ,
    available: false,
  },
  {
    id: "chips",
    label: "Fichas",
    href: "/dashboard/chips",
    icon: Coins,
    section: "operation",
    permission: PERMISSIONS.CHIPS_READ,
    available: false,
  },
  {
    id: "cash",
    label: "Caja",
    href: "/dashboard/cash",
    icon: Wallet,
    section: "finance",
    permission: PERMISSIONS.CASH_READ,
    available: false,
  },
  {
    id: "credits",
    label: "Créditos y abonos",
    href: "/dashboard/credits",
    icon: CreditCard,
    section: "finance",
    permission: PERMISSIONS.CREDITS_READ,
    available: false,
  },
  {
    id: "settlements",
    label: "Liquidaciones",
    href: "/dashboard/settlements",
    icon: HandCoins,
    section: "finance",
    permission: PERMISSIONS.SETTLEMENTS_READ,
    available: false,
  },
  {
    id: "reports",
    label: "Reportes y ganancias",
    href: "/dashboard/reports",
    icon: BarChart3,
    section: "finance",
    permission: PERMISSIONS.REPORTS_FINANCIAL,
    available: false,
  },
  {
    id: "audit",
    label: "Auditoría",
    href: "/dashboard/audit",
    icon: ScrollText,
    section: "finance",
    permission: PERMISSIONS.AUDIT_READ,
    available: false,
  },
  {
    id: "users",
    label: "Usuarios",
    href: "/dashboard/users",
    icon: Users,
    section: "admin",
    permission: PERMISSIONS.USERS_READ,
    available: true,
  },
  {
    id: "settings",
    label: "Configuración",
    href: "/dashboard/settings",
    icon: Settings,
    section: "admin",
    permission: PERMISSIONS.SETTINGS_MANAGE,
    available: false,
  },
  {
    id: "profile",
    label: "Mi perfil",
    href: "/dashboard/profile",
    icon: UserCircle,
    section: "account",
    available: true,
  },
]

/** Opciones visibles para un rol (denegado por defecto: sin permiso, no aparece). */
export function navigationFor(role: Role): NavItem[] {
  return NAV_ITEMS.filter(
    (item) => !item.permission || roleHasPermission(role, item.permission)
  )
}
