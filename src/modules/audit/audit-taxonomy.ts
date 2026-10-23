/**
 * Taxonomía de la auditoría transversal (Módulo 15). Puro.
 *
 * Deriva el MÓDULO de origen de cada acción (por prefijo, de lo más
 * específico a lo más general) para filtrar y para separar lo que la
 * autorización general de auditoría NO muestra: eventos de seguridad
 * (inicios de sesión, IPs) e infraestructura (respaldos, recuperación).
 */

export const AUDIT_MODULES = [
  "SECURITY",
  "USERS",
  "CONFIGURATION",
  "PLAYERS",
  "INVENTORY",
  "CASH",
  "SESSIONS",
  "TABLES",
  "PURCHASES",
  "SIGNATURES",
  "CREDITS",
  "SETTLEMENTS",
  "CLOSURE",
  "REPORTS",
  "ADMINISTRATION",
  "INFRASTRUCTURE",
  "SPECIAL_OPERATIONS",
] as const

export type AuditModule = (typeof AUDIT_MODULES)[number]

export const AUDIT_MODULE_LABEL: Record<AuditModule, string> = {
  SECURITY: "Seguridad y accesos",
  USERS: "Usuarios (M01)",
  CONFIGURATION: "Configuración (M02)",
  PLAYERS: "Jugadores (M03)",
  INVENTORY: "Inventario (M04)",
  CASH: "Caja (M05)",
  SESSIONS: "Sesiones (M06)",
  TABLES: "Mesas (M07)",
  PURCHASES: "Compras (M08)",
  SIGNATURES: "Firmas y comprobantes (M09)",
  CREDITS: "Créditos y abonos (M10)",
  SETTLEMENTS: "Liquidaciones (M11)",
  CLOSURE: "Cierre (M12)",
  REPORTS: "Reportes (M14)",
  ADMINISTRATION: "Administración (M15)",
  INFRASTRUCTURE: "Respaldos y recuperación (M15)",
  SPECIAL_OPERATIONS: "Operaciones especiales (M16)",
}

/** Reglas ordenadas: el primer prefijo que coincide gana. */
const RULES: [string, AuditModule][] = [
  // Módulo 16 antes que compras/liquidaciones/créditos genéricos.
  ["LATE_REDEMPTION_", "SPECIAL_OPERATIONS"],
  ["PURCHASE_REVERSAL_", "SPECIAL_OPERATIONS"],
  ["SETTLEMENT_CORRECTION_", "SPECIAL_OPERATIONS"],
  ["UNAPPLIED_FUNDS_", "SPECIAL_OPERATIONS"],
  ["SPECIAL_", "SPECIAL_OPERATIONS"],
  ["AUTH_", "SECURITY"],
  ["USER_", "USERS"],
  ["SETTINGS_", "CONFIGURATION"],
  ["CHIP_SET_", "CONFIGURATION"],
  ["CHIP_DENOMINATION_", "CONFIGURATION"],
  ["PAYMENT_METHOD_", "CONFIGURATION"],
  ["BANK_ACCOUNT_", "CONFIGURATION"],
  ["FOLIO_", "CONFIGURATION"],
  ["TABLE_CREATED", "CONFIGURATION"],
  ["TABLE_UPDATED", "CONFIGURATION"],
  ["TABLE_ACTIVATED", "CONFIGURATION"],
  ["TABLE_DEACTIVATED", "CONFIGURATION"],
  ["PLAYER_DEBT", "CREDITS"],
  ["PLAYER_SEATED", "TABLES"],
  ["SEAT_", "TABLES"],
  ["DEALER_", "TABLES"],
  ["PLAYER_", "PLAYERS"],
  // Cierre (Módulo 12) antes que inventario/caja genéricos.
  ["TABLE_CYCLE_CLOSED", "CLOSURE"],
  ["CLOSURE_", "CLOSURE"],
  ["SESSION_CLOSING", "CLOSURE"],
  ["SESSION_RETURNED", "CLOSURE"],
  ["SESSION_CLOSURE", "CLOSURE"],
  ["SESSION_CLOSED", "CLOSURE"],
  ["INVENTORY_FINAL", "CLOSURE"],
  ["INVENTORY_DISCREPANCY", "CLOSURE"],
  ["INVENTORY_ADJUSTMENT_AUTHORIZED", "CLOSURE"],
  ["OUTSTANDING_CHIP", "CLOSURE"],
  ["CASH_FINAL", "CLOSURE"],
  ["CASH_DISCREPANCY", "CLOSURE"],
  ["CASH_ADJUSTMENT_AUTHORIZED", "CLOSURE"],
  ["CASH_WITHDRAWAL_CONFIRMED", "CLOSURE"],
  ["CHIP_", "INVENTORY"],
  ["INVENTORY_", "INVENTORY"],
  ["SESSION_TABLE", "TABLES"],
  ["TABLE_", "TABLES"],
  ["SESSION_", "SESSIONS"],
  ["SETTLEMENT_", "SETTLEMENTS"],
  ["PURCHASE_", "PURCHASES"],
  ["TERMINAL_PAYMENT", "PURCHASES"],
  ["SIGNATURE_", "SIGNATURES"],
  ["RECEIPT_", "SIGNATURES"],
  ["EVIDENCE_", "SIGNATURES"],
  ["RECEIVABLE_", "CREDITS"],
  ["PAYMENT_", "CREDITS"],
  ["UNAPPLIED_", "CREDITS"],
  ["ADMINISTRATIVE_CASH", "CREDITS"],
  ["CARD_TERMINAL", "CASH"],
  ["BANK_TRANSFER", "CASH"],
  ["CASH_", "CASH"],
  ["REPORT_", "REPORTS"],
  ["BACKUP_", "INFRASTRUCTURE"],
  ["RESTORE_", "INFRASTRUCTURE"],
  ["RECOVERY_", "INFRASTRUCTURE"],
  ["MAINTENANCE_", "INFRASTRUCTURE"],
  ["CORRECTION_", "ADMINISTRATION"],
  ["INTEGRITY_", "ADMINISTRATION"],
  ["INCIDENT_", "ADMINISTRATION"],
]

