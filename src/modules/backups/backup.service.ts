import "server-only"

import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { Readable } from "node:stream"
import { createGunzip, createGzip } from "node:zlib"

import { Client } from "pg"

import { Prisma } from "@/generated/prisma/client"
import { BusinessRuleError, NotFoundError } from "@/lib/errors"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import {
  getBackupConfig,
  type BackupConfig,
} from "@/modules/backups/backup.config"
import { decryptFile, encryptStream } from "@/modules/backups/backup.crypto"
import {
  compareTables,
  digestSnapshot,
  evidenceProblems,
  exportSnapshot,
  type SnapshotStats,
} from "@/modules/backups/backup.snapshot"
import { FilesystemBackupStorage } from "@/modules/backups/backup.storage"
import { retentionPlan } from "@/modules/backups/backup.policy"
import { raiseIncident } from "@/modules/incidents/incident.service"
import { businessDay } from "@/modules/reports/report.math"

/**
 * Respaldos (Módulo 15). Se ejecutan fuera de la app web (CLI / tarea
 * programada: `npm run backup:run`), nunca desde un endpoint HTTP.
 *
 * Cada ejecución queda registrada con su resultado REAL: no se registra
 * SUCCESS sin artefacto, checksum y verificación; un fallo queda FAILED
 * (o PARTIAL / VERIFICATION_FAILED) con su error y abre una incidencia
 * crítica. Un solo respaldo en curso (índice parcial + bloqueo asesor) y
 * un respaldo diario por día (clave de idempotencia).
 */

const ADVISORY_LOCK = 15_15_01

export type BackupRunResult =
  | { status: "SKIPPED"; reason: string; backupId: string }
  | { status: "NOT_CONFIGURED"; missing: string[] }
  | {
      status: "SUCCESS" | "PARTIAL" | "FAILED" | "VERIFICATION_FAILED"
      backupId: string
      error?: string
    }

function relPathFor(id: string, at: Date) {
  const day = businessDay(at)
  return {
    data: `${day.slice(0, 4)}/${day.slice(5, 7)}/${day}-${id}.pmbk`,
    manifest: `${day.slice(0, 4)}/${day.slice(5, 7)}/${day}-${id}.manifest.json`,
  }
}

async function scheduledKey(at: Date) {
  const day = businessDay(at)
  const existing = await prisma.backupExecution.findMany({
    where: { idempotencyKey: { startsWith: `daily:${day}` } },
    select: { id: true, status: true },
  })
  const done = existing.find((e) =>
    ["SUCCESS", "PARTIAL", "RUNNING", "PENDING"].includes(e.status)
  )
  return {
    done,
    key:
      existing.length === 0
        ? `daily:${day}`
        : `daily:${day}:retry-${existing.length}`,
  }
}

