import "server-only"

import { prisma } from "@/lib/prisma"
import { getBackupConfig } from "@/modules/backups/backup.config"
import { backupAutomationStatus } from "@/modules/backups/backup.service"
import { isMaintenanceEnabled } from "@/modules/backups/recovery.service"

import packageJson from "../../../package.json"

/**
 * Salud del sistema (Módulo 15). Solo comprobaciones REALES y baratas
 * (sin escanear tablas grandes) y sin revelar secretos: las variables de
 * entorno se reportan por NOMBRE, nunca por valor.
 *
 *   UNAVAILABLE  la base no responde
 *   DEGRADED     algún componente crítico falla o no está configurado
 *   HEALTHY      todo lo comprobado está bien
 */

export type ComponentStatus = "OK" | "DEGRADED" | "DOWN" | "NOT_CONFIGURED"
export type Component = {
  id: string
  label: string
  status: ComponentStatus
  detail: string
}

export async function getSystemHealth(now = new Date()) {
  const components: Component[] = []
  let dbOk = true
  const t0 = performance.now()
  try {
    await prisma.$queryRaw`SELECT 1`
    components.push({
      id: "database",
      label: "Base de datos (PostgreSQL)",
      status: "OK",
      detail: `Responde en ${Math.round(performance.now() - t0)} ms`,
    })
  } catch (error) {
    dbOk = false
    components.push({
      id: "database",
      label: "Base de datos (PostgreSQL)",
      status: "DOWN",
      detail:
        error instanceof Error ? error.message.slice(0, 120) : "sin respuesta",
    })
  }
  if (!dbOk)
    return {
      overall: "UNAVAILABLE" as const,
      checkedAt: now.toISOString(),
      components,
      app: appInfo(),
      schema: null,
      maintenance: null,
      backups: null,
      restoreTest: null,
      incidents: null,
      recentErrors: null,
    }

  const [
    schema,
    maintenance,
    backups,
    lastRestore,
    lastScheduledRestore,
    incidents,
    errors,
    evidence,
    lastIntegrity,
  ] = await Promise.all([
    prisma.$queryRaw<{ name: string | null; n: bigint }[]>`
        SELECT MAX("migration_name") AS name, COUNT(*) AS n FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL`,
    isMaintenanceEnabled(),
    backupAutomationStatus(now),
    prisma.restoreValidation.findFirst({
      orderBy: { startedAt: "desc" },
      select: { id: true, status: true, startedAt: true, finishedAt: true },
    }),
    prisma.restoreValidation.findFirst({
      where: { trigger: "SCHEDULED" },
      orderBy: { startedAt: "desc" },
      select: { status: true, startedAt: true },
    }),
    prisma.operationalIncident.groupBy({
      by: ["severity"],
      where: { status: { in: ["OPEN", "IN_REVIEW"] } },
      _count: true,
    }),
    prisma.auditLog.findMany({
      where: {
        result: "FAILURE",
        createdAt: { gte: new Date(now.getTime() - 24 * 3600_000) },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, action: true, createdAt: true },
    }),
    prisma.$queryRaw<{ total: bigint; bad: bigint }[]>`
        SELECT COUNT(*) AS total,
          COUNT(*) FILTER (WHERE b."storageKey" IS NULL OR encode(sha256(b."bytes"), 'hex') <> f."sha256") AS bad
        FROM (SELECT * FROM "stored_files" WHERE "status" = 'ACTIVE' ORDER BY "createdAt" DESC LIMIT 25) f
        LEFT JOIN "evidence_blobs" b ON b."storageKey" = f."storageKey"`,
    prisma.integrityCheckRun.findFirst({
      orderBy: { startedAt: "desc" },
      select: { id: true, status: true, startedAt: true, summary: true },
    }),
  ])

  const e = evidence[0]
  components.push({
    id: "evidence",
    label: "Almacenamiento privado de evidencias (PostgreSQL)",
    status: Number(e.bad) > 0 ? "DEGRADED" : "OK",
    detail: `Últimas ${e.total} evidencias activas verificadas por huella; ${e.bad} con problemas`,
  })
  const config = getBackupConfig()
  components.push({
    id: "backups",
    label: "Respaldos automáticos diarios",
    status:
      backups.automation === "ACTIVE"
        ? "OK"
        : backups.automation === "NOT_CONFIGURED"
          ? "NOT_CONFIGURED"
          : "DEGRADED",
    detail:
      backups.automation === "ACTIVE"
        ? `Último respaldo programado exitoso: ${backups.lastScheduled?.startedAt}`
        : backups.automation === "NOT_CONFIGURED"
          ? "Nunca se ha ejecutado un respaldo programado: la automatización NO está operativa."
          : backups.automation === "STALE"
            ? "El último respaldo programado exitoso tiene más de 26 horas."
            : "El último respaldo programado falló.",
  })
  const restoreAge = lastScheduledRestore
    ? (now.getTime() - lastScheduledRestore.startedAt.getTime()) / 86_400_000
    : null
  components.push({
    id: "restore-tests",
    label: "Pruebas periódicas de restauración (mensual)",
    status: !lastRestore
      ? "NOT_CONFIGURED"
      : lastRestore.status === "FAILED" ||
          (restoreAge !== null && restoreAge > 35)
        ? "DEGRADED"
        : "OK",
    detail: !lastRestore
      ? "Nunca se ha probado una restauración."
      : `Última: ${lastRestore.status} (${lastRestore.startedAt.toISOString()})${lastScheduledRestore ? "" : " · ninguna programada todavía"}`,
  })
  const critical = incidents.find((i) => i.severity === "CRITICAL")?._count ?? 0
  components.push({
    id: "incidents",
    label: "Incidencias críticas abiertas",
    status: critical > 0 ? "DEGRADED" : "OK",
    detail: `${critical} crítica(s) abiertas`,
  })
  components.push({
    id: "maintenance",
    label: "Modo mantenimiento",
    status: maintenance ? "DEGRADED" : "OK",
    detail: maintenance ? "ACTIVO: escrituras suspendidas" : "Inactivo",
  })
  const overall = components.some((c) => c.status === "DOWN")
    ? "UNAVAILABLE"
    : components.some((c) => c.status !== "OK")
      ? "DEGRADED"
      : "HEALTHY"
  return {
    overall: overall as "HEALTHY" | "DEGRADED" | "UNAVAILABLE",
    checkedAt: now.toISOString(),
    components,
    app: appInfo(),
    schema: {
      latestMigration: schema[0]?.name ?? null,
      applied: Number(schema[0]?.n ?? 0),
    },
    maintenance,
    backups: {
      ...backups,
      /** Configuración vista por ESTE proceso (la tarea programada puede tener la suya). */
      configuredInThisProcess: config.configured,
      missingInThisProcess: config.missing,
      retention: {
        dailyDays: config.retentionDailyDays,
        monthlyMonths: config.retentionMonthlyMonths,
      },
    },
    restoreTest: lastRestore
      ? {
          id: lastRestore.id,
          status: lastRestore.status,
          startedAt: lastRestore.startedAt.toISOString(),
          finishedAt: lastRestore.finishedAt?.toISOString() ?? null,
        }
      : null,
    incidents: Object.fromEntries(incidents.map((i) => [i.severity, i._count])),
    recentErrors: errors.map((x) => ({
      ...x,
      createdAt: x.createdAt.toISOString(),
    })),
    lastIntegrity: lastIntegrity
      ? { ...lastIntegrity, startedAt: lastIntegrity.startedAt.toISOString() }
      : null,
  }
}

function appInfo() {
  return {
    version: packageJson.version,
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    environment: process.env.NODE_ENV ?? "unknown",
  }
}

export type SystemHealth = Awaited<ReturnType<typeof getSystemHealth>>
