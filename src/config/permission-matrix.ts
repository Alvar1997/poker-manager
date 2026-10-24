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
 *   administrativo. Desde el Módulo 14 consulta TODOS los reportes
 *   operativos y financieros y exporta XLSX (decisión DEC-08).
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
  // Recuperación protegida y modo mantenimiento (Módulo 15).
  RECOVERY_MANAGE: "recovery:manage",

  // Configuración (Módulo 02). SETTINGS_READ: toda la configuración no
  // secreta (caja, cuenta bancaria enmascarada, folios, WhatsApp).
  // CATALOGS_READ: catálogos necesarios para operar (parámetros generales,
  // mesas, juegos de fichas, denominaciones, métodos de pago, reglas).
  SETTINGS_READ: "settings:read",
  CATALOGS_READ: "catalogs:read",

  // Dashboard.
  DASHBOARD_VIEW: "dashboard:view",
  DASHBOARD_FINANCIAL: "dashboard:financial",

  // Sesiones y mesas (apertura, arqueos, preparación del cierre).
  SESSIONS_READ: "sessions:read",
  SESSIONS_MANAGE: "sessions:manage",
  // Cierre DEFINITIVO de una sesión (CLOSING → CLOSED) y autorización de
  // ajustes excepcionales de diferencias de arqueo (Módulo 12, DEC-04).
  // Solo PARTNER y SUPERADMIN: CASHIER prepara el cierre pero no lo confirma.
  SESSIONS_CLOSE_AUTHORIZE: "sessions:close-authorize",
  // Módulo 18 (decisión del propietario): CONFIRMAR el cierre definitivo,
  // incluso con diferencias de fichas (motivo obligatorio, sin ajustes). Los
  // TRES roles. Los ajustes excepcionales y la conciliación especial siguen
  // en `sessions:close-authorize`.
  SESSIONS_CLOSE_CONFIRM: "sessions:close-confirm",
  // Registrar sesiones de una fecha operativa ANTERIOR (captura histórica).
  // Exclusivo de SUPERADMIN: sin caja, inventario ni operación en vivo.
  SESSIONS_HISTORICAL_CREATE: "sessions:historical-create",

  // Jugadores (Módulo 03). PLAYERS_MANAGE = activar/desactivar.
  // El historial de teléfonos y la auditoría del jugador (datos personales
  // históricos) exigen AUDIT_READ.
  PLAYERS_READ: "players:read",
  PLAYERS_CREATE: "players:create",
  PLAYERS_UPDATE: "players:update",
  PLAYERS_MANAGE: "players:manage",
  PLAYERS_CONSENT: "players:consent",
  // Historial de teléfonos (dato personal histórico): PARTNER y SUPERADMIN.
  // Desde el Módulo 15 ya no depende de `audit:read` (que tiene CASHIER).
  PLAYERS_HISTORY_READ: "players:history",

  // Caja central.
  CASH_READ: "cash:read",
  CASH_OPERATE: "cash:operate",

  // Compras y recompras.
  PURCHASES_READ: "purchases:read",
  PURCHASES_CREATE: "purchases:create",

  // Créditos, deudas, cobros y abonos.
  CREDITS_READ: "credits:read",
  CREDITS_OPERATE: "credits:operate",

  // Liquidaciones: devolución nominal, firma, compensación OPCIONAL (si se
  // compensa, FIFO automático) y pagos al jugador.
  SETTLEMENTS_READ: "settlements:read",
  SETTLEMENTS_OPERATE: "settlements:operate",

  // Inventario y entregas de fichas.
  CHIPS_READ: "chips:read",
  CHIPS_OPERATE: "chips:operate",

  // Firmas y comprobantes de entrega.
  SIGNATURES_READ: "signatures:read",
  SIGNATURES_CAPTURE: "signatures:capture",

  // Correcciones financieras excepcionales (Módulo 15). OPERATE = AUTORIZAR
  // (aprobar/rechazar, enlazar la ejecución real): solo PARTNER y SUPERADMIN.
  // REQUEST: los tres roles solicitan y comentan (DEC-04/05).
  CORRECTIONS_OPERATE: "corrections:operate",
  CORRECTIONS_REQUEST: "corrections:request",

  // Integridad e incidencias (Módulo 15). El diagnóstico es de solo lectura.
  // Operaciones financieras especiales (Módulo 16). READ/OPERATE: los tres
  // roles consultan, solicitan, reciben fichas, ejecutan lo YA autorizado y
  // registran pagos reales. AUTHORIZE (validar el valor de un canje): solo
  // PARTNER y SUPERADMIN (las demás autorizaciones usan CORRECTIONS_OPERATE).
  SPECIAL_OPS_READ: "special-ops:read",
  SPECIAL_OPS_OPERATE: "special-ops:operate",
  SPECIAL_OPS_AUTHORIZE: "special-ops:authorize",

  INTEGRITY_RUN: "integrity:run",
  INCIDENTS_MANAGE: "incidents:manage",
  INCIDENTS_RESOLVE: "incidents:resolve",

  // Infraestructura (Módulo 15): NO se concede por consultar auditoría.
  BACKUPS_READ: "backups:read",
  SYSTEM_HEALTH_READ: "system:health",

  // Reportes (Módulo 14, DEC-06..08): los TRES roles consultan los reportes
  // operativos y financieros y exportan XLSX. Son de solo lectura.
  REPORTS_VIEW: "reports:view",
  REPORTS_FINANCIAL: "reports:financial",
  REPORTS_EXPORT: "reports:export",

  // Auditoría de operaciones (Módulo 15: los TRES roles, DEC-01..03).
  AUDIT_READ: "audit:read",

  // Jugadores bancados por la casa (Módulo 17, PRIVADO). READ/OPERATE: los
  // tres roles consultan lo necesario, registran compras financiadas,
  // conciliaciones, anticipos con autorización verbal/mensaje, solicitudes
  // y pagos reales, y preparan cortes. APPROVE (aprobación DIGITAL de
  // acuerdos, cambios de porcentaje, cortes, retiros de reserva y
  // regularizaciones): solo PARTNER y SUPERADMIN.
  BANKING_READ: "banking:read",
  BANKING_OPERATE: "banking:operate",
  BANKING_APPROVE: "banking:approve",

  // Rake, staff y propinas (Módulo 18, simplificado). OPERATE: los tres
  // roles registran rake, conteos, staff de la sesión, propinas y
  // correcciones con motivo. AUTHORIZE: cambiar la modalidad de rake de una
  // mesa (configuración; PARTNER y SUPERADMIN).
  RAKE_READ: "rake:read",
  RAKE_OPERATE: "rake:operate",
  RAKE_AUTHORIZE: "rake:authorize",
  STAFF_READ: "staff:read",
  STAFF_MANAGE: "staff:manage",
  TIPS_OPERATE: "tips:operate",
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
  // Recuperación de producción y modo mantenimiento (DEC-11).
  PERMISSIONS.RECOVERY_MANAGE,
  // Captura de sesiones de fechas anteriores.
  PERMISSIONS.SESSIONS_HISTORICAL_CREATE,
]

