/**
 * Matriz central de roles y permisos — ÚNICA fuente de verdad.
 *
 * Este archivo es puro (sin dependencias de servidor) para que la misma
 * definición alimente tanto la autorización en el servidor
 * (src/config/permissions.ts) como la navegación por capacidades
 * (src/config/navigation.ts). La navegación solo decide qué se MUESTRA;
 * lo que se PERMITE siempre lo decide el servidor con esta misma matriz.
 *
 * Política (ver docs/ROLES_AND_PERMISSIONS.md):
 * - SUPERADMIN: todos los permisos.
 * - PARTNER: mismas capacidades operativas, financieras, históricas y de
 *   consulta que SUPERADMIN, excepto administración de usuarios/roles,
 *   seguridad y configuración crítica.
 * - CASHIER: lo necesario para operar la sesión y la caja, sin acceso
 *   administrativo ni a reportes financieros globales.
 * - Todo permiso no asignado explícitamente está DENEGADO.
 *
 * Los permisos de un rol no eximen de las reglas de negocio: un permiso
 * dice "puede intentar esta acción"; el servicio de cada módulo valida
 * además el estado de la operación (p. ej. sesión cerrada → no editable).
 */

export const ROLES = ["SUPERADMIN", "PARTNER", "CASHIER"] as const

export type Role = (typeof ROLES)[number]

export const ROLE_LABEL: Record<Role, string> = {
  SUPERADMIN: "Superadmin",
  PARTNER: "Socio",
  CASHIER: "Cajero",
}

export const PERMISSIONS = {
  // Administración de usuarios y seguridad (reservado a SUPERADMIN).
  USERS_READ: "users:read",
  USERS_CREATE: "users:create",
  USERS_UPDATE: "users:update",
  USERS_DISABLE: "users:disable",
  USERS_RESET_PASSWORD: "users:reset-password",
  ROLES_MANAGE: "roles:manage",
  SETTINGS_MANAGE: "settings:manage",
  AUDIT_SECURITY_READ: "audit:security-read",

  // Configuración (Módulo 02). SETTINGS_READ: toda la configuración no
  // secreta (caja, cuenta bancaria enmascarada, folios, WhatsApp).
  // CATALOGS_READ: catálogos necesarios para operar (parámetros generales,
  // mesas, juegos de fichas, denominaciones, métodos de pago, reglas).
  SETTINGS_READ: "settings:read",
  CATALOGS_READ: "catalogs:read",

  // Dashboard.
  DASHBOARD_VIEW: "dashboard:view",
  DASHBOARD_FINANCIAL: "dashboard:financial",

  // Sesiones y mesas (apertura, arqueos, cierre).
  SESSIONS_READ: "sessions:read",
  SESSIONS_MANAGE: "sessions:manage",

  // Jugadores.
  PLAYERS_READ: "players:read",
  PLAYERS_MANAGE: "players:manage",

  // Caja central.
  CASH_READ: "cash:read",
  CASH_OPERATE: "cash:operate",

  // Compras y recompras.
  PURCHASES_READ: "purchases:read",
  PURCHASES_CREATE: "purchases:create",

  // Créditos, deudas, cobros y abonos.
  CREDITS_READ: "credits:read",
  CREDITS_OPERATE: "credits:operate",

  // Liquidaciones (incluye compensación FIFO automática).
  SETTLEMENTS_READ: "settlements:read",
  SETTLEMENTS_OPERATE: "settlements:operate",

  // Inventario y entregas de fichas.
  CHIPS_READ: "chips:read",
  CHIPS_OPERATE: "chips:operate",

  // Firmas y comprobantes de entrega.
  SIGNATURES_READ: "signatures:read",
  SIGNATURES_CAPTURE: "signatures:capture",

  // Correcciones operativas auditadas sobre sesiones cerradas.
  CORRECTIONS_OPERATE: "corrections:operate",

  // Reportes.
  REPORTS_VIEW: "reports:view",
  REPORTS_FINANCIAL: "reports:financial",

  // Auditoría de operaciones.
  AUDIT_READ: "audit:read",
} as const

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS]

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS)

/** Permisos reservados a SUPERADMIN: administración, seguridad y configuración crítica. */
export const ADMIN_ONLY_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.USERS_READ,
  PERMISSIONS.USERS_CREATE,
  PERMISSIONS.USERS_UPDATE,
  PERMISSIONS.USERS_DISABLE,
  PERMISSIONS.USERS_RESET_PASSWORD,
  PERMISSIONS.ROLES_MANAGE,
  PERMISSIONS.SETTINGS_MANAGE,
  PERMISSIONS.AUDIT_SECURITY_READ,
]

const CASHIER_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.CATALOGS_READ,
  PERMISSIONS.DASHBOARD_VIEW,
  PERMISSIONS.SESSIONS_READ,
  PERMISSIONS.SESSIONS_MANAGE,
  PERMISSIONS.PLAYERS_READ,
  PERMISSIONS.PLAYERS_MANAGE,
  PERMISSIONS.CASH_READ,
  PERMISSIONS.CASH_OPERATE,
  PERMISSIONS.PURCHASES_READ,
  PERMISSIONS.PURCHASES_CREATE,
  PERMISSIONS.CREDITS_READ,
  PERMISSIONS.CREDITS_OPERATE,
  PERMISSIONS.SETTLEMENTS_READ,
  PERMISSIONS.SETTLEMENTS_OPERATE,
  PERMISSIONS.CHIPS_READ,
  PERMISSIONS.CHIPS_OPERATE,
  PERMISSIONS.SIGNATURES_READ,
  PERMISSIONS.SIGNATURES_CAPTURE,
]

export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> =
  {
    SUPERADMIN: new Set(ALL_PERMISSIONS),
    PARTNER: new Set(
      ALL_PERMISSIONS.filter((p) => !ADMIN_ONLY_PERMISSIONS.includes(p))
    ),
    CASHIER: new Set(CASHIER_PERMISSIONS),
  }

/** Denegado por defecto: un rol desconocido o un permiso no asignado devuelve false. */
export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false
}

export function permissionsForRole(role: Role): Permission[] {
  return [...(ROLE_PERMISSIONS[role] ?? [])]
}