export async function runBackup(input: {
  trigger: "SCHEDULED" | "MANUAL"
  actorId?: string | null
  config?: BackupConfig
  now?: Date
}): Promise<BackupRunResult> {
  const config = input.config ?? getBackupConfig()
  if (!config.configured)
    return { status: "NOT_CONFIGURED", missing: config.missing }
  const now = input.now ?? new Date()

  let idempotencyKey = `manual:${randomUUID()}`
  if (input.trigger === "SCHEDULED") {
    const k = await scheduledKey(now)
    if (k.done)
      return {
        status: "SKIPPED",
        reason: "El respaldo diario de hoy ya existe o está en curso.",
        backupId: k.done.id,
      }
    idempotencyKey = k.key
  }

  let execution: { id: string }
  try {
    execution = await prisma.backupExecution.create({
      data: {
        trigger: input.trigger,
        status: "RUNNING",
        idempotencyKey,
        triggeredById: input.actorId ?? null,
        destination: "filesystem",
        encryption: "AES-256-GCM + gzip",
        keyFingerprint: config.keyFingerprint,
        host: hostname().slice(0, 100),
      },
      select: { id: true },
    })
  } catch (error) {
    if (isUniqueViolation(error))
      throw new BusinessRuleError(
        "Ya hay un respaldo en curso o la clave diaria ya se usó."
      )
    throw error
  }
  await recordAudit({
    action: AUDIT_ACTIONS.BACKUP_STARTED,
    entityType: "BackupExecution",
    entityId: execution.id,
    actorUserId: input.actorId ?? null,
    metadata: { trigger: input.trigger, idempotencyKey },
  })

  const storage = new FilesystemBackupStorage(config.storageDir!)
  const paths = relPathFor(execution.id, now)
  const source = new Client({ connectionString: config.sourceUrl! })
  const stats: Partial<SnapshotStats> = {}
  let connected = false
  try {
    await storage.ensureWritable()
    await source.connect()
    connected = true
    const lock = await source.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS ok",
      [ADVISORY_LOCK]
    )
    if (!lock.rows[0].ok)
      throw new Error("Otro proceso de respaldo tiene el bloqueo.")

    const artifact = await storage.put(
      paths.data,
      Readable.from(exportSnapshot(source, stats))
        .pipe(createGzip({ level: 6 }))
        .pipe(encryptStream(config.key!))
    )
    const problems = evidenceProblems(stats.evidence ?? [])
    const manifest = {
      format: stats.header!.format,
      backupId: execution.id,
      createdAt: new Date().toISOString(),
      recoveryPoint: stats.header!.recoveryPoint,
      serverVersion: stats.header!.serverVersion,
      schemaVersion: stats.header!.schemaVersion,
      migrations: stats.header!.migrations,
      components: [
        "postgresql",
        "evidence_blobs (privadas, misma instantánea)",
      ],
      encryption: {
        algorithm: "AES-256-GCM",
        compression: "gzip",
        keyFingerprint: config.keyFingerprint,
      },
      artifact: {
        path: artifact.path,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
      },
      tables: stats.tables,
      rowCount: stats.rowCount,
      evidence: {
        count: stats.evidence?.length ?? 0,
        active:
          stats.evidence?.filter((e) => e.status === "ACTIVE").length ?? 0,
        problems,
        files: stats.evidence,
      },
    }
    const manifestFile = await storage.put(
      paths.manifest,
      Readable.from([Buffer.from(JSON.stringify(manifest, null, 2))])
    )

    // Verificación inmediata: descifrar, descomprimir y recalcular huellas.
    const verification = await verifyArtifact(
      config,
      artifact.path,
      manifest.tables!,
      artifact.sha256
    )
    const status: "SUCCESS" | "PARTIAL" | "VERIFICATION_FAILED" =
      !verification.ok
        ? "VERIFICATION_FAILED"
        : problems.length > 0
          ? "PARTIAL"
          : "SUCCESS"

    await prisma.$transaction(async (tx) => {
      await tx.backupArtifact.createMany({
        data: [
          {
            backupId: execution.id,
            kind: "DATABASE_SNAPSHOT",
            path: artifact.path,
            sizeBytes: BigInt(artifact.sizeBytes),
            sha256: artifact.sha256,
          },
          {
            backupId: execution.id,
            kind: "MANIFEST",
            path: manifestFile.path,
            sizeBytes: BigInt(manifestFile.sizeBytes),
            sha256: manifestFile.sha256,
          },
        ],
      })
      await tx.backupExecution.update({
        where: { id: execution.id },
        data: {
          status,
          finishedAt: new Date(),
          recoveryPoint: new Date(manifest.recoveryPoint),
          schemaVersion: manifest.schemaVersion,
          migrationsCount: manifest.migrations.length,
          location: artifact.path,
          tableCount: Object.keys(manifest.tables ?? {}).length,
          rowCount: manifest.rowCount ?? 0,
          evidenceCount: manifest.evidence.count,
          sizeBytes: BigInt(artifact.sizeBytes),
          artifactSha256: artifact.sha256,
          manifest: {
            ...manifest,
            evidence: { ...manifest.evidence, files: undefined },
          } as Prisma.InputJsonValue,
          verificationStatus: verification.ok ? "PASSED" : "FAILED",
          verifiedAt: new Date(),
          verificationError:
            "error" in verification ? verification.error : null,
          error:
            status === "PARTIAL"
              ? `Evidencias con problemas: ${problems.length}`
              : null,
        },
      })
      await recordAudit(
        {
          action:
            status === "VERIFICATION_FAILED"
              ? AUDIT_ACTIONS.BACKUP_VERIFICATION_FAILED
              : AUDIT_ACTIONS.BACKUP_COMPLETED,
          entityType: "BackupExecution",
          entityId: execution.id,
          actorUserId: input.actorId ?? null,
          result: status === "SUCCESS" ? "SUCCESS" : "FAILURE",
          metadata: {
            status,
            trigger: input.trigger,
            rows: manifest.rowCount,
            tables: Object.keys(manifest.tables ?? {}).length,
            evidence: manifest.evidence.count,
            evidenceProblems: problems.length,
            sizeBytes: artifact.sizeBytes,
            schemaVersion: manifest.schemaVersion,
          },
        },
        tx
      )
    })
    if (status !== "SUCCESS")
      await raiseIncident({
        source: "BACKUP",
        fingerprint: `backup:${status}`,
        title:
          status === "PARTIAL"
            ? "Respaldo parcial: evidencias faltantes o alteradas"
            : "Respaldo con verificación fallida",
        description:
          status === "PARTIAL"
            ? `El respaldo ${execution.id} encontró ${problems.length} evidencia(s) activas faltantes o con huella distinta.`
            : `El respaldo ${execution.id} no pasó su verificación: ${"error" in verification ? verification.error : ""}`,
        severity: "CRITICAL",
        entityType: "BackupExecution",
        entityId: execution.id,
      })
    await pruneBackups(config, storage).catch(() => {})
    return { status, backupId: execution.id }
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 500) : "error"
    await prisma.backupExecution.update({
      where: { id: execution.id },
      data: { status: "FAILED", finishedAt: new Date(), error: message },
    })
    await recordAudit({
      action: AUDIT_ACTIONS.BACKUP_FAILED,
      entityType: "BackupExecution",
      entityId: execution.id,
      actorUserId: input.actorId ?? null,
      result: "FAILURE",
      metadata: { trigger: input.trigger, error: message },
    })
    await raiseIncident({
      source: "BACKUP",
      fingerprint: "backup:FAILED",
      title: "Respaldo automático fallido",
      description: `El respaldo ${execution.id} falló: ${message}`,
      severity: "CRITICAL",
      entityType: "BackupExecution",
      entityId: execution.id,
    }).catch(() => {})
    return { status: "FAILED", backupId: execution.id, error: message }
  } finally {
    // Un cliente nunca conectado no se consulta (quedaría esperando).
    if (connected) {
      await source.query("SELECT pg_advisory_unlock_all()").catch(() => {})
      await source.end().catch(() => {})
    }
  }
}

