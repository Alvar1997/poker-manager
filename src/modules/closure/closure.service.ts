import "server-only"

import { Prisma } from "@/generated/prisma/client"
import { roleHasPermission } from "@/config/permission-matrix"
import { PERMISSIONS } from "@/config/permission-matrix"
import { canonicalHash } from "@/lib/canonical-json"
import {
  AppError,
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import { withdrawAllCashForClosingInTx } from "@/modules/cash/cash.service"
import {
  adjustCashReconciliationInTx,
  recordClosingCashCountInTx,
  supersedeClosingCashCountInTx,
} from "@/modules/cash/reconciliation.service"
import { lockCashBalance } from "@/modules/cash/ledger"
import {
  lockChipSet,
  sharedChipSetId,
} from "@/modules/inventory/inventory.core"
import {
  confirmStockCountInTx,
  createStockCount,
  getStockCount,
  reconcileStockCountInTx,
  supersedeClosingCountInTx,
} from "@/modules/inventory/stock-count.service"
import { getCycleActivitySummary } from "@/modules/session-tables/session-table.service"
import { lockSession, transitionInTx } from "@/modules/sessions/session.service"
import { issueFolio } from "@/modules/settings/folio.service"
import { renderDocumentPng } from "@/modules/signatures/receipt-image"
import { receiptDate } from "@/modules/signatures/receipt.content"
import {
  buildClosurePreview,
  closureAttempts,
  closureCashCount,
  closureChipCount,
  computePrecheck,
  currentClosure,
  type ClosurePreview,
} from "@/modules/closure/closure.data"
import {
  CLOSURE_REPORT_VERSION,
  closureReportLines,
  closureReportText,
  closureReportTitle,
  type ClosureReportContent,
} from "@/modules/closure/closure-report.content"
import {
  dec,
  fmt,
  identifiableReturn,
  ZERO,
} from "@/modules/closure/closure.math"
import { getSessionChipReconciliation } from "@/modules/closure/chip-circulation.service"
import { confirmNominalChipReturnInTx } from "@/modules/inventory/reservation.service"
import type {
  CashCountInput,
  CashWithdrawalInput,
  ConfirmClosureInput,
  ResolveDiscrepancyInput,
  ReturnToOpenInput,
  StartClosingInput,
} from "@/modules/closure/closure.schemas"

/**
 * CIERRE DE SESIÓN (Módulo 12).
 *
 *   OPEN → (prevalidación sin bloqueos) → CLOSING → arqueo GLOBAL de fichas
 *   → arqueo de efectivo → [diferencias: recuento | regreso a OPEN | ajuste
 *   autorizado] → retiro final (caja $0) → confirmación PARTNER/SUPERADMIN
 *   → CLOSED + comprobante inmutable.
 *
 * - Toda mutación bloquea la sesión con FOR UPDATE (serializa con compras,
 *   liquidaciones y aperturas de mesa, que la toman FOR SHARE y exigen
 *   OPEN) y vuelve a validar dentro de la transacción: la prevalidación de
 *   pantalla nunca sustituye la validación final.
 * - Orden de bloqueos: sesión → inventario compartido → saldos financieros
 *   (el mismo que compras y liquidaciones: sin interbloqueos).
 * - Idempotencia por clave en inicio, regreso, retiro, ajustes y
 *   confirmación (índices únicos); los arqueos repetidos sin cambios se
 *   devuelven tal cual.
 * - El cierre NO cobra deudas, NO paga obligaciones, NO compensa, NO
 *   convierte fichas no retornadas en utilidad ni en pagos: solo concilia
 *   y documenta. Nada se borra.
 */

type Tx = Prisma.TransactionClient
export const CLOSURE_TX = { maxWait: 15_000, timeout: 60_000 } as const

const NOT_CLOSING_MESSAGE =
  "La sesión no está en cierre: inicia el cierre desde el panel de cierre."

async function lockClosingSession(tx: Tx, sessionId: string) {
  const session = await lockSession(tx, sessionId)
  if (session.status !== "CLOSING")
    throw new BusinessRuleError(NOT_CLOSING_MESSAGE)
  const closure = await tx.sessionClosure.findFirst({
    where: { sessionId, status: "IN_PROGRESS" },
    select: {
      id: true,
      attemptNumber: true,
      kind: true,
      startedAt: true,
      noActivityReason: true,
    },
  })
  if (!closure) throw new ConflictError(NOT_CLOSING_MESSAGE)
  return { session, closure }
}

async function closureHistory(
  tx: Tx,
  closureId: string,
  from: "IN_PROGRESS" | null,
  to: "IN_PROGRESS" | "RETURNED_TO_OPEN" | "COMPLETED",
  actor: SessionUser,
  reason: string | null = null
) {
  await tx.closureStatusHistory.create({
    data: {
      closureId,
      fromStatus: from,
      toStatus: to,
      changedById: actor.id,
      reason,
    },
  })
}

async function storePrecheck(
  tx: Tx,
  actor: SessionUser,
  closureId: string,
  sessionId: string,
  stage: "START" | "CONFIRM",
  precheck: Awaited<ReturnType<typeof computePrecheck>>,
  ctx: RequestContext
) {
  const findings = precheck.findings
  const row = await tx.closurePrecheck.create({
    data: {
      closureId,
      sessionId,
      stage,
      blockingCount: precheck.summary.blocking,
      warningCount: precheck.summary.warnings,
      infoCount: precheck.summary.info,
      findings: findings as unknown as Prisma.InputJsonValue,
      findingsHash: canonicalHash(findings),
      createdById: actor.id,
    },
    select: { id: true },
  })
  await recordAudit(
    {
      action: AUDIT_ACTIONS.CLOSURE_PRECHECK_COMPLETED,
      entityType: "ClosurePrecheck",
      entityId: row.id,
      actorUserId: actor.id,
      requestId: ctx.requestId,
      metadata: {
        sessionId,
        closureId,
        stage,
        blocking: precheck.summary.blocking,
        warnings: precheck.summary.warnings,
        info: precheck.summary.info,
        codes: findings.map((f) => `${f.severity}:${f.code}`),
      },
    },
    tx
  )
}

// ── Discrepancias físicas (detección y recuentos) ─────────────────────

/**
 * Registra como discrepancia cada arqueo de cierre (fichas o efectivo) que
 * quedó con diferencia PENDIENTE y, si hay un arqueo posterior confirmado,
 * da la anterior por resuelta con RECUENTO (el arqueo original se conserva,
 * con su diferencia, como evidencia). Idempotente.
 */
async function syncDiscrepanciesInTx(
  tx: Tx,
  actor: SessionUser,
  sessionId: string,
  closure: { id: string; startedAt: Date },
  ctx: RequestContext
) {
  const chipCounts = await tx.chipStockCount.findMany({
    where: {
      sessionId,
      countType: "CLOSING",
      status: "CONFIRMED",
      createdAt: { gte: closure.startedAt },
    },
    orderBy: [{ confirmedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      reconciliationStatus: true,
      expectedTotal: true,
      countedTotal: true,
      differenceTotal: true,
    },
  })
  const latestChip = chipCounts.at(-1)
  for (const c of chipCounts) {
    if (c.reconciliationStatus !== "PENDING") continue
    const d = await ensureDiscrepancy(tx, actor, sessionId, closure.id, ctx, {
      kind: "CHIP_INVENTORY",
      chipStockCountId: c.id,
      expected: dec(c.expectedTotal),
      counted: dec(c.countedTotal),
      difference: dec(c.differenceTotal),
    })
    if (latestChip && c.id !== latestChip.id) {
      await supersedeClosingCountInTx(tx, c.id)
      await resolveAsRecount(tx, actor, sessionId, d, ctx, {
        recountChipStockCountId: latestChip.id,
      })
    }
  }

  const cashCounts = await tx.cashReconciliation.findMany({
    where: {
      sessionId,
      reconciliationType: "CLOSING",
      status: "CONFIRMED",
      confirmedAt: { gte: closure.startedAt },
    },
    orderBy: [{ confirmedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      differenceStatus: true,
      expectedAmount: true,
      countedAmount: true,
      differenceAmount: true,
    },
  })
  const latestCash = cashCounts.at(-1)
  for (const c of cashCounts) {
    if (c.differenceStatus !== "PENDING") continue
    const d = await ensureDiscrepancy(tx, actor, sessionId, closure.id, ctx, {
      kind: "CASH",
      cashReconciliationId: c.id,
      expected: dec(c.expectedAmount),
      counted: dec(c.countedAmount),
      difference: dec(c.differenceAmount),
    })
    if (latestCash && c.id !== latestCash.id) {
      await supersedeClosingCashCountInTx(tx, c.id)
      await resolveAsRecount(tx, actor, sessionId, d, ctx, {
        recountCashReconciliationId: latestCash.id,
      })
    }
  }
}

async function ensureDiscrepancy(
  tx: Tx,
  actor: SessionUser,
  sessionId: string,
  closureId: string,
  ctx: RequestContext,
  input: {
    kind: "CHIP_INVENTORY" | "CASH"
    chipStockCountId?: string
    cashReconciliationId?: string
    expected: Prisma.Decimal
    counted: Prisma.Decimal
    difference: Prisma.Decimal
  }
) {
  const existing = await tx.closureDiscrepancy.findFirst({
    where: input.chipStockCountId
      ? { chipStockCountId: input.chipStockCountId }
      : { cashReconciliationId: input.cashReconciliationId },
    select: { id: true, status: true, kind: true },
  })
  if (existing) return existing
  const created = await tx.closureDiscrepancy.create({
    data: {
      closureId,
      sessionId,
      kind: input.kind,
      chipStockCountId: input.chipStockCountId ?? null,
      cashReconciliationId: input.cashReconciliationId ?? null,
      expectedAmount: input.expected,
      countedAmount: input.counted,
      differenceAmount: input.difference,
    },
    select: { id: true, status: true, kind: true },
  })
  await recordAudit(
    {
      action:
        input.kind === "CASH"
          ? AUDIT_ACTIONS.CASH_DISCREPANCY_DETECTED
          : AUDIT_ACTIONS.INVENTORY_DISCREPANCY_DETECTED,
      entityType: "ClosureDiscrepancy",
      entityId: created.id,
      actorUserId: actor.id,
      requestId: ctx.requestId,
      metadata: {
        sessionId,
        closureId,
        chipStockCountId: input.chipStockCountId ?? null,
        cashReconciliationId: input.cashReconciliationId ?? null,
        expected: fmt(input.expected),
        counted: fmt(input.counted),
        difference: fmt(input.difference),
      },
    },
    tx
  )
  return created
}

async function resolveDiscrepancyInTx(
  tx: Tx,
  actor: SessionUser,
  sessionId: string,
  d: { id: string; kind: "CHIP_INVENTORY" | "CASH" },
  resolution: "RECOUNT" | "RETURNED_TO_OPEN" | "AUTHORIZED_ADJUSTMENT",
  ctx: RequestContext,
  extra: {
    resolutionNotes?: string | null
    recountChipStockCountId?: string
    recountCashReconciliationId?: string
  } = {}
) {
  const { count } = await tx.closureDiscrepancy.updateMany({
    where: { id: d.id, status: "OPEN" },
    data: {
      status: "RESOLVED",
      resolution,
      resolutionNotes: extra.resolutionNotes ?? null,
      resolvedAt: new Date(),
      resolvedById: actor.id,
      recountChipStockCountId: extra.recountChipStockCountId ?? null,
      recountCashReconciliationId: extra.recountCashReconciliationId ?? null,
    },
  })
  if (count !== 1) return false
  await recordAudit(
    {
      action:
        d.kind === "CASH"
          ? AUDIT_ACTIONS.CASH_DISCREPANCY_RESOLVED
          : AUDIT_ACTIONS.INVENTORY_DISCREPANCY_RESOLVED,
      entityType: "ClosureDiscrepancy",
      entityId: d.id,
      actorUserId: actor.id,
      requestId: ctx.requestId,
      metadata: { sessionId, resolution, ...extra },
    },
    tx
  )
  return true
}

function resolveAsRecount(
  tx: Tx,
  actor: SessionUser,
  sessionId: string,
  d: { id: string; status: string; kind: "CHIP_INVENTORY" | "CASH" },
  ctx: RequestContext,
  extra: {
    recountChipStockCountId?: string
    recountCashReconciliationId?: string
  }
) {
  if (d.status !== "OPEN") return Promise.resolve(false)
  return resolveDiscrepancyInTx(tx, actor, sessionId, d, "RECOUNT", ctx, {
    ...extra,
    resolutionNotes: "Recuento físico posterior",
  })
}

// ── Iniciar el cierre (OPEN → CLOSING) ────────────────────────────────

export async function startClosing(
  actor: SessionUser,
  sessionId: string,
  input: StartClosingInput,
  ctx: RequestContext = {}
) {
  const replay = await prisma.sessionClosure.findUnique({
    where: { startIdempotencyKey: input.idempotencyKey },
    select: { sessionId: true },
  })
  if (replay) {
    if (replay.sessionId !== sessionId)
      throw new AppError(
        "CONFLICT",
        "Esta clave de operación ya se usó para otra sesión"
      )
    return { replayed: true }
  }
  try {
    await prisma.$transaction(async (tx) => {
      const session = await lockSession(tx, sessionId)
      if (session.status === "CLOSING")
        throw new ConflictError("La sesión ya está en cierre.")
      if (session.status !== "OPEN")
        throw new ConflictError(
          "Solo una sesión abierta puede pasar a cierre (una sesión cerrada nunca se reabre)."
        )
      const precheck = await computePrecheck(tx, sessionId)
      if (!precheck.summary.clear) {
        throw new BusinessRuleError(
          `No se puede iniciar el cierre: ${precheck.findings
            .filter((f) => f.severity === "BLOCKING")
            .map((f) => f.title.toLowerCase())
            .join("; ")}.`,
          {
            blocking: precheck.findings.filter(
              (f) => f.severity === "BLOCKING"
            ),
          }
        )
      }
      const attempts = await tx.sessionClosure.count({ where: { sessionId } })
      const now = new Date()
      const closure = await tx.sessionClosure.create({
        data: {
          sessionId,
          attemptNumber: attempts + 1,
          kind: precheck.kind,
          startedById: actor.id,
          startedAt: now,
          startIdempotencyKey: input.idempotencyKey,
        },
        select: { id: true, attemptNumber: true, kind: true },
      })
      await closureHistory(
        tx,
        closure.id,
        null,
        "IN_PROGRESS",
        actor,
        input.notes ?? null
      )
      await storePrecheck(
        tx,
        actor,
        closure.id,
        sessionId,
        "START",
        precheck,
        ctx
      )
      await transitionInTx(
        tx,
        session,
        "CLOSING",
        actor,
        { closingStartedAt: now },
        input.notes ?? "Inicio del cierre"
      )
      await recordAudit(
        {
          action: AUDIT_ACTIONS.SESSION_CLOSING_STARTED,
          entityType: "PokerSession",
          entityId: sessionId,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            folio: session.folio,
            from: "OPEN",
            to: "CLOSING",
            closureId: closure.id,
            attempt: closure.attemptNumber,
            kind: closure.kind,
            warnings: precheck.summary.warnings,
          },
        },
        tx
      )
    }, CLOSURE_TX)
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await prisma.sessionClosure.findUnique({
        where: { startIdempotencyKey: input.idempotencyKey },
        select: { id: true },
      })
      if (again) return { replayed: true }
      throw new ConflictError(
        "Otro usuario ya inició el cierre de esta sesión."
      )
    }
    throw error
  }
  return { replayed: false }
}

// ── Regreso auditado CLOSING → OPEN ───────────────────────────────────

/**
 * Para registrar operaciones REALES olvidadas (DEC-10/11). Conserva los
 * arqueos confirmados como evidencia (sus diferencias pendientes quedan
 * SUSTITUIDAS, sin ajuste), cancela borradores, invalida el intento (y con
 * él sus prevalidaciones y su resumen) y exige un cierre nuevo completo. No
 * reabre ciclos de mesa ni cambia horas reales: la hora INFORMADA de la
 * operación olvidada se guarda aparte de la hora real de captura.
 */
export async function returnToOpen(
  actor: SessionUser,
  sessionId: string,
  input: ReturnToOpenInput,
  ctx: RequestContext = {}
) {
  const replay = await prisma.sessionClosure.findUnique({
    where: { returnIdempotencyKey: input.idempotencyKey },
    select: { sessionId: true },
  })
  if (replay) {
    if (replay.sessionId !== sessionId)
      throw new AppError(
        "CONFLICT",
        "Esta clave de operación ya se usó para otra sesión"
      )
    return { replayed: true }
  }
  if (input.reason.trim().length < 5)
    throw new ValidationError("Explica qué operación real quedó pendiente", [
      { path: "reason", message: "Motivo obligatorio (mínimo 5 caracteres)" },
    ])
  const forgottenAt = input.forgottenOperationAt
    ? new Date(input.forgottenOperationAt)
    : null
  if (forgottenAt && forgottenAt.getTime() > Date.now() + 60_000) {
    throw new ValidationError("La hora informada no puede estar en el futuro", [
      { path: "forgottenOperationAt", message: "Hora futura" },
    ])
  }
  await prisma.$transaction(async (tx) => {
    const { session, closure } = await lockClosingSession(tx, sessionId)
    const set = await lockChipSet(tx, await sharedChipSetId(tx))
    const now = new Date()

    // Borradores del intento: se cancelan (no son evidencia confirmada).
    const drafts = await tx.chipStockCount.findMany({
      where: { sessionId, countType: "CLOSING", status: "DRAFT" },
      select: { id: true },
    })
    for (const c of drafts) {
      await tx.chipStockCount.update({
        where: { id: c.id },
        data: { status: "CANCELLED", cancelledAt: now },
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.CHIP_COUNT_CANCELLED,
          entityType: "ChipStockCount",
          entityId: c.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            chipSetCode: set.code,
            sessionId,
            reason: "Regreso de la sesión a Abierta",
          },
        },
        tx
      )
    }
    await tx.cashReconciliation.updateMany({
      where: { sessionId, status: "DRAFT", reconciliationType: "CLOSING" },
      data: { status: "CANCELLED", cancelledAt: now },
    })

    // Diferencias del intento: se registran (si faltaba) y quedan resueltas
    // por el regreso; el arqueo original se conserva sin ajuste.
    await syncDiscrepanciesInTx(tx, actor, sessionId, closure, ctx)
    const open = await tx.closureDiscrepancy.findMany({
      where: { closureId: closure.id, status: "OPEN" },
      select: {
        id: true,
        kind: true,
        chipStockCountId: true,
        cashReconciliationId: true,
      },
    })
    for (const d of open) {
      if (d.chipStockCountId)
        await supersedeClosingCountInTx(tx, d.chipStockCountId)
      if (d.cashReconciliationId)
        await supersedeClosingCashCountInTx(tx, d.cashReconciliationId)
      await resolveDiscrepancyInTx(
        tx,
        actor,
        sessionId,
        d,
        "RETURNED_TO_OPEN",
        ctx,
        { resolutionNotes: input.reason }
      )
    }

    const { count } = await tx.sessionClosure.updateMany({
      where: { id: closure.id, status: "IN_PROGRESS" },
      data: {
        status: "RETURNED_TO_OPEN",
        returnedAt: now,
        returnedById: actor.id,
        returnReason: input.reason,
        forgottenOperationAt: forgottenAt,
        returnIdempotencyKey: input.idempotencyKey,
      },
    })
    if (count !== 1) throw new ConflictError("El cierre cambió: recarga")
    await closureHistory(
      tx,
      closure.id,
      "IN_PROGRESS",
      "RETURNED_TO_OPEN",
      actor,
      input.reason
    )
    await transitionInTx(tx, session, "OPEN", actor, {}, input.reason)
    const metadata = {
      folio: session.folio,
      closureId: closure.id,
      attempt: closure.attemptNumber,
      from: "CLOSING",
      to: "OPEN",
      reason: input.reason,
      forgottenOperationAt: forgottenAt?.toISOString() ?? null,
      capturedAt: now.toISOString(),
      discrepanciesSuperseded: open.length,
    }
    await recordAudit(
      {
        action: AUDIT_ACTIONS.SESSION_CLOSING_ABORTED,
        entityType: "SessionClosure",
        entityId: closure.id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata,
      },
      tx
    )
    await recordAudit(
      {
        action: AUDIT_ACTIONS.SESSION_RETURNED_TO_OPEN,
        entityType: "PokerSession",
        entityId: sessionId,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata,
      },
      tx
    )
  }, CLOSURE_TX)
  return { replayed: false }
}

