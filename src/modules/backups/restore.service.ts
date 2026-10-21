import "server-only"

import { execFile } from "node:child_process"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { createGunzip } from "node:zlib"

import { PrismaPg } from "@prisma/adapter-pg"
import { Client } from "pg"

import { PrismaClient } from "@/generated/prisma/client"
import { BusinessRuleError, NotFoundError } from "@/lib/errors"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import {
  databaseIdentity,
  getBackupConfig,
  ISOLATED_DB_NAME,
  sameDatabase,
  type BackupConfig,
} from "@/modules/backups/backup.config"
import { decryptFile } from "@/modules/backups/backup.crypto"
import { verifyArtifact } from "@/modules/backups/backup.service"
import {
  compareTables,
  digestDatabase,
  evidenceProblems,
  listTables,
  loadSnapshot,
  readEvidence,
} from "@/modules/backups/backup.snapshot"
import { FilesystemBackupStorage } from "@/modules/backups/backup.storage"
import { raiseIncident } from "@/modules/incidents/incident.service"
import { evaluateIntegrity } from "@/modules/integrity/integrity.service"
import { summarize } from "@/modules/integrity/integrity.math"

/**
 * Restauración (Módulo 15). SIEMPRE en una base DISTINTA del origen:
 *   - prueba periódica: RESTORE_TEST_DATABASE_URL (aislada, desechable);
 *   - recuperación: RECOVERY_TARGET_DATABASE_URL (nueva y vacía).
 * Nunca sobrescribe la base productiva ni se ejecuta por HTTP. La base
 * restaurada no se conecta a la operación: no hay notificaciones ni
 * desembolsos (este proceso no los ejecuta y el Módulo 13 está en pausa).
 */

const execFileP = promisify(execFile)

export type RestoreCheck = {
  code: string
  label: string
  status: "PASSED" | "FAILED" | "INFO"
  detail: string
}

/** Garantías del destino: nunca producción, nombre aislado declarado. */
export function assertSafeTarget(
  targetUrl: string,
  config: BackupConfig,
  env: Record<string, string | undefined> = process.env,
  purpose: "test" | "recovery" = "test"
) {
  const protectedUrls = [
    config.sourceUrl,
    env.DATABASE_URL,
    env.DIRECT_URL,
  ].filter((u): u is string => Boolean(u))
  for (const u of protectedUrls)
    if (sameDatabase(u, targetUrl))
      throw new BusinessRuleError(
        "El destino es la base de origen/producción: una restauración nunca la sobrescribe."
      )
  const id = databaseIdentity(targetUrl)
  const pattern = purpose === "recovery" ? /recovery/i : ISOLATED_DB_NAME
  if (!pattern.test(id.database))
    throw new BusinessRuleError(
      purpose === "recovery"
        ? `La base de recuperación debe ser nueva y llamarse con «recovery» (actual: ${id.database}).`
        : `La base de prueba debe declararse aislada en su nombre (restore/recovery/sandbox/test). Actual: ${id.database}.`
    )
  return id
}