/** Abre el artefacto: checksum del archivo, descifrado GCM, gunzip y huellas. */
export async function verifyArtifact(
  config: BackupConfig,
  rel: string,
  expectedTables: Record<string, { rows: number; sha256: string }>,
  expectedSha256: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const storage = new FilesystemBackupStorage(config.storageDir!)
    if (!(await storage.exists(rel)))
      return { ok: false, error: "El artefacto no existe en el destino." }
    const file = await storage.sha256(rel)
    if (file.sha256 !== expectedSha256)
      return {
        ok: false,
        error: "El checksum del artefacto no coincide (alterado o incompleto).",
      }
    const plain = await decryptFile(storage.pathOf(rel), config.key!, [
      createGunzip(),
    ])
    const digest = await digestSnapshot(plain)
    if (!digest.header || !digest.ended)
      return {
        ok: false,
        error: "Instantánea incompleta (sin cabecera o sin cierre).",
      }
    const problems = compareTables(expectedTables, digest.tables)
    if (problems.length)
      return {
        ok: false,
        error: `Diferencias en ${problems.length} tabla(s): ${problems
          .slice(0, 3)
          .map((p) => p.table)
          .join(", ")}`,
      }
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message.slice(0, 300)
          : "error de verificación",
    }
  }
}

/** Verifica de nuevo un respaldo existente y registra el resultado real. */
export async function verifyBackup(
  id: string,
  actorId: string | null,
  config = getBackupConfig()
) {
  if (!config.configured)
    throw new BusinessRuleError(
      `Respaldos sin configurar: ${config.missing.join(", ")}`
    )
  const b = await prisma.backupExecution.findUnique({ where: { id } })
  if (!b) throw new NotFoundError("Respaldo no encontrado")
  if (!b.location || !b.artifactSha256 || !b.manifest)
    throw new BusinessRuleError("El respaldo no tiene artefacto que verificar.")
  if (b.keyFingerprint && b.keyFingerprint !== config.keyFingerprint)
    throw new BusinessRuleError(
      "La clave de cifrado configurada no es la que se usó en este respaldo."
    )
  const tables = (
    b.manifest as { tables: Record<string, { rows: number; sha256: string }> }
  ).tables
  const v = b.prunedAt
    ? ({
        ok: false,
        error: "El artefacto fue eliminado por la política de retención.",
      } as const)
    : await verifyArtifact(config, b.location, tables, b.artifactSha256)
  await prisma.backupExecution.update({
    where: { id },
    data: {
      verificationStatus: v.ok ? "PASSED" : "FAILED",
      verifiedAt: new Date(),
      verificationError: v.ok ? null : v.error,
      ...(!v.ok && (b.status === "SUCCESS" || b.status === "PARTIAL")
        ? { status: "VERIFICATION_FAILED" }
        : {}),
    },
  })
  await recordAudit({
    action: v.ok
      ? AUDIT_ACTIONS.BACKUP_VERIFIED
      : AUDIT_ACTIONS.BACKUP_VERIFICATION_FAILED,
    entityType: "BackupExecution",
    entityId: id,
    actorUserId: actorId,
    result: v.ok ? "SUCCESS" : "FAILURE",
    metadata: v.ok ? {} : { error: v.error },
  })
  if (!v.ok)
    await raiseIncident({
      source: "BACKUP",
      fingerprint: `backup:verify:${id}`,
      title: "Verificación de respaldo fallida",
      description: v.error,
      severity: "CRITICAL",
      entityType: "BackupExecution",
      entityId: id,
    })
  return v
}