// ── Arqueo físico GLOBAL de fichas ────────────────────────────────────

/**
 * Inicia (o retoma) el ÚNICO arqueo final del inventario compartido. Si el
 * arqueo anterior del intento quedó con diferencia, el nuevo es un
 * RECUENTO (resolución A). Las cantidades se capturan por denominación con
 * el motor del Módulo 04; las compras y liquidaciones siguen sin
 * denominaciones.
 */
export async function startClosingChipCount(
  actor: SessionUser,
  sessionId: string,
  ctx: RequestContext = {}
) {
  const closure = await currentClosure(prisma, sessionId)
  const session = await prisma.pokerSession.findUnique({
    where: { id: sessionId },
    select: { status: true },
  })
  if (!session) throw new NotFoundError("Sesión no encontrada")
  if (session.status !== "CLOSING" || closure?.status !== "IN_PROGRESS")
    throw new BusinessRuleError(NOT_CLOSING_MESSAGE)
  const latest = await closureChipCount(prisma, sessionId, closure)
  if (latest?.status === "DRAFT")
    return { count: await getStockCount(latest.id), resumed: true }
  if (latest?.status === "CONFIRMED") {
    const view = await getStockCount(latest.id)
    if (view.current) return { count: view, resumed: true }
  }
  const chipSetId = await sharedChipSetId(prisma)
  const count = await createStockCount(
    actor,
    { chipSetId, countType: "CLOSING" },
    { ...ctx, sessionId }
  )
  return { count, resumed: false, recount: latest?.status === "CONFIRMED" }
}

