import "server-only"

import { Prisma, type PrismaClient } from "@/generated/prisma/client"
import { ConflictError, NotFoundError } from "@/lib/errors"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import { raiseIncidentInTx } from "@/modules/incidents/incident.service"
import { integrityChecks } from "@/modules/integrity/integrity.checks"
import {
  fingerprintOf,
  incidentSeverityOf,
  safeRun,
  shouldOpenIncident,
  summarize,
  type CheckResult,
} from "@/modules/integrity/integrity.math"

/**
 * Ejecución del motor de integridad (Módulo 15). Lee TODO dentro de una
 * transacción REPEATABLE READ de solo lectura: una foto consistente aunque
 * haya operaciones en curso. Después registra la ejecución, los hallazgos
 * y las incidencias (deduplicadas). Nunca corrige ni crea movimientos.
 */

const STALE_MS = 15 * 60 * 1000

/** Corre las comprobaciones contra `db` (producción o una base restaurada). */
export async function evaluateIntegrity(
  db: PrismaClient = prisma
): Promise<{ checkedAt: Date; results: CheckResult[] }> {
  const checkedAt = new Date()
  const results = await db.$transaction(
    async (tx) => {
      const out: CheckResult[] = []
      // Secuencial: evita cargar la base con decenas de consultas a la vez.
      for (const def of integrityChecks(tx)) out.push(...(await safeRun(def)))
      return out
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 15_000,
      timeout: 120_000,
    }
  )
  return { checkedAt, results }
}

export async function runIntegrityCheck(
  actor: { id: string; role: "SUPERADMIN" | "PARTNER" | "CASHIER" } | null,
  opts: { trigger: "MANUAL" | "SCHEDULED"; requestId?: string } = {
    trigger: "MANUAL",
  }
) {
  // Una ejecución colgada (proceso caído) se cierra como FAILED, no como OK.
  await prisma.integrityCheckRun.updateMany({
    where: {
      status: "RUNNING",
      startedAt: { lt: new Date(Date.now() - STALE_MS) },
    },
    data: {
      status: "FAILED",
      finishedAt: new Date(),
      error: "Ejecución interrumpida (sin finalizar en 15 minutos).",
    },
  })
  let run: { id: string }
  try {
    run = await prisma.integrityCheckRun.create({
      data: { trigger: opts.trigger, triggeredById: actor?.id ?? null },
      select: { id: true },
    })
  } catch (error) {
    if (isUniqueViolation(error))
      throw new ConflictError(
        "Ya hay un diagnóstico de integridad en curso. Espera a que termine."
      )
    throw error
  }

  let evaluation: Awaited<ReturnType<typeof evaluateIntegrity>>
  try {
    evaluation = await evaluateIntegrity()
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 500) : "error"
    await prisma.integrityCheckRun.update({
      where: { id: run.id },
      data: { status: "FAILED", finishedAt: new Date(), error: message },
    })
    await recordAudit({
      action: AUDIT_ACTIONS.INTEGRITY_CHECK_FAILED,
      entityType: "IntegrityCheckRun",
      entityId: run.id,
      actorUserId: actor?.id ?? null,
      result: "FAILURE",
      requestId: opts.requestId,
      metadata: { error: message },
    })
    throw error
  }

  const summary = summarize(evaluation.results)
  const incidents = await prisma.$transaction(
    async (tx) => {
      let opened = 0
      let reoccurred = 0
      for (const r of evaluation.results) {
        const finding = await tx.integrityFinding.create({
          data: {
            runId: run.id,
            checkCode: r.checkCode,
            category: r.category,
            status: r.status,
            severity: r.severity,
            entityType: r.entityType ?? null,
            entityId: r.entityId ?? null,
            expected: r.expected ?? null,
            actual: r.actual ?? null,
            difference: r.difference ?? null,
            explanation: r.explanation,
            references: (r.references ?? undefined) as
              Prisma.InputJsonValue | undefined,
            fingerprint: fingerprintOf(r),
            checkedAt: evaluation.checkedAt,
          },
          select: { id: true },
        })
        if (shouldOpenIncident(r)) {
          const res = await raiseIncidentInTx(tx, {
            source: "INTEGRITY",
            fingerprint: `integrity:${fingerprintOf(r)}`,
            title: `${r.checkCode}${r.entityId ? ` · ${r.entityId}` : ""}`,
            description: r.explanation,
            severity: incidentSeverityOf(r),
            entityType: r.entityType,
            entityId: r.entityId,
            findingId: finding.id,
            actorId: actor?.id ?? null,
            requestId: opts.requestId,
          })
          if (res.created) opened += 1
          else reoccurred += 1
        }
      }
      await tx.integrityCheckRun.update({
        where: { id: run.id },
        data: {
          status: "COMPLETED",
          finishedAt: new Date(),
          summary: {
            ...summary,
            incidentsOpened: opened,
            incidentsReoccurred: reoccurred,
          },
        },
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.INTEGRITY_CHECK_COMPLETED,
          entityType: "IntegrityCheckRun",
          entityId: run.id,
          actorUserId: actor?.id ?? null,
          actorRole: actor?.role ?? null,
          requestId: opts.requestId,
          metadata: {
            ...summary,
            incidentsOpened: opened,
            trigger: opts.trigger,
          },
        },
        tx
      )
      return { opened, reoccurred }
    },
    { maxWait: 15_000, timeout: 60_000 }
  )
  return { runId: run.id, summary, incidents }
}

export async function listIntegrityRuns(limit = 20) {
  const runs = await prisma.integrityCheckRun.findMany({
    orderBy: { startedAt: "desc" },
    take: limit,
    select: {
      id: true,
      status: true,
      trigger: true,
      startedAt: true,
      finishedAt: true,
      summary: true,
      error: true,
      triggeredBy: { select: { id: true, name: true } },
    },
  })
  return runs.map((r) => ({
    ...r,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  }))
}

export async function getIntegrityRun(id: string) {
  const run = await prisma.integrityCheckRun.findUnique({
    where: { id },
    include: {
      triggeredBy: { select: { id: true, name: true } },
      findings: {
        orderBy: [{ category: "asc" }, { checkCode: "asc" }],
        include: {
          incidents: { select: { id: true, folio: true, status: true } },
        },
      },
    },
  })
  if (!run) throw new NotFoundError("Ejecución no encontrada")
  return {
    id: run.id,
    status: run.status,
    trigger: run.trigger,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    summary: run.summary as ReturnType<typeof summarize> | null,
    error: run.error,
    triggeredBy: run.triggeredBy,
    findings: run.findings.map((f) => ({
      id: f.id,
      checkCode: f.checkCode,
      category: f.category,
      status: f.status,
      severity: f.severity,
      entityType: f.entityType,
      entityId: f.entityId,
      expected: f.expected,
      actual: f.actual,
      difference: f.difference,
      explanation: f.explanation,
      checkedAt: f.checkedAt.toISOString(),
      incidents: f.incidents,
    })),
  }
}

export type IntegrityRunDetail = Awaited<ReturnType<typeof getIntegrityRun>>