const CASHIER_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.CATALOGS_READ,
  PERMISSIONS.DASHBOARD_VIEW,
  PERMISSIONS.SESSIONS_READ,
  PERMISSIONS.SESSIONS_MANAGE,
  PERMISSIONS.PLAYERS_READ,
  PERMISSIONS.PLAYERS_CREATE,
  PERMISSIONS.PLAYERS_UPDATE,
  PERMISSIONS.PLAYERS_MANAGE,
  PERMISSIONS.PLAYERS_CONSENT,
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
  PERMISSIONS.REPORTS_VIEW,
  PERMISSIONS.REPORTS_FINANCIAL,
  PERMISSIONS.REPORTS_EXPORT,
  // Módulo 15: consulta toda la auditoría, solicita correcciones (no las
  // autoriza), ejecuta el diagnóstico y registra incidencias.
  PERMISSIONS.AUDIT_READ,
  PERMISSIONS.CORRECTIONS_REQUEST,
  PERMISSIONS.INTEGRITY_RUN,
  PERMISSIONS.INCIDENTS_MANAGE,
  // Módulo 16: solicita y ejecuta lo autorizado; nunca autoriza.
  PERMISSIONS.SPECIAL_OPS_READ,
  PERMISSIONS.SPECIAL_OPS_OPERATE,
  // Módulo 17: opera el bancaje; nunca aprueba digitalmente.
  PERMISSIONS.BANKING_READ,
  PERMISSIONS.BANKING_OPERATE,
  // Módulo 18: opera rake y propinas y confirma el cierre (también con
  // diferencias de fichas, con motivo).
  PERMISSIONS.SESSIONS_CLOSE_CONFIRM,
  PERMISSIONS.RAKE_READ,
  PERMISSIONS.RAKE_OPERATE,
  PERMISSIONS.STAFF_READ,
  PERMISSIONS.STAFF_MANAGE,
  PERMISSIONS.TIPS_OPERATE,
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