export async function confirmClosingChipCount(
  actor: SessionUser,
  sessionId: string,
  input: { countId: string; idempotencyKey: string },
  ctx: RequestContext = {}
) {
  await prisma.$transaction(async (tx) => {
    const { closure } = await lockClosingSession(tx, sessionId)
    const head = await tx.chipStockCount.findUnique({
      where: { id: input.countId },
      select: {
        sessionId: true,
        countType: true,
        status: true,
        createdAt: true,
      },
    })
    if (
      !head ||
      head.sessionId !== sessionId ||
      head.countType !== "CLOSING" ||
      head.createdAt < closure.startedAt
    )
      throw new NotFoundError("Arqueo de cierre no encontrado")
    if (head.status === "CONFIRMED") return // reintento: sin efectos nuevos
    await confirmStockCountInTx(
      tx,
      actor,
      input.countId,
      input.idempotencyKey,
      ctx
    )
    await syncDiscrepanciesInTx(tx, actor, sessionId, closure, ctx)
    const count = await tx.chipStockCount.findUniqueOrThrow({
      where: { id: input.countId },
      select: {
        expectedTotal: true,
        countedTotal: true,
        differenceTotal: true,
        reconciliationStatus: true,
      },
    })
    const state = await tx.chipSetInventoryState.findFirstOrThrow({
      where: { chipSet: { isActive: true } },
      select: { circulationNominal: true },
    })
    const flows = await tx.chipNominalMovement.findMany({
      where: { sessionId },
      select: { circulationBefore: true, circulationAfter: true },
    })
    const net = flows.reduce(
      (acc, r) =>
        acc.add(dec(r.circulationAfter).sub(dec(r.circulationBefore))),
      dec(0)
    )
    await recordAudit(
      {
        action: AUDIT_ACTIONS.INVENTORY_FINAL_COUNT_RECORDED,
        entityType: "ChipStockCount",
        entityId: input.countId,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          sessionId,
          closureId: closure.id,
          expectedCustody: fmt(dec(count.expectedTotal)),
          countedCustody: fmt(dec(count.countedTotal)),
          physicalDifference: fmt(dec(count.differenceTotal)),
          reconciliationStatus: count.reconciliationStatus,
        },
      },
      tx
    )
    await recordAudit(
      {
        action: AUDIT_ACTIONS.OUTSTANDING_CHIP_VALUE_CALCULATED,
        entityType: "PokerSession",
        entityId: sessionId,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          closureId: closure.id,
          stage: "INVENTORY_COUNT",
          sessionNetNotReturned: fmt(net),
          globalCirculation: fmt(dec(state.circulationNominal)),
          recognizedAsIncome: "0.00",
        },
      },
      tx
    )
  }, CLOSURE_TX)
  return getStockCount(input.countId)
}

