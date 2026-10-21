import { createHash } from "node:crypto"

/**
 * Configuración de respaldos (Módulo 15). Se lee de variables de entorno
 * del proceso que EJECUTA el respaldo (CLI / tarea programada), nunca del
 * navegador. Ningún valor secreto se devuelve: solo si está presente, la
 * huella de la clave y la lista de requisitos faltantes.
 *
 * Variables:
 *   BACKUP_STORAGE_DIR            destino (carpeta privada, idealmente un
 *                                 volumen externo o sincronizado fuera del
 *                                 equipo operativo)
 *   BACKUP_ENCRYPTION_KEY         32 bytes en base64 o 64 hex (AES-256-GCM);
 *                                 distinta de SETTINGS_ENCRYPTION_KEY
 *   BACKUP_SOURCE_DATABASE_URL    opcional; por defecto DIRECT_URL
 *   BACKUP_RETENTION_DAILY_DAYS   opcional (30)
 *   BACKUP_RETENTION_MONTHLY_MONTHS opcional (6)
 *   RESTORE_TEST_DATABASE_URL     base AISLADA y desechable para pruebas
 *   RECOVERY_TARGET_DATABASE_URL  base NUEVA y vacía para una recuperación
 */

export type BackupConfig = {
  storageDir: string | null
  key: Buffer | null
  keyFingerprint: string | null
  sourceUrl: string | null
  restoreTestUrl: string | null
  recoveryTargetUrl: string | null
  retentionDailyDays: number
  retentionMonthlyMonths: number
  missing: string[]
  configured: boolean
}

export function parseKey(raw: string | undefined): Buffer | null {
  if (!raw) return null
  const v = raw.trim()
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, "hex")
  try {
    const b = Buffer.from(v, "base64")
    return b.length === 32 ? b : null
  } catch {
    return null
  }
}

export function keyFingerprintOf(key: Buffer) {
  return createHash("sha256").update(key).digest("hex").slice(0, 16)
}

const int = (v: string | undefined, d: number, min: number, max: number) => {
  const n = Number(v)
  return Number.isInteger(n) && n >= min && n <= max ? n : d
}

export function getBackupConfig(
  env: Record<string, string | undefined> = process.env
): BackupConfig {
  const key = parseKey(env.BACKUP_ENCRYPTION_KEY)
  const storageDir = env.BACKUP_STORAGE_DIR?.trim() || null
  const sourceUrl =
    env.BACKUP_SOURCE_DATABASE_URL?.trim() ||
    env.DIRECT_URL?.trim() ||
    env.DATABASE_URL?.trim() ||
    null
  const missing: string[] = []
  if (!storageDir) missing.push("BACKUP_STORAGE_DIR")
  if (!env.BACKUP_ENCRYPTION_KEY) missing.push("BACKUP_ENCRYPTION_KEY")
  else if (!key)
    missing.push(
      "BACKUP_ENCRYPTION_KEY (formato inválido: 32 bytes base64 o 64 hex)"
    )
  if (
    key &&
    env.SETTINGS_ENCRYPTION_KEY &&
    parseKey(env.SETTINGS_ENCRYPTION_KEY)?.equals(key)
  )
    missing.push(
      "BACKUP_ENCRYPTION_KEY (debe ser distinta de SETTINGS_ENCRYPTION_KEY)"
    )
  if (!sourceUrl) missing.push("DIRECT_URL o BACKUP_SOURCE_DATABASE_URL")
  return {
    storageDir,
    key: missing.some((m) => m.startsWith("BACKUP_ENCRYPTION_KEY"))
      ? null
      : key,
    keyFingerprint: key ? keyFingerprintOf(key) : null,
    sourceUrl,
    restoreTestUrl: env.RESTORE_TEST_DATABASE_URL?.trim() || null,
    recoveryTargetUrl: env.RECOVERY_TARGET_DATABASE_URL?.trim() || null,
    retentionDailyDays: int(env.BACKUP_RETENTION_DAILY_DAYS, 30, 1, 3650),
    retentionMonthlyMonths: int(env.BACKUP_RETENTION_MONTHLY_MONTHS, 6, 0, 120),
    missing,
    configured: missing.length === 0,
  }
}

/** Identidad no secreta de una base (host + base), para comparar destinos. */
export function databaseIdentity(url: string) {
  const u = new URL(url)
  const host = u.hostname.toLowerCase()
  const port = u.port || "5432"
  const db = u.pathname.replace(/^\//, "") || "postgres"
  return {
    host,
    port,
    database: db,
    /** Huella para registrar el destino sin guardar la cadena de conexión. */
    fingerprint: createHash("sha256")
      .update(`${host}:${port}/${db}`)
      .digest("hex")
      .slice(0, 16),
  }
}

/** Neon: el host del pooler (-pooler) y el directo apuntan a la misma base. */
function canonicalHost(host: string) {
  return host.replace("-pooler.", ".")
}

export function sameDatabase(a: string, b: string) {
  const x = databaseIdentity(a)
  const y = databaseIdentity(b)
  return (
    canonicalHost(x.host) === canonicalHost(y.host) &&
    x.database === y.database &&
    (x.port === y.port || x.host.includes("neon.tech"))
  )
}

/** Un destino aislado debe declararse como tal en su nombre. */
export const ISOLATED_DB_NAME =
  /(restore|recovery|sandbox|isolated|_test$|test_)/i
