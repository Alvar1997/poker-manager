import type { LucideIcon } from "lucide-react"
import {
  ArrowLeftRight,
  BarChart3,
  Coins,
  CreditCard,
  FileWarning,
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
  admin: "Administración y configuración",
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
    href: "/dashboard/sesiones",
    icon: ArrowLeftRight,
    section: "operation",
    permission: PERMISSIONS.SESSIONS_READ,
    available: true,
  },
  {
    id: "players",
    label: "Jugadores",
    href: "/dashboard/jugadores",
    icon: UsersRound,
    section: "operation",
    permission: PERMISSIONS.PLAYERS_READ,
    available: true,
  },
  {
    id: "purchases",
    label: "Compras y recompras",
    href: "/dashboard/compras",
    icon: ShoppingCart,
    section: "operation",
    permission: PERMISSIONS.PURCHASES_READ,
    available: true,
  },
  {
    id: "chips",
    label: "Inventario de fichas",
    href: "/dashboard/inventario/fichas",
    icon: Coins,
    section: "operation",
    permission: PERMISSIONS.CHIPS_READ,
    available: true,
  },
  {
    id: "cash",
    label: "Caja",
    href: "/dashboard/caja",
    icon: Wallet,
    section: "finance",
    permission: PERMISSIONS.CASH_READ,
    available: true,
  },
  {
    id: "credits",
    label: "Créditos y abonos",
    href: "/dashboard/creditos",
    icon: CreditCard,
    section: "finance",
    permission: PERMISSIONS.CREDITS_READ,
    available: true,
  },
  {
    id: "settlements",
    label: "Liquidaciones",
    href: "/dashboard/liquidaciones",
    icon: HandCoins,
    section: "finance",
    permission: PERMISSIONS.SETTLEMENTS_READ,
    available: true,
  },
  {
    id: "special-operations",
    label: "Operaciones especiales",
    href: "/dashboard/operaciones-especiales",
    icon: FileWarning,
    section: "finance",
    // Módulo 16: canjes, reversos, correcciones y devoluciones.
    permission: PERMISSIONS.SPECIAL_OPS_READ,
    available: true,
  },
  {
    id: "reports",
    label: "Reportes",
    href: "/dashboard/reportes",
    icon: BarChart3,
    section: "finance",
    // Módulo 14: los tres roles consultan reportes (DEC-06..08).
    permission: PERMISSIONS.REPORTS_VIEW,
    available: true,
  },
  {
    id: "audit",
    label: "Administración y auditoría",
    href: "/dashboard/administracion",
    icon: ScrollText,
    section: "finance",
    // Módulo 15: los tres roles consultan la auditoría (DEC-01..03).
    permission: PERMISSIONS.AUDIT_READ,
    available: true,
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
    href: "/dashboard/configuracion",
    icon: Settings,
    section: "admin",
    // Los tres roles la ven (con secciones según permisos): CASHIER consulta
    // catálogos, PARTNER toda la configuración, solo SUPERADMIN edita.
    permission: PERMISSIONS.CATALOGS_READ,
    available: true,
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