// ── Arqueo de efectivo de cierre ──────────────────────────────────────

export async function recordClosingCashCount(
  actor: SessionUser,
  sessionId: string,
  input: CashCountInput,
  ctx: RequestContext = {}
) {
  return prisma.$transaction(async (tx) => {
    const { closure } = await lockClosingSession(tx, sessionId)
    const withdrawal = await tx.closureCashWithdrawal.findUnique({
      where: { closureId: closure.id },
      select: { id: true },
    })
    if (withdrawal)
      throw new BusinessRuleError(
        "El retiro final ya se registró: la caja quedó en $0.00 y el arqueo de cierre ya no cambia."
      )
    // Reintento / doble envío: mismo conteo sobre el mismo saldo → el mismo arqueo.
    const cash = await lockCashBalance(tx, sessionId)
    const latest = await closureCashCount(tx, sessionId, closure)
    if (
      latest &&
      latest.balanceVersion === cash.version &&
      dec(latest.countedAmount).equals(dec(input.countedAmount))
    ) {
      return { id: latest.id, replayed: true }
    }
    const rec = await recordClosingCashCountInTx(
      tx,
      actor,
      {
        sessionId,
        countedAmount: input.countedAmount,
        details: input.details,
        notes: input.notes ?? null,
        explanation: input.explanation ?? null,
      },
      ctx
    )
    await syncDiscrepanciesInTx(tx, actor, sessionId, closure, ctx)
    await recordAudit(
      {
        action: AUDIT_ACTIONS.CASH_FINAL_COUNT_RECORDED,
        entityType: "CashReconciliation",
        entityId: rec.id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          sessionId,
          closureId: closure.id,
          expected: fmt(rec.expected),
          counted: fmt(rec.counted),
          difference: fmt(rec.difference),
        },
      },
      tx
    )
    return { id: rec.id, replayed: false }
  }, CLOSURE_TX)
}

// ── Retiro final de efectivo ──────────────────────────────────────────

/**
 * Salida física REAL que deja la caja en $0.00: importe EXACTO disponible,
 * operador, receptor (nombre, y opcionalmente su usuario) y hora del
 * servidor. El receptor no inicia sesión ni firma: la evidencia es la
 * declaración del operador. No es gasto. Inmutable.
 */
export async function registerFinalWithdrawal(
  actor: SessionUser,
  sessionId: string,
  input: CashWithdrawalInput,
  ctx: RequestContext = {}
) {
  const replay = await prisma.closureCashWithdrawal.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { sessionId: true, id: true },
  })
  if (replay) {
    if (replay.sessionId !== sessionId)
      throw new AppError(
        "CONFLICT",
        "Esta clave de operación ya se usó para otra sesión"
      )
    return { id: replay.id, replayed: true }
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const { closure } = await lockClosingSession(tx, sessionId)
      const existing = await tx.closureCashWithdrawal.findUnique({
        where: { closureId: closure.id },
        select: { id: true },
      })
      if (existing)
        throw new ConflictError(
          "El retiro final de este cierre ya fue registrado."
        )
      await syncDiscrepanciesInTx(tx, actor, sessionId, closure, ctx)
      const count = await closureCashCount(tx, sessionId, closure)
      if (!count)
        throw new BusinessRuleError(
          "Antes del retiro final cuenta físicamente el efectivo (arqueo de cierre)."
        )
      if (input.recipientUserId) {
        const recipient = await tx.user.findUnique({
          where: { id: input.recipientUserId },
          select: { isActive: true },
        })
        if (!recipient?.isActive)
          throw new ValidationError(
            "El usuario receptor no existe o está inactivo",
            [{ path: "recipientUserId", message: "Usuario inválido" }]
          )
      }
      const result = await withdrawAllCashForClosingInTx(
        tx,
        actor,
        {
          sessionId,
          recipientName: input.recipientName,
          idempotencyKey: input.idempotencyKey,
          expectedAmount: input.amount,
          notes: input.notes ?? null,
          closureId: closure.id,
        },
        ctx
      )
      if (!result.transactionId)
        throw new BusinessRuleError(
          "La caja ya está en $0.00: no hay efectivo que retirar."
        )
      const created = await tx.closureCashWithdrawal.create({
        data: {
          closureId: closure.id,
          sessionId,
          amount: dec(result.amount),
          withdrawnById: actor.id,
          recipientName: input.recipientName,
          recipientUserId: input.recipientUserId ?? null,
          notes: input.notes ?? null,
          cashTransactionId: result.transactionId,
          cashReconciliationId: result.reconciliationId,
          idempotencyKey: input.idempotencyKey,
        },
        select: { id: true, cashTransaction: { select: { folio: true } } },
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.CASH_WITHDRAWAL_CONFIRMED,
          entityType: "ClosureCashWithdrawal",
          entityId: created.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            sessionId,
            closureId: closure.id,
            amount: result.amount,
            recipientName: input.recipientName,
            recipientUserId: input.recipientUserId ?? null,
            withdrawnById: actor.id,
            cashTransactionId: result.transactionId,
            folio: created.cashTransaction.folio,
            finalCash: "0.00",
          },
        },
        tx
      )
      return { id: created.id, replayed: false }
    }, CLOSURE_TX)
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await prisma.closureCashWithdrawal.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true },
      })
      if (again) return { id: again.id, replayed: true }
      throw new ConflictError(
        "El retiro final de este cierre ya fue registrado."
      )
    }
    throw error
  }
}

// ── Resolución de diferencias ─────────────────────────────────────────

/**
 * `note`: seguimiento de la investigación (cualquier rol que prepara el
 * cierre). `authorize-adjustment`: AJUSTE EXCEPCIONAL, solo PARTNER o
 * SUPERADMIN (un CASHIER nunca aprueba su propio ajuste). El ajuste mueve
 * el inventario o el efectivo con su contraasiento real ligado al arqueo,
 * deja la diferencia original intacta y registra importe, motivo,
 * autorizador y referencia. Único por discrepancia.
 */