/**
 * Retención (parametrizable): conserva los diarios de N días y el primero
 * de cada mes durante M meses. Elimina SOLO archivos; el registro queda con
 * `prunedAt`. Nunca toca el último respaldo exitoso.
 */
export async function pruneBackups(
  config: BackupConfig,
  storage: FilesystemBackupStorage
) {
  const all = await prisma.backupExecution.findMany({
    where: { prunedAt: null, location: { not: null } },
    select: {
      id: true,
      status: true,
      recoveryPoint: true,
      startedAt: true,
      artifacts: { select: { path: true } },
    },
    orderBy: { startedAt: "desc" },
  })
  const plan = retentionPlan(
    all.map((b) => ({
      id: b.id,
      at: b.recoveryPoint ?? b.startedAt,
      ok: b.status === "SUCCESS",
    })),
    {
      dailyDays: config.retentionDailyDays,
      monthlyMonths: config.retentionMonthlyMonths,
      now: new Date(),
    }
  )
  for (const id of plan.prune) {
    const b = all.find((x) => x.id === id)!
    for (const a of b.artifacts) await storage.remove(a.path)
    await prisma.backupExecution.update({
      where: { id },
      data: { prunedAt: new Date() },
    })
  }
  return plan
}

// ── Consultas (sin secretos) ──────────────────────────────────────────

const viewSelect = {
  id: true,
  trigger: true,
  status: true,
  startedAt: true,
  finishedAt: true,
  recoveryPoint: true,
  schemaVersion: true,
  migrationsCount: true,
  destination: true,
  location: true,
  tableCount: true,
  rowCount: true,
  evidenceCount: true,
  sizeBytes: true,
  artifactSha256: true,
  encryption: true,
  keyFingerprint: true,
  verificationStatus: true,
  verifiedAt: true,
  verificationError: true,
  error: true,
  prunedAt: true,
  triggeredBy: { select: { id: true, name: true } },
} satisfies Prisma.BackupExecutionSelect