async function localMigrations() {
  const dir = join(process.cwd(), "prisma", "migrations")
  return (await readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
}

/** Vacía el esquema público del destino AISLADO (nunca del origen). */
async function wipeTarget(client: Client) {
  await client.query("DROP SCHEMA IF EXISTS public CASCADE")
  await client.query("CREATE SCHEMA public")
}

async function migrateTarget(targetUrl: string) {
  await execFileP("npx", ["prisma", "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DIRECT_URL: targetUrl },
    timeout: 300_000,
  })
}

/**
 * Restaura el respaldo `backupId` en `targetUrl` y ejecuta las
 * validaciones posteriores. Devuelve las comprobaciones REALES.
 */
export async function restoreInto(
  backupId: string,
  targetUrl: string,
  opts: { config: BackupConfig; wipe: boolean; purpose: "test" | "recovery" }
) {
  const { config } = opts
  const checks: RestoreCheck[] = []
  const add = (c: RestoreCheck) => checks.push(c)
  const backup = await prisma.backupExecution.findUnique({
    where: { id: backupId },
  })
  if (!backup) throw new NotFoundError("Respaldo no encontrado")
  if (
    !["SUCCESS", "PARTIAL"].includes(backup.status) ||
    !backup.location ||
    !backup.artifactSha256
  )
    throw new BusinessRuleError(
      "Solo se restauran respaldos exitosos con artefacto."
    )
  if (backup.prunedAt)
    throw new BusinessRuleError("El artefacto fue eliminado por la retención.")
  if (backup.keyFingerprint !== config.keyFingerprint)
    throw new BusinessRuleError(
      "La clave configurada no corresponde a este respaldo."
    )
  assertSafeTarget(targetUrl, config, process.env, opts.purpose)
  const manifest = backup.manifest as {
    tables: Record<string, { rows: number; sha256: string }>
    migrations: string[]
  }

  // 1. Integridad del respaldo.
  const v = await verifyArtifact(
    config,
    backup.location,
    manifest.tables,
    backup.artifactSha256
  )
  add({
    code: "BACKUP_INTEGRITY",
    label: "Integridad del respaldo (checksum, cifrado, huellas)",
    status: v.ok ? "PASSED" : "FAILED",
    detail: v.ok ? "Artefacto íntegro" : v.error,
  })
  if (!v.ok) return { checks, passed: false }

  // 2. Esquema: las migraciones del código deben ser las del respaldo.
  const local = await localMigrations()
  const sameSchema =
    local.length === manifest.migrations.length &&
    local.every((m, i) => m === manifest.migrations[i])
  add({
    code: "SCHEMA_VERSION",
    label: "Versión de esquema del respaldo = migraciones del código",
    status: sameSchema ? "PASSED" : "FAILED",
    detail: sameSchema
      ? `${local.length} migraciones (${local.at(-1)})`
      : `Respaldo ${manifest.migrations.at(-1)} · código ${local.at(-1)}. Restaura con el código de esa versión.`,
  })
  if (!sameSchema) return { checks, passed: false }

  const target = new Client({ connectionString: targetUrl })
  await target.connect()
  try {
    const tables = await listTables(target)
    if (opts.wipe) await wipeTarget(target)
    else if (tables.length > 0)
      throw new BusinessRuleError(
        "La base de recuperación no está vacía: se exige una base NUEVA."
      )
    await migrateTarget(targetUrl)
    const migrated = (
      await target.query<{ migration_name: string }>(
        `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY migration_name`
      )
    ).rows.map((r) => r.migration_name)
    add({
      code: "SCHEMA_APPLIED",
      label: "Esquema aplicado en el destino",
      status: migrated.length === local.length ? "PASSED" : "FAILED",
      detail: `${migrated.length} migraciones aplicadas`,
    })

    // 3. Carga de datos (una transacción).
    const plain = await decryptFile(
      new FilesystemBackupStorage(config.storageDir!).pathOf(backup.location),
      config.key!,
      [createGunzip()]
    )
    await loadSnapshot(target, plain)

    // 4. Conteos y huellas por tabla (excepto el historial de migraciones).
    const expected = Object.fromEntries(
      Object.entries(manifest.tables).filter(
        ([t]) => t !== "_prisma_migrations"
      )
    )
    const actual = await digestDatabase(target, Object.keys(expected))
    const diffs = compareTables(expected, actual)
    add({
      code: "DATA_FIDELITY",
      label: "Filas y huellas idénticas al respaldo (todas las tablas)",
      status: diffs.length === 0 ? "PASSED" : "FAILED",
      detail:
        diffs.length === 0
          ? `${Object.keys(expected).length} tablas idénticas`
          : `Diferencias: ${diffs.map((d) => d.table).join(", ")}`,
    })
    const n = (t: string) => actual[t]?.rows ?? 0
    for (const [code, label, tablesOf] of [
      ["USERS", "Usuarios", ["users"]],
      [
        "SESSIONS",
        "Sesiones",
        ["poker_sessions", "session_closures", "closure_reports"],
      ],
      [
        "PURCHASES",
        "Compras",
        ["chip_purchases", "purchase_payments", "purchase_deliveries"],
      ],
      [
        "INVENTORY",
        "Inventario",
        [
          "chip_set_inventory_states",
          "chip_nominal_movements",
          "chip_stock_counts",
        ],
      ],
      [
        "CASH",
        "Caja",
        [
          "cash_transactions",
          "cash_transaction_entries",
          "financial_account_balances",
        ],
      ],
      [
        "DEBTS",
        "Deudas",
        ["player_debts", "payment_allocations", "receivable_payments"],
      ],
      [
        "SETTLEMENTS",
        "Liquidaciones",
        ["player_settlements", "settlement_payables", "settlement_payouts"],
      ],
      ["AUDIT", "Auditoría", ["audit_logs"]],
    ] as const) {
      const ok = tablesOf.every(
        (t) => actual[t] && actual[t].rows === expected[t]?.rows
      )
      add({
        code: `DOMAIN_${code}`,
        label,
        status: ok ? "PASSED" : "FAILED",
        detail: tablesOf.map((t) => `${t}: ${n(t)}`).join(" · "),
      })
    }
    const admins = await target.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM "users" WHERE "role" = 'SUPERADMIN' AND "isActive"`
    )
    add({
      code: "SUPERADMIN_PRESENT",
      label: "Al menos un SUPERADMIN activo",
      status: Number(admins.rows[0].n) > 0 ? "PASSED" : "FAILED",
      detail: `${admins.rows[0].n} SUPERADMIN activo(s)`,
    })

    // 5. Firmas y evidencias: archivo ↔ firma ↔ huella.
    const evidence = await readEvidence(target)
    const problems = evidenceProblems(evidence)
    add({
      code: "EVIDENCE",
      label: "Firmas y evidencias restauradas con su huella",
      status: problems.length === 0 ? "PASSED" : "FAILED",
      detail: `${evidence.length} archivo(s); ${problems.length} con problemas`,
    })

    // 6. Motor de integridad sobre la base restaurada (informativo).
    const restored = new PrismaClient({
      adapter: new PrismaPg({ connectionString: targetUrl }),
    })
    try {
      const evaluation = await evaluateIntegrity(restored)
      const s = summarize(evaluation.results)
      add({
        code: "INTEGRITY_ENGINE",
        label: "Motor de integridad sobre la base restaurada",
        status: s.notEvaluated > 0 ? "FAILED" : "INFO",
        detail: `${s.checks} comprobaciones · ${s.error} con error · ${s.warning} advertencias · ${s.notEvaluated} sin evaluar (los hallazgos del origen se heredan)`,
      })
    } finally {
      await restored.$disconnect()
    }
  } catch (error) {
    // El fallo se REGISTRA como comprobación fallida (nunca como éxito).
    add({
      code: "RESTORE_EXECUTION",
      label: "Ejecución de la restauración",
      status: "FAILED",
      detail: error instanceof Error ? error.message.slice(0, 300) : "error",
    })
  }
  return {
    checks,
    passed: checks.every((c) => c.status !== "FAILED"),
    target: databaseIdentity(targetUrl),
    wipeAfter: async () => wipeTarget(target),
    close: () => target.end().catch(() => {}),
  }
}

/** Prueba periódica de restauración en el entorno aislado configurado. */
export async function runRestoreTest(input: {
  backupId?: string
  actorId?: string | null
  trigger: "SCHEDULED" | "MANUAL"
  keep?: boolean
  config?: BackupConfig
}) {
  const config = input.config ?? getBackupConfig()
  const missing = [...config.missing]
  if (!config.restoreTestUrl) missing.push("RESTORE_TEST_DATABASE_URL")
  if (missing.length) return { status: "NOT_CONFIGURED" as const, missing }
  const backup = input.backupId
    ? await prisma.backupExecution.findUnique({
        where: { id: input.backupId },
        select: { id: true },
      })
    : await prisma.backupExecution.findFirst({
        where: { status: "SUCCESS", prunedAt: null },
        orderBy: { startedAt: "desc" },
        select: { id: true },
      })
  if (!backup)
    throw new BusinessRuleError(
      "No hay un respaldo exitoso disponible para probar."
    )
  const target = assertSafeTarget(config.restoreTestUrl!, config)
  let validation: { id: string }
  try {
    validation = await prisma.restoreValidation.create({
      data: {
        backupId: backup.id,
        trigger: input.trigger,
        requestedById: input.actorId ?? null,
        targetFingerprint: target.fingerprint,
      },
      select: { id: true },
    })
  } catch (error) {
    if (isUniqueViolation(error))
      throw new BusinessRuleError("Ya hay una prueba de restauración en curso.")
    throw error
  }
  await recordAudit({
    action: AUDIT_ACTIONS.RESTORE_TEST_STARTED,
    entityType: "RestoreValidation",
    entityId: validation.id,
    actorUserId: input.actorId ?? null,
    metadata: { backupId: backup.id, target: target.fingerprint },
  })
  let result: Awaited<ReturnType<typeof restoreInto>> | null = null
  let error: string | null = null
  try {
    result = await restoreInto(backup.id, config.restoreTestUrl!, {
      config,
      wipe: true,
      purpose: "test",
    })
  } catch (e) {
    error = e instanceof Error ? e.message.slice(0, 500) : "error"
  }
  let cleanedUp = false
  if (result && "wipeAfter" in result && result.wipeAfter) {
    if (!input.keep) {
      await result.wipeAfter().catch(() => {})
      cleanedUp = true
    }
    await result.close?.()
  }
  const passed = Boolean(result?.passed) && !error
  await prisma.restoreValidation.update({
    where: { id: validation.id },
    data: {
      status: passed ? "PASSED" : "FAILED",
      finishedAt: new Date(),
      checks: (result?.checks ?? []) as never,
      error,
      cleanedUp,
    },
  })
  await recordAudit({
    action: passed
      ? AUDIT_ACTIONS.RESTORE_TEST_PASSED
      : AUDIT_ACTIONS.RESTORE_TEST_FAILED,
    entityType: "RestoreValidation",
    entityId: validation.id,
    actorUserId: input.actorId ?? null,
    result: passed ? "SUCCESS" : "FAILURE",
    metadata: {
      backupId: backup.id,
      checks: result?.checks.map((c) => `${c.code}:${c.status}`) ?? [],
      error,
      cleanedUp,
    },
  })
  if (!passed)
    await raiseIncident({
      source: "RESTORE",
      fingerprint: "restore-test:FAILED",
      title: "Prueba de restauración fallida",
      description:
        error ??
        `Comprobaciones fallidas: ${result?.checks
          .filter((c) => c.status === "FAILED")
          .map((c) => c.code)
          .join(", ")}`,
      severity: "CRITICAL",
      entityType: "RestoreValidation",
      entityId: validation.id,
    })
  return {
    status: passed ? ("PASSED" as const) : ("FAILED" as const),
    validationId: validation.id,
    backupId: backup.id,
    checks: result?.checks ?? [],
    error,
    cleanedUp,
  }
}

export async function listRestoreValidations(limit = 30) {
  const rows = await prisma.restoreValidation.findMany({
    orderBy: { startedAt: "desc" },
    take: limit,
    select: {
      id: true,
      backupId: true,
      status: true,
      trigger: true,
      targetFingerprint: true,
      startedAt: true,
      finishedAt: true,
      error: true,
      cleanedUp: true,
      requestedBy: { select: { id: true, name: true } },
    },
  })
  return rows.map((r) => ({
    ...r,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  }))
}

export async function getRestoreValidation(id: string) {
  const r = await prisma.restoreValidation.findUnique({
    where: { id },
    include: {
      requestedBy: { select: { id: true, name: true } },
      backup: { select: { id: true, recoveryPoint: true, status: true } },
    },
  })
  if (!r) throw new NotFoundError("Prueba de restauración no encontrada")
  return {
    id: r.id,
    backupId: r.backupId,
    backup: {
      ...r.backup,
      recoveryPoint: r.backup.recoveryPoint?.toISOString() ?? null,
    },
    status: r.status,
    trigger: r.trigger,
    targetFingerprint: r.targetFingerprint,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    checks: (r.checks as RestoreCheck[] | null) ?? [],
    error: r.error,
    cleanedUp: r.cleanedUp,
    requestedBy: r.requestedBy,
  }
}