export async function resolveDiscrepancy(
  actor: SessionUser,
  sessionId: string,
  discrepancyId: string,
  input: ResolveDiscrepancyInput,
  ctx: RequestContext = {}
) {
  if (input.action === "authorize-adjustment") {
    if (!roleHasPermission(actor.role, PERMISSIONS.SESSIONS_CLOSE_AUTHORIZE))
      throw new ForbiddenError(
        "Solo un socio o un superadministrador puede autorizar un ajuste excepcional."
      )
    const replay = await prisma.closureAdjustmentAuthorization.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { discrepancyId: true },
    })
    if (replay) {
      if (replay.discrepancyId !== discrepancyId)
        throw new AppError(
          "CONFLICT",
          "Esta clave de operación ya se usó para otra diferencia"
        )
      return { replayed: true }
    }
  }
  try {
    await prisma.$transaction(async (tx) => {
      const { closure } = await lockClosingSession(tx, sessionId)
      const d = await tx.closureDiscrepancy.findUnique({
        where: { id: discrepancyId },
        select: {
          id: true,
          closureId: true,
          kind: true,
          status: true,
          chipStockCountId: true,
          cashReconciliationId: true,
          differenceAmount: true,
          investigationNotes: true,
        },
      })
      if (!d || d.closureId !== closure.id)
        throw new NotFoundError("Diferencia no encontrada en el cierre vigente")

      if (input.action === "note") {
        const stamp = `[${new Date().toISOString()} · ${actor.name}] ${input.notes}`
        await tx.closureDiscrepancy.update({
          where: { id: d.id },
          data: {
            investigationNotes: d.investigationNotes
              ? `${d.investigationNotes}\n${stamp}`
              : stamp,
          },
        })
        await recordAudit(
          {
            action: AUDIT_ACTIONS.CLOSURE_DISCREPANCY_NOTED,
            entityType: "ClosureDiscrepancy",
            entityId: d.id,
            actorUserId: actor.id,
            requestId: ctx.requestId,
            metadata: { sessionId, notes: input.notes },
          },
          tx
        )
        return
      }

      if (d.status !== "OPEN")
        throw new ConflictError("Esta diferencia ya fue resuelta.")
      let chipOperationId: string | null = null
      let cashTransactionId: string | null = null
      if (d.kind === "CHIP_INVENTORY") {
        const latest = await closureChipCount(tx, sessionId, closure)
        if (!latest || latest.id !== d.chipStockCountId)
          throw new ConflictError(
            "Hay un arqueo más reciente: resuelve la diferencia de ese arqueo."
          )
        chipOperationId = await reconcileStockCountInTx(
          tx,
          actor,
          d.chipStockCountId!,
          {
            reason: `Ajuste excepcional autorizado (cierre): ${input.reason}`,
            notes: null,
            idempotencyKey: input.idempotencyKey,
          },
          ctx
        )
      } else {
        const latest = await closureCashCount(tx, sessionId, closure)
        if (!latest || latest.id !== d.cashReconciliationId)
          throw new ConflictError(
            "Hay un arqueo de efectivo más reciente: resuelve la diferencia de ese arqueo."
          )
        cashTransactionId = await adjustCashReconciliationInTx(
          tx,
          actor,
          d.cashReconciliationId!,
          sessionId,
          {
            reason: `Ajuste excepcional autorizado (cierre): ${input.reason}`,
            idempotencyKey: input.idempotencyKey,
          },
          ctx
        )
      }
      const adj = await tx.closureAdjustmentAuthorization.create({
        data: {
          discrepancyId: d.id,
          closureId: closure.id,
          sessionId,
          amount: d.differenceAmount,
          reason: input.reason,
          authorizedById: actor.id,
          chipOperationId,
          cashTransactionId,
          idempotencyKey: input.idempotencyKey,
        },
        select: { id: true },
      })
      await recordAudit(
        {
          action:
            d.kind === "CASH"
              ? AUDIT_ACTIONS.CASH_ADJUSTMENT_AUTHORIZED
              : AUDIT_ACTIONS.INVENTORY_ADJUSTMENT_AUTHORIZED,
          entityType: "ClosureAdjustmentAuthorization",
          entityId: adj.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            sessionId,
            closureId: closure.id,
            discrepancyId: d.id,
            amount: fmt(dec(d.differenceAmount)),
            reason: input.reason,
            authorizedById: actor.id,
            authorizerRole: actor.role,
            chipOperationId,
            cashTransactionId,
          },
        },
        tx
      )
      await resolveDiscrepancyInTx(
        tx,
        actor,
        sessionId,
        d,
        "AUTHORIZED_ADJUSTMENT",
        ctx,
        { resolutionNotes: input.reason }
      )
    }, CLOSURE_TX)
  } catch (error) {
    if (isUniqueViolation(error) && input.action === "authorize-adjustment") {
      const again = await prisma.closureAdjustmentAuthorization.findFirst({
        where: { discrepancyId },
        select: { id: true },
      })
      if (again) throw new ConflictError("Esta diferencia ya fue ajustada.")
    }
    throw error
  }
  return { replayed: false }
}

// ── Confirmación definitiva (CLOSING → CLOSED) ────────────────────────

function buildReportContent(
  preview: ClosurePreview,
  extra: {
    folio: string
    approvedBy: SessionUser
    approvedAt: Date
    preparedBy: { id: string; name: string }
    noActivityReason: string | null
    /** Módulo 18: motivo del cajero cuando faltan o sobran fichas. */
    differenceReason: string | null
    kind: "NORMAL" | "NO_ACTIVITY"
    attempts: Awaited<ReturnType<typeof closureAttempts>>
    cycles: Awaited<ReturnType<typeof getCycleActivitySummary>>[]
    adjustments: {
      kind: string
      amount: Prisma.Decimal
      reason: string
      authorizedBy: { name: string }
    }[]
  }
): ClosureReportContent {
  const { session, inventory, cash, financial, precheck } = preview
  const adj = (kind: string) =>
    extra.adjustments
      .filter((a) => a.kind === kind)
      .map((a) => ({
        amount: fmt(dec(a.amount)),
        reason: a.reason,
        authorizedBy: a.authorizedBy.name,
      }))
  return {
    version: CLOSURE_REPORT_VERSION,
    folio: extra.folio,
    kind: extra.kind,
    noActivityReason: extra.noActivityReason,
    session: {
      id: session.id,
      folio: session.folio,
      openedAt: session.openedAt?.toISOString() ?? null,
      closingStartedAt: session.closingStartedAt?.toISOString() ?? null,
      closedAt: extra.approvedAt.toISOString(),
    },
    preparedBy: extra.preparedBy,
    approvedBy: {
      id: extra.approvedBy.id,
      name: extra.approvedBy.name,
      role: extra.approvedBy.role,
    },
    approvedAt: extra.approvedAt.toISOString(),
    attempts: extra.attempts.map((a) => ({
      attemptNumber: a.attemptNumber,
      status: a.status === "IN_PROGRESS" ? "COMPLETED" : a.status,
      startedAt: a.startedAt.toISOString(),
      returnedAt: a.returnedAt?.toISOString() ?? null,
      returnReason: a.returnReason,
    })),
    tables: {
      operated: financial.tables.operated,
      names: financial.tables.names,
      cyclesClosed: financial.tables.cyclesClosed,
      cycles: extra.cycles.map((c) => ({
        table: c.table,
        cycleNumber: c.cycleNumber,
        openedAt: c.openedAt,
        closedAt: c.closedAt,
        initialPurchases: c.metrics.initialPurchases,
        rebuys: c.metrics.rebuys,
        deliveredNominal: fmt(
          dec(c.metrics.initialPurchasesNominal).add(
            dec(c.metrics.rebuysNominal)
          )
        ),
        returnedNominal: c.metrics.returnedNominal,
        playersFinished: c.metrics.playersFinished,
        playersTransferred: c.metrics.playersTransferred,
      })),
    },
    players: financial.players,
    purchases: financial.purchases,
    credits: {
      originated: financial.credits.originated,
      outstanding: financial.credits.outstanding,
    },
    abonos: {
      cash: financial.abonos.cash,
      transferConfirmed: financial.abonos.transferConfirmed,
      card: financial.abonos.card,
    },
    settlements: {
      completed: financial.settlements.completed,
      pendingPayout: financial.settlements.pendingPayout,
      returnedNominal: financial.settlements.returnedNominal,
      offsets: financial.settlements.offsets,
      paidCash: financial.settlements.paidCash,
      paidTransfer: financial.settlements.paidTransfer,
      transferInTransit: financial.settlements.transferInTransit,
      pendingAmount: financial.settlements.pendingAmount,
      pendingPlayers: financial.settlements.pendingPlayers,
    },
    inventory: {
      chipCountId: inventory.count?.id ?? null,
      expectedCustody: inventory.position.expectedCustody,
      countedCustody: inventory.position.countedCustody,
      physicalDifference: inventory.position.physicalDifference,
      adjustments: adj("CHIP_INVENTORY"),
      sessionDelivered: inventory.position.sessionDelivered,
      sessionReturned: inventory.position.sessionReturned,
      sessionNetNotReturned: inventory.position.sessionNetNotReturned,
      globalCirculation: inventory.position.globalCirculation,
      chipReconciliation: {
        status: inventory.reconciliation.status,
        authorizedUnrecovered: inventory.reconciliation.authorizedUnrecovered,
        identifiedInCount: inventory.reconciliation.identifiedInCount,
        // Módulo 18: destinos y diferencia con su motivo (snapshot).
        delivered: inventory.reconciliation.delivered,
        returnedByPlayers: inventory.reconciliation.returnedByPlayers,
        rake: inventory.reconciliation.rake,
        tips: inventory.reconciliation.tips,
        otherReturns: inventory.reconciliation.otherReturns,
        nominalDifference: inventory.reconciliation.difference,
        differenceReason: extra.differenceReason,
      },
    },
    cash: {
      cashCountId: cash.count!.id,
      expected: cash.count!.expectedAmount,
      counted: cash.count!.countedAmount,
      difference: cash.count!.differenceAmount,
      adjustments: adj("CASH"),
      withdrawal: cash.withdrawal
        ? {
            amount: cash.withdrawal.amount,
            recipientName: cash.withdrawal.recipientName,
            withdrawnBy: cash.withdrawal.withdrawnBy.name,
            withdrawalAt: cash.withdrawal.withdrawalAt,
            folio: cash.withdrawal.transaction.folio,
          }
        : null,
      final: cash.expected,
    },
    bank: {
      incomingConfirmed: financial.bank.incomingConfirmed.amount,
      incomingPending: financial.bank.incomingPending.amount,
      outgoingExecuted: financial.bank.outgoingExecuted,
      outgoingPending: financial.bank.outgoingPending,
    },
    card: financial.card,
    incidents: precheck.findings
      .filter((f) => f.severity !== "INFO")
      .map((f) => ({ severity: f.severity, title: f.title, detail: f.detail })),
    previewDigest: preview.previewHash,
  }
}