export function moduleOfAction(action: string): AuditModule {
  for (const [prefix, module] of RULES)
    if (action.startsWith(prefix)) return module
  return "ADMINISTRATION"
}

/** Módulos fuera de la autorización GENERAL de auditoría (DEC-01..03, §8). */
export const RESTRICTED_MODULES: Record<
  "SECURITY" | "INFRASTRUCTURE",
  "security" | "infrastructure"
> = { SECURITY: "security", INFRASTRUCTURE: "infrastructure" }

const MONEY = /^-?\d{1,12}(\.\d{1,2})?$/

/**
 * Columnas derivadas de un evento a partir de sus metadatos (no se
 * inventa nada: si el dato no viene, queda null).
 */
export function deriveAuditColumns(
  action: string,
  metadata: Record<string, unknown> | undefined
) {
  const m = metadata ?? {}
  const str = (k: string) => {
    const v = m[k]
    return typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null
  }
  const amountRaw = [
    "amount",
    "nominalAmount",
    "returnedNominalAmount",
    "offsetAmount",
  ]
    .map((k) => m[k])
    .find((v) => typeof v === "string" && MONEY.test(v)) as string | undefined
  return {
    module: moduleOfAction(action),
    sessionId: str("sessionId"),
    playerId: str("playerId"),
    tableCycleId: str("cycleId") ?? str("tableCycleId"),
    idempotencyKey: str("idempotencyKey"),
    reason: str("reason")?.slice(0, 500) ?? null,
    amount: amountRaw ?? null,
    evidenceRef: str("fileId") ?? str("storedFileId"),
  }
}

/** Claves cuyo VALOR se enmascara (no se eliminan: se conserva la traza). */
const MASK_KEY = /clabe|accountNumber|cardNumber|pan$/i

export function maskValue(key: string, value: unknown): unknown {
  if (!MASK_KEY.test(key) || typeof value !== "string") return value
  const digits = value.replace(/\D/g, "")
  return digits.length <= 4 ? "••••" : `••••${digits.slice(-4)}`
}