type ViewRow = Prisma.BackupExecutionGetPayload<{ select: typeof viewSelect }>

function view(b: ViewRow) {
  return {
    ...b,
    startedAt: b.startedAt.toISOString(),
    finishedAt: b.finishedAt?.toISOString() ?? null,
    recoveryPoint: b.recoveryPoint?.toISOString() ?? null,
    verifiedAt: b.verifiedAt?.toISOString() ?? null,
    prunedAt: b.prunedAt?.toISOString() ?? null,
    sizeBytes: b.sizeBytes === null ? null : Number(b.sizeBytes),
  }
}

export type BackupView = ReturnType<typeof view>

export async function listBackups(page = 1, pageSize = 25) {
  const [total, rows] = await Promise.all([
    prisma.backupExecution.count(),
    prisma.backupExecution.findMany({
      select: viewSelect,
      orderBy: { startedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])
  return { page, pageSize, total, items: rows.map(view) }
}

export async function getBackup(id: string) {
  const b = await prisma.backupExecution.findUnique({
    where: { id },
    select: {
      ...viewSelect,
      manifest: true,
      artifacts: {
        select: { kind: true, path: true, sizeBytes: true, sha256: true },
      },
      restoreValidations: {
        orderBy: { startedAt: "desc" },
        select: { id: true, status: true, startedAt: true, finishedAt: true },
      },
    },
  })
  if (!b) throw new NotFoundError("Respaldo no encontrado")
  return {
    ...view(b),
    manifest: b.manifest,
    artifacts: b.artifacts.map((a) => ({
      ...a,
      sizeBytes: Number(a.sizeBytes),
    })),
    restoreValidations: b.restoreValidations.map((r) => ({
      ...r,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    })),
  }
}

/**
 * Estado REAL de la automatización. La app no puede saber si existe una
 * tarea programada: lo infiere de su evidencia (respaldos SCHEDULED).
 *   NOT_CONFIGURED  nunca hubo un respaldo programado (o faltan variables
 *                   en este proceso)
 *   ACTIVE          hubo un respaldo programado exitoso en las últimas 26 h
 *   STALE           el último programado exitoso tiene más de 26 h
 *   FAILING         el último programado falló
 */
export async function backupAutomationStatus(now = new Date()) {
  const [lastScheduled, lastScheduledOk, lastOk, lastFailed] =
    await Promise.all([
      prisma.backupExecution.findFirst({
        where: { trigger: "SCHEDULED" },
        orderBy: { startedAt: "desc" },
        select: viewSelect,
      }),
      prisma.backupExecution.findFirst({
        where: { trigger: "SCHEDULED", status: "SUCCESS" },
        orderBy: { startedAt: "desc" },
        select: viewSelect,
      }),
      prisma.backupExecution.findFirst({
        where: { status: "SUCCESS" },
        orderBy: { startedAt: "desc" },
        select: viewSelect,
      }),
      prisma.backupExecution.findFirst({
        where: { status: { in: ["FAILED", "PARTIAL", "VERIFICATION_FAILED"] } },
        orderBy: { startedAt: "desc" },
        select: viewSelect,
      }),
    ])
  const ageH = lastScheduledOk
    ? (now.getTime() - lastScheduledOk.startedAt.getTime()) / 3_600_000
    : null
  const automation = !lastScheduled
    ? "NOT_CONFIGURED"
    : ["FAILED", "PARTIAL", "VERIFICATION_FAILED"].includes(
          lastScheduled.status
        )
      ? "FAILING"
      : ageH !== null && ageH <= 26
        ? "ACTIVE"
        : "STALE"
  return {
    automation,
    lastScheduled: lastScheduled ? view(lastScheduled) : null,
    lastSuccess: lastOk ? view(lastOk) : null,
    lastFailure: lastFailed ? view(lastFailed) : null,
  }
}