/**
 * Cierre DEFINITIVO. Solo PARTNER o SUPERADMIN (validado en el endpoint y
 * aquí). Dentro de UNA transacción, con la sesión, el inventario y la caja
 * bloqueados: vuelve a evaluar la prevalidación y todos los requisitos,
 * exige que la huella del resumen revisado siga vigente (si hubo
 * movimientos relevantes después, 409 y nueva revisión), registra la
 * autorización, crea el comprobante inmutable y pasa la sesión a CLOSED.
 * Idempotente por clave. No toca deudas, obligaciones ni transferencias.
 */
export async function confirmClosure(
  actor: SessionUser,
  sessionId: string,
  input: ConfirmClosureInput,
  ctx: RequestContext = {}
) {
  // Módulo 18 (decisión del propietario): los TRES roles confirman el
  // cierre, también con diferencias de fichas (motivo obligatorio).
  if (!roleHasPermission(actor.role, PERMISSIONS.SESSIONS_CLOSE_CONFIRM))
    throw new ForbiddenError("No tienes permiso para confirmar el cierre.")
  const replay = await prisma.closureApproval.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { sessionId: true },
  })
  if (replay) {
    if (replay.sessionId !== sessionId)
      throw new AppError(
        "CONFLICT",
        "Esta clave de operación ya se usó para otra sesión"
      )
    return { replayed: true }
  }
  try {
    await prisma.$transaction(async (tx) => {
      const session = await lockSession(tx, sessionId)
      if (session.status === "CLOSED")
        throw new ConflictError("La sesión ya está cerrada.")
      if (session.status !== "CLOSING")
        throw new BusinessRuleError(NOT_CLOSING_MESSAGE)
      const closure = await tx.sessionClosure.findFirst({
        where: { sessionId, status: "IN_PROGRESS" },
        select: {
          id: true,
          kind: true,
          startedAt: true,
          noActivityReason: true,
          startedBy: { select: { id: true, name: true } },
        },
      })
      if (!closure) throw new ConflictError(NOT_CLOSING_MESSAGE)
      // Congela inventario y caja mientras se evalúa (mismo orden de bloqueos).
      await lockChipSet(tx, await sharedChipSetId(tx))
      await lockCashBalance(tx, sessionId)
      await syncDiscrepanciesInTx(tx, actor, sessionId, closure, ctx)

      let noActivityReason = closure.noActivityReason
      if (closure.kind === "NO_ACTIVITY") {
        const reason = input.noActivityReason?.trim() || noActivityReason
        if (!reason || reason.length < 5)
          throw new ValidationError(
            "El cierre sin actividad exige un motivo (mínimo 5 caracteres).",
            [{ path: "noActivityReason", message: "Motivo obligatorio" }]
          )
        noActivityReason = reason
        await tx.sessionClosure.update({
          where: { id: closure.id },
          data: { noActivityReason: reason },
        })
      }

      const preview = await buildClosurePreview(tx, sessionId)
      if (preview.previewHash !== input.previewHash) {
        throw new AppError(
          "CONFLICT",
          "Hubo movimientos relevantes después de preparar el resumen: revísalo de nuevo antes de confirmar el cierre.",
          { previewHash: preview.previewHash, stale: true }
        )
      }
      if (!preview.readiness.ready) {
        const failing = preview.readiness.checks.filter((c) => !c.ok)
        throw new BusinessRuleError(
          `El cierre aún no puede confirmarse: ${failing.map((c) => c.message).join(" ")}`,
          { checks: failing }
        )
      }
      await storePrecheck(
        tx,
        actor,
        closure.id,
        sessionId,
        "CONFIRM",
        preview.precheck,
        ctx
      )
      // Módulo 18: diferencia nominal y física, calculadas en el servidor en
      // esta misma transacción. Faltantes o sobrantes NO bloquean: exigen
      // motivo y se guardan tal cual (sin ajustes ni movimientos).
      const rec = preview.inventory.reconciliation
      const nominalDifference = dec(rec.difference)
      const physicalPending =
        preview.inventory.count?.reconciliationStatus === "PENDING"
      const physicalDifference = physicalPending
        ? dec(preview.inventory.position.physicalDifference)
        : ZERO
      const hasDifference =
        closure.kind === "NORMAL" &&
        (!nominalDifference.isZero() || !physicalDifference.isZero())
      const differenceReason = input.differenceReason?.trim() ?? ""
      if (hasDifference && differenceReason.length < 5)
        throw new ValidationError(
          "Hay una diferencia de fichas: registra el motivo (mínimo 5 caracteres) para cerrar.",
          [{ path: "differenceReason", message: "Motivo obligatorio" }]
        )
      const now = new Date()
      const approval = await tx.closureApproval.create({
        data: {
          closureId: closure.id,
          sessionId,
          approvedById: actor.id,
          approvedAt: now,
          previewHash: preview.previewHash,
          chipStockCountId: preview.inventory.count?.id ?? null,
          cashReconciliationId: preview.cash.count!.id,
          idempotencyKey: input.idempotencyKey,
        },
        select: { id: true },
      })
      const [attempts, cycles, adjustments] = await Promise.all([
        closureAttempts(tx, sessionId),
        tx.sessionTableCycle.findMany({
          where: { sessionTable: { sessionId } },
          orderBy: [{ openedAt: "asc" }, { id: "asc" }],
          select: { id: true },
        }),
        tx.closureAdjustmentAuthorization.findMany({
          where: { closureId: closure.id },
          orderBy: { createdAt: "asc" },
          select: {
            amount: true,
            reason: true,
            authorizedBy: { select: { name: true } },
            discrepancy: { select: { kind: true } },
          },
        }),
      ])
      const cycleSummaries = []
      for (const c of cycles)
        cycleSummaries.push(await getCycleActivitySummary(tx, c.id))
      const folio = await issueFolio(tx, "CASH_CLOSING")
      const content = buildReportContent(preview, {
        folio,
        approvedBy: actor,
        approvedAt: now,
        preparedBy: closure.startedBy,
        noActivityReason,
        differenceReason: hasDifference ? differenceReason : null,
        kind: closure.kind,
        attempts,
        cycles: cycleSummaries,
        adjustments: adjustments.map((a) => ({
          kind: a.discrepancy.kind,
          amount: a.amount,
          reason: a.reason,
          authorizedBy: a.authorizedBy,
        })),
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.CHIP_RECONCILIATION_CALCULATED,
          entityType: "SessionClosure",
          entityId: closure.id,
          actorUserId: actor.id,
          actorRole: actor.role,
          requestId: ctx.requestId,
          sessionId,
          amount: fmt(nominalDifference),
          metadata: {
            delivered: rec.delivered,
            returnedByPlayers: rec.returnedByPlayers,
            rake: rec.rake,
            tips: rec.tips,
            otherReturns: rec.otherReturns,
            nominalDifference: fmt(nominalDifference),
            physicalDifference: fmt(physicalDifference),
          },
        },
        tx
      )
      if (hasDifference) {
        const diff = await tx.sessionChipDifference.create({
          data: {
            sessionId,
            closureId: closure.id,
            delivered: rec.delivered,
            returnedByPlayers: rec.returnedByPlayers,
            rake: rec.rake,
            tips: rec.tips,
            otherReturns: rec.otherReturns,
            nominalDifference,
            physicalExpected: preview.inventory.count
              ? preview.inventory.position.expectedCustody
              : null,
            physicalCounted: preview.inventory.position.countedCustody,
            physicalDifference: preview.inventory.count
              ? physicalDifference
              : null,
            reason: differenceReason,
            recordedById: actor.id,
          },
          select: { id: true },
        })
        // La diferencia física se conserva: el arqueo queda «aceptado con
        // diferencia» y su incidencia de cierre se resuelve con el motivo.
        if (physicalPending && preview.inventory.count) {
          await tx.chipStockCount.updateMany({
            where: {
              id: preview.inventory.count.id,
              reconciliationStatus: "PENDING",
            },
            data: { reconciliationStatus: "ACCEPTED_WITH_DIFFERENCE" },
          })
          await tx.closureDiscrepancy.updateMany({
            where: {
              closureId: closure.id,
              kind: "CHIP_INVENTORY",
              status: "OPEN",
            },
            data: {
              status: "RESOLVED",
              resolution: "CLOSED_WITH_REASON",
              resolutionNotes: differenceReason,
              resolvedAt: now,
              resolvedById: actor.id,
            },
          })
        }
        await recordAudit(
          {
            action: AUDIT_ACTIONS.CHIP_DIFFERENCE_RECORDED,
            entityType: "SessionChipDifference",
            entityId: diff.id,
            actorUserId: actor.id,
            actorRole: actor.role,
            requestId: ctx.requestId,
            sessionId,
            amount: fmt(nominalDifference),
            reason: differenceReason,
            metadata: {
              nominalDifference: fmt(nominalDifference),
              nominalMeaning: nominalDifference.greaterThan(0)
                ? "FALTAN"
                : nominalDifference.lessThan(0)
                  ? "SOBRAN"
                  : "CUADRA",
              physicalDifference: fmt(physicalDifference),
              adjustmentCreated: false,
            },
          },
          tx
        )
      }
      const contentHash = canonicalHash(content)
      const report = await tx.closureReport.create({
        data: {
          closureId: closure.id,
          sessionId,
          folio,
          kind: closure.kind,
          content: content as unknown as Prisma.InputJsonValue,
          contentHash,
          createdById: actor.id,
        },
        select: { id: true },
      })
      const { count } = await tx.sessionClosure.updateMany({
        where: { id: closure.id, status: "IN_PROGRESS" },
        data: { status: "COMPLETED", completedAt: now },
      })
      if (count !== 1) throw new ConflictError("El cierre cambió: recarga")
      await closureHistory(tx, closure.id, "IN_PROGRESS", "COMPLETED", actor)
      await transitionInTx(
        tx,
        session,
        "CLOSED",
        actor,
        { closedAt: now },
        closure.kind === "NO_ACTIVITY"
          ? `Cierre sin actividad: ${noActivityReason}`
          : "Cierre definitivo"
      )
      const base = {
        folio: session.folio,
        closureId: closure.id,
        approvalId: approval.id,
        reportId: report.id,
        reportFolio: folio,
        kind: closure.kind,
      }
      await recordAudit(
        {
          action: AUDIT_ACTIONS.SESSION_CLOSURE_APPROVED,
          entityType: "ClosureApproval",
          entityId: approval.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            ...base,
            approverRole: actor.role,
            preparedById: closure.startedBy.id,
            previewDigest: preview.previewHash,
            chipStockCountId: preview.inventory.count?.id ?? null,
            cashReconciliationId: preview.cash.count!.id,
          },
        },
        tx
      )
      await recordAudit(
        {
          action: AUDIT_ACTIONS.OUTSTANDING_CHIP_VALUE_CALCULATED,
          entityType: "PokerSession",
          entityId: sessionId,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            closureId: closure.id,
            stage: "CLOSURE",
            sessionNetNotReturned: content.inventory.sessionNetNotReturned,
            globalCirculation: content.inventory.globalCirculation,
            recognizedAsIncome: "0.00",
          },
        },
        tx
      )
      await recordAudit(
        {
          action: AUDIT_ACTIONS.CLOSURE_REPORT_CREATED,
          entityType: "ClosureReport",
          entityId: report.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: { ...base, contentDigest: contentHash },
        },
        tx
      )
      await recordAudit(
        {
          action:
            closure.kind === "NO_ACTIVITY"
              ? AUDIT_ACTIONS.SESSION_CLOSED_WITHOUT_ACTIVITY
              : AUDIT_ACTIONS.SESSION_CLOSED,
          entityType: "PokerSession",
          entityId: sessionId,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            ...base,
            from: "CLOSING",
            to: "CLOSED",
            noActivityReason,
            finalCash: content.cash.final,
            withdrawn: content.cash.withdrawal?.amount ?? "0.00",
            recipient: content.cash.withdrawal?.recipientName ?? null,
            physicalDifference: content.inventory.physicalDifference,
            debtsOutstanding: content.credits.outstanding,
            payablesPending: content.settlements.pendingAmount,
          },
        },
        tx
      )
      if (hasDifference)
        await recordAudit(
          {
            action: AUDIT_ACTIONS.SESSION_CLOSED_WITH_DIFFERENCE,
            entityType: "PokerSession",
            entityId: sessionId,
            actorUserId: actor.id,
            actorRole: actor.role,
            requestId: ctx.requestId,
            sessionId,
            amount: fmt(nominalDifference),
            reason: differenceReason,
            metadata: {
              nominalDifference: fmt(nominalDifference),
              physicalDifference: fmt(physicalDifference),
              closedByRole: actor.role,
            },
          },
          tx
        )
    }, CLOSURE_TX)
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await prisma.closureApproval.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true },
      })
      if (again) return { replayed: true }
      throw new ConflictError("La sesión ya fue cerrada por otro usuario.")
    }
    throw error
  }
  return { replayed: false }
}

// ── Consultas ─────────────────────────────────────────────────────────

/** Panel del cierre: resumen derivado + intentos + comprobante (si existe). */
export async function getClosureOverview(sessionId: string) {
  const [preview, attempts, report] = await Promise.all([
    buildClosurePreview(prisma, sessionId),
    closureAttempts(prisma, sessionId),
    prisma.closureReport.findUnique({
      where: { sessionId },
      select: { id: true, folio: true, createdAt: true },
    }),
  ])
  return {
    ...preview,
    attempts: attempts.map((a) => ({
      ...a,
      startedAt: a.startedAt.toISOString(),
      returnedAt: a.returnedAt?.toISOString() ?? null,
      forgottenOperationAt: a.forgottenOperationAt?.toISOString() ?? null,
      completedAt: a.completedAt?.toISOString() ?? null,
    })),
    report: report
      ? { ...report, createdAt: report.createdAt.toISOString() }
      : null,
  }
}

export async function getClosureReport(sessionId: string) {
  const r = await prisma.closureReport.findUnique({
    where: { sessionId },
    select: {
      id: true,
      folio: true,
      kind: true,
      content: true,
      contentHash: true,
      createdAt: true,
      createdBy: { select: { id: true, name: true } },
    },
  })
  if (!r)
    throw new NotFoundError("La sesión aún no tiene comprobante de cierre")
  const content = r.content as unknown as ClosureReportContent
  return {
    id: r.id,
    folio: r.folio,
    kind: r.kind,
    content,
    contentDigest: r.contentHash,
    /** El snapshot no se alteró desde su emisión. */
    intact: canonicalHash(content) === r.contentHash,
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy,
    lines: closureReportLines(content),
    text: closureReportText(content),
    title: closureReportTitle(content),
  }
}

/** PNG determinista desde el snapshot (motor único del Módulo 09). Sin PDF. */
export async function renderClosureReportPng(sessionId: string) {
  const report = await getClosureReport(sessionId)
  const c = report.content
  const png = await renderDocumentPng({
    kicker: "Poker Manager · Comprobante de cierre de sesión",
    title: closureReportTitle(c),
    date: receiptDate(c.session.closedAt),
    voided: !report.intact,
    okLabel:
      c.kind === "NO_ACTIVITY" ? "Cerrada sin actividad" : "Sesión cerrada",
    lines: closureReportLines(c),
    footer: c.inventory.chipReconciliation
      ? "Fichas conciliadas globalmente entre ambas mesas (ningún jugador se lleva fichas). Deudas y pagos pendientes continúan después del cierre."
      : "Fichas no retornadas: valor nominal pendiente de retorno (no es faltante ni utilidad). Deudas y pagos pendientes continúan después del cierre.",
  })
  return { png, filename: `cierre-${c.session.folio}.png`, reportId: report.id }
}

export async function recordClosureReportEvent(
  actor: SessionUser,
  sessionId: string,
  event: "VIEWED" | "DOWNLOADED" | "SHARED",
  metadata: Record<string, unknown>,
  ctx: RequestContext = {}
) {
  const r = await prisma.closureReport.findUnique({
    where: { sessionId },
    select: { id: true, folio: true },
  })
  if (!r)
    throw new NotFoundError("La sesión aún no tiene comprobante de cierre")
  await recordAudit({
    action:
      event === "VIEWED"
        ? AUDIT_ACTIONS.CLOSURE_REPORT_VIEWED
        : event === "DOWNLOADED"
          ? AUDIT_ACTIONS.CLOSURE_REPORT_DOWNLOADED
          : AUDIT_ACTIONS.CLOSURE_REPORT_SHARED,
    entityType: "ClosureReport",
    entityId: r.id,
    actorUserId: actor.id,
    requestId: ctx.requestId,
    metadata: { sessionId, folio: r.folio, ...metadata },
  })
}

// ── Conciliación GLOBAL de fichas de la sesión ────────────────────────

export type SessionChipReconciliationInput = {
  kind: "RETURN_IDENTIFIED_IN_COUNT" | "UNRECOVERED_AUTHORIZED"
  /** Opcional: si se envía debe coincidir con lo que calcula el servidor. */
  amount?: string
  reason: string
  idempotencyKey: string
}

/**
 * Concilia la DIFERENCIA NOMINAL de una sesión en cierre (entregado −
 * devuelto con todos los jugadores terminados). Solo PARTNER o SUPERADMIN.
 *
 * - RETURN_IDENTIFIED_IN_COUNT: el arqueo de cierre encontró fichas DE MÁS
 *   en la caja (devoluciones que no se capturaron): se registra la entrada
 *   nominal REAL por lo identificado (≤ sobrante y ≤ diferencia). El arqueo
 *   queda desactualizado y se vuelve a contar (recuento).
 * - UNRECOVERED_AUTHORIZED: las fichas no aparecen; se documenta y autoriza
 *   SIN movimientos (el valor sigue fuera de custodia y queda señalado).
 * Nunca edita liquidaciones, arqueos ni crea retornos sin fichas contadas.
 */
export async function reconcileSessionChips(
  actor: SessionUser,
  sessionId: string,
  input: SessionChipReconciliationInput,
  ctx: RequestContext = {}
) {
  if (!roleHasPermission(actor.role, PERMISSIONS.SESSIONS_CLOSE_AUTHORIZE)) {
    await recordAudit({
      action: AUDIT_ACTIONS.CLOSURE_NOMINAL_RECONCILIATION_DENIED,
      entityType: "PokerSession",
      entityId: sessionId,
      actorUserId: actor.id,
      requestId: ctx.requestId,
      result: "DENIED",
      metadata: { sessionId, kind: input.kind },
    }).catch(() => {})
    throw new ForbiddenError(
      "Solo un socio o un superadministrador concilia la diferencia nominal de la sesión."
    )
  }
  const previous = await prisma.sessionChipReconciliation.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { sessionId: true },
  })
  if (previous) {
    if (previous.sessionId !== sessionId)
      throw new ConflictError("Clave de operación reutilizada")
    return { replayed: true }
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const { closure } = await lockClosingSession(tx, sessionId)
      // Serializa con otras conciliaciones y movimientos de inventario.
      await tx.$queryRaw`SELECT "chipSetId" FROM "chip_set_inventory_states" FOR UPDATE`
      const rec = await getSessionChipReconciliation(tx, sessionId)
      if (rec.status !== "UNEXPLAINED_DIFFERENCE")
        throw new BusinessRuleError(
          rec.status === "IN_PLAY"
            ? "Todavía hay jugadores activos: sus fichas siguen en juego."
            : "La sesión no tiene una diferencia nominal pendiente de conciliar."
        )
      let amount = rec.difference
      let chipOperationId: string | null = null
      let chipStockCountId: string | null = null
      const id = `scr_${input.idempotencyKey}`.slice(0, 64)
      if (input.kind === "RETURN_IDENTIFIED_IN_COUNT") {
        const count = await closureChipCount(tx, sessionId, closure)
        if (!count || count.status !== "CONFIRMED")
          throw new BusinessRuleError(
            "Primero confirma el arqueo físico global del cierre: el retorno solo se identifica con fichas contadas."
          )
        const surplus = dec(count.countedTotal).sub(dec(count.expectedTotal))
        amount = identifiableReturn({
          physicalSurplus: surplus,
          pendingDifference: rec.difference,
        })
        if (!amount.greaterThan(0))
          throw new BusinessRuleError(
            "El arqueo de cierre no encontró fichas de más: no hay retorno que identificar. Si las fichas no aparecen, documenta y autoriza la diferencia."
          )
        chipStockCountId = count.id
      }
      if (input.amount && !dec(input.amount).equals(amount))
        throw new ConflictError(
          `El importe a conciliar es $${fmt(amount)} (calculado por el servidor). Revisa la pantalla de nuevo.`
        )
      if (input.kind === "RETURN_IDENTIFIED_IN_COUNT") {
        const op = await confirmNominalChipReturnInTx(
          tx,
          actor,
          {
            amount,
            referenceType: "SessionChipReconciliation",
            referenceId: id,
            sessionId,
            idempotencyKey: `session-chip-rec-${input.idempotencyKey}`,
          },
          ctx
        )
        chipOperationId = op.operationId
      }
      await tx.sessionChipReconciliation.create({
        data: {
          id,
          sessionId,
          closureId: closure.id,
          kind: input.kind,
          amount,
          reason: input.reason,
          chipStockCountId,
          chipOperationId,
          authorizedById: actor.id,
          idempotencyKey: input.idempotencyKey,
        },
      })
      await recordAudit(
        {
          action:
            input.kind === "RETURN_IDENTIFIED_IN_COUNT"
              ? AUDIT_ACTIONS.CLOSURE_NOMINAL_RETURN_IDENTIFIED
              : AUDIT_ACTIONS.CLOSURE_NOMINAL_DIFFERENCE_AUTHORIZED,
          entityType: "SessionChipReconciliation",
          entityId: id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          reason: input.reason,
          metadata: {
            sessionId,
            closureId: closure.id,
            amount: fmt(amount),
            delivered: fmt(rec.delivered),
            returned: fmt(rec.returned),
            differenceBefore: fmt(rec.difference),
            chipStockCountId,
            chipOperationId,
            recognizedAsIncome: "0.00",
          },
        },
        tx
      )
      return { replayed: false, amount: fmt(amount) }
    }, CLOSURE_TX)
  } catch (error) {
    if (isUniqueViolation(error)) return { replayed: true }
    throw error
  }
}
