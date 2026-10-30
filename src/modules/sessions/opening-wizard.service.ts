import "server-only"

import type { Prisma } from "@/generated/prisma/client"
import { can, PERMISSIONS } from "@/config/permissions"
import { BusinessRuleError, ForbiddenError, NotFoundError } from "@/lib/errors"
import { zonedDateTimeToUtc } from "@/lib/format"
import { formatBusinessDateMx } from "@/modules/sessions/session-folio"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import type { WizardTask } from "@/lib/wizard"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import { getStockCount } from "@/modules/inventory/stock-count.service"
import {
  computeOpeningChecklist,
  loadTablePlan,
  openingFingerprint,
  type ChecklistStep,
  type ChecklistStepId,
} from "@/modules/sessions/opening.service"
import {
  OPENING_STEPS,
  openingProgress,
  openingStepStatus,
  suggestedOpeningStep,
} from "@/modules/sessions/opening-wizard.math"
import type { OpeningWizardProgressInput } from "@/modules/sessions/session.schemas"
import {
  getSession,
  lockSession,
  SESSION_TX,
} from "@/modules/sessions/session.service"
import {
  canManagePreparation,
  isSuperadminIntervention,
  PREPARATION_FORBIDDEN_MESSAGE,
} from "@/modules/sessions/session.state"

/**
 * Asistente de apertura en 4 pasos (Crear jornada → Contar fichas →
 * Preparar mesas (opcional) → Confirmar apertura). NO es una apertura
 * paralela: traduce el checklist real (`computeOpeningChecklist`) a tareas
 * con su ruta para RESOLVER, y la apertura sigue siendo `openSession`, que
 * revalida todo dentro de su transacción. Lo único que se guarda aquí es lo
 * que el creador declara (paso actual, observación, «continuar sin mesas»
 * y el plan de mesas); el estado de los pasos siempre se recalcula.
 */

const BASE = "/dashboard/sesiones"
const INVENTORY_HREF = "/dashboard/inventario/fichas"
const TABLES_CATALOG_HREF = "/dashboard/configuracion/mesas"

const user = { select: { id: true, name: true } } as const

function chipTasks(
  sessionId: string,
  steps: Map<ChecklistStepId, ChecklistStep>
): WizardTask[] {
  const tasks: WizardTask[] = []
  const href = `${BASE}/${sessionId}/arqueo-fichas`
  const counted = steps.get("CHIPS_COUNTED")!
  if (counted.status === "BLOCKED") {
    tasks.push({
      code: "INVENTORY_NOT_READY",
      severity: "BLOCKING",
      title: counted.message ?? "El inventario de fichas no está listo.",
      href: INVENTORY_HREF,
      actionLabel: "IR AL INVENTARIO",
    })
    return tasks
  }
  if (counted.status === "PENDING") {
    const started = counted.message?.startsWith("Captura") ?? false
    tasks.push({
      code: started ? "CHIP_COUNT_INCOMPLETE" : "CHIP_COUNT_MISSING",
      severity: "BLOCKING",
      title: started
        ? "Falta capturar la cantidad contada de todas las denominaciones."
        : "Falta contar el inventario físico de fichas para abrir esta jornada.",
      href,
      actionLabel: started ? "CONTINUAR CONTEO" : "CONTAR FICHAS",
    })
    return tasks
  }
  if (steps.get("CHIP_COUNT_CONFIRMED")!.status !== "DONE") {
    tasks.push({
      code: "CHIP_COUNT_UNCONFIRMED",
      severity: "BLOCKING",
      title:
        "Falta confirmar el conteo físico inicial de fichas para abrir esta jornada.",
      href,
      actionLabel: "CONFIRMAR CONTEO",
    })
    return tasks
  }
  if (steps.get("DIFFERENCES_RECONCILED")!.status === "BLOCKED") {
    tasks.push({
      code: "CHIP_DIFFERENCE_PENDING",
      severity: "BLOCKING",
      title:
        "El conteo no coincide con el inventario esperado: revisa y concilia la diferencia (ajuste auditable).",
      href,
      actionLabel: "REVISAR DIFERENCIA",
    })
    return tasks
  }
  if (steps.get("INVENTORY_CURRENT")!.status === "BLOCKED") {
    tasks.push({
      code: "CHIP_COUNT_STALE",
      severity: "BLOCKING",
      title:
        "Hubo movimientos de fichas después del conteo: vuelve a contar el inventario.",
      href,
      actionLabel: "VOLVER A CONTAR",
    })
  }
  const circulation = steps.get("NO_PENDING_CIRCULATION")!
  if (circulation.status === "BLOCKED") {
    tasks.push({
      code: "CHIP_RESERVATIONS_PENDING",
      severity: "BLOCKING",
      title: circulation.message ?? "Hay reservas de fichas pendientes.",
      href: INVENTORY_HREF,
      actionLabel: "IR AL INVENTARIO",
    })
  } else if (circulation.message) {
    tasks.push({
      code: "CHIPS_OUT_OF_CUSTODY",
      severity: "INFO",
      title: circulation.message,
      href: null,
    })
  }
  return tasks
}

function cashTasks(steps: Map<ChecklistStepId, ChecklistStep>): WizardTask[] {
  const cash = steps.get("CASH_ZERO_CONFIRMED")!
  if (cash.status === "DONE") return []
  const counted = steps.get("CASH_COUNTED")!.status === "DONE"
  if (cash.status === "BLOCKED") {
    const stale = cash.message?.startsWith("Hubo") ?? false
    return [
      {
        code: stale ? "CASH_ZERO_STALE" : "CASH_NOT_ZERO",
        severity: "BLOCKING",
        title: cash.message ?? "La caja física debe estar en $0.00.",
        href: null,
        actionLabel: "VOLVER A CONTAR LA CAJA",
      },
    ]
  }
  return [
    {
      code: counted ? "CASH_ZERO_UNCONFIRMED" : "CASH_ZERO_MISSING",
      severity: "BLOCKING",
      title:
        "Falta confirmar que la caja física está vacía ($0.00). No hay fondo inicial.",
      href: null,
      actionLabel: "CONFIRMAR CAJA EN $0",
    },
  ]
}

/** Vista completa del asistente (todo calculado en el servidor). */
export async function getOpeningWizard(
  sessionId: string,
  actor: { id: string; role: string }
) {
  const session = await getSession(sessionId, actor)
  const [checklist, plan, catalog, progress] = await Promise.all([
    computeOpeningChecklist(prisma, sessionId, actor),
    loadTablePlan(prisma, sessionId),
    prisma.pokerTable.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: {
        id: true,
        code: true,
        name: true,
        smallBlind: true,
        bigBlind: true,
      },
    }),
    prisma.sessionOpeningProgress.findUnique({
      where: { sessionId },
      select: {
        currentStep: true,
        noTablesConfirmedAt: true,
        noTablesConfirmedBy: user,
        updatedAt: true,
      },
    }),
  ])
  const count = checklist.chipCountId
    ? await getStockCount(checklist.chipCountId)
    : null
  const steps = new Map(checklist.steps.map((s) => [s.id, s]))
  const status = session.status
  const preparing = status === "PREPARATION"
  const opened =
    status === "OPEN" || status === "CLOSING" || status === "CLOSED"

  // Paso 1 — Crear jornada.
  const sessionTasks: WizardTask[] = []
  if (status === "DRAFT")
    sessionTasks.push({
      code: "PREPARATION_NOT_STARTED",
      severity: "BLOCKING",
      title: "Falta guardar la jornada en preparación para continuar.",
      href: null,
      actionLabel: "GUARDAR Y CONTINUAR",
    })
  // Jornada histórica: avisos (no bloquean) para no confundirla con hoy y
  // para detectar duplicados o capturas fuera de orden cronológico.
  if (session.isHistorical && status !== "CANCELLED") {
    const others = await prisma.pokerSession.findMany({
      where: {
        id: { not: session.id },
        status: { notIn: ["CANCELLED"] },
        businessDate: { gte: new Date(`${session.businessDate}T00:00:00Z`) },
      },
      orderBy: [{ businessDate: "asc" }, { sequenceNumber: "asc" }],
      select: { folio: true, businessDate: true },
    })
    const day = (d: Date) => d.toISOString().slice(0, 10)
    const sameDay = others.filter(
      (o) => day(o.businessDate) === session.businessDate
    )
    const later = others.filter(
      (o) => day(o.businessDate) > session.businessDate
    )
    sessionTasks.push({
      code: "HISTORICAL_SESSION",
      severity: "INFO",
      title: `Jornada histórica del ${formatBusinessDateMx(session.businessDate)}: se captura después.`,
      detail:
        "Se opera completa como una jornada normal. Cada movimiento conserva su hora REAL de captura; la fecha operativa de todos es la de esta jornada.",
      href: null,
    })
    if (sameDay.length > 0)
      sessionTasks.push({
        code: "SAME_DAY_SESSION_EXISTS",
        severity: "WARNING",
        title: `Ya existe otra jornada con esta fecha: ${sameDay.map((o) => o.folio).join(", ")}.`,
        detail:
          "No se bloquea (puede haber dos jornadas el mismo día), pero verifica que no estés capturando la misma noche dos veces.",
        href: null,
      })
    if (later.length > 0)
      sessionTasks.push({
        code: "LATER_SESSIONS_EXIST",
        severity: "INFO",
        title: `Hay jornadas posteriores (${later
          .slice(0, 3)
          .map((o) => o.folio)
          .join(", ")}${later.length > 3 ? ", …" : ""}).`,
        detail:
          "Esta captura no modifica sus arqueos, comprobantes ni reportes de cierre. Los movimientos que registres aquí sí se reflejan en el inventario y en las deudas ACTUALES.",
        href: null,
      })
  }
  if (status === "CANCELLED")
    sessionTasks.push({
      code: "SESSION_CANCELLED",
      severity: "BLOCKING",
      title: "La jornada fue cancelada: crea una nueva.",
      href: `${BASE}/nueva`,
      actionLabel: "NUEVA JORNADA",
    })

  // Paso 2 — Contar fichas (requiere la preparación iniciada).
  const chipsDone =
    opened ||
    (preparing &&
      (
        [
          "CHIPS_COUNTED",
          "CHIP_COUNT_CONFIRMED",
          "DIFFERENCES_RECONCILED",
          "INVENTORY_CURRENT",
          "NO_PENDING_CIRCULATION",
        ] as const
      ).every((id) => steps.get(id)!.status === "DONE"))
  const chips: WizardTask[] = preparing
    ? chipTasks(sessionId, steps)
    : status === "DRAFT"
      ? [
          {
            code: "CHIP_COUNT_MISSING",
            severity: "BLOCKING",
            title:
              "Falta contar el inventario físico de fichas (primero guarda la jornada en el paso 1).",
            href: null,
          },
        ]
      : []
  // Jornada histórica: el conteo protege las existencias ACTUALES.
  if (session.isHistorical && (status === "DRAFT" || preparing))
    chips.push({
      code: "HISTORICAL_COUNT_IS_CURRENT",
      severity: "INFO",
      title: "Cuenta el inventario físico que existe HOY.",
      detail:
        "El sistema tiene un solo inventario compartido: el conteo inicial de una jornada histórica se compara con las existencias actuales, no con lo que hubo esa noche. Así no se duplican fichas ni se alteran los arqueos de jornadas posteriores.",
      href: null,
    })

  // Paso 3 — Mesas (opcional).
  const tableTasks: WizardTask[] = plan
    .filter((t) => t.problem)
    .map((t) => ({
      code: "TABLE_CONFIG_INCOMPLETE",
      severity: "BLOCKING" as const,
      title: t.problem!,
      entity: { type: "PokerTable", id: t.tableId },
      href: TABLES_CATALOG_HREF,
      actionLabel: "CONFIGURAR MESA",
    }))
  if (!opened && plan.length === 0)
    tableTasks.push({
      code: "NO_TABLES",
      severity: "INFO",
      title:
        "No has agregado mesas. Puedes abrir la jornada y agregarlas después.",
      href: null,
    })
  const tablesDone =
    opened ||
    (preparing && (plan.length > 0 || Boolean(progress?.noTablesConfirmedAt)))

  // Paso 4 — Confirmar apertura (caja $0 + permiso + apertura real).
  const confirmTasks: WizardTask[] = preparing ? cashTasks(steps) : []
  if (!opened && steps.get("USER_AUTHORIZED")!.status !== "DONE")
    confirmTasks.push({
      code: "OPENING_NOT_AUTHORIZED",
      severity: "BLOCKING",
      title:
        steps.get("USER_AUTHORIZED")!.message ?? PREPARATION_FORBIDDEN_MESSAGE,
      href: null,
    })

  const raw = [
    { tasks: sessionTasks, done: status !== "DRAFT" && status !== "CANCELLED" },
    { tasks: chips, done: chipsDone },
    { tasks: tableTasks, done: tablesDone },
    { tasks: confirmTasks, done: opened },
  ]
  const stepViews = OPENING_STEPS.map((meta, i) => {
    const st = openingStepStatus(raw[i])
    return {
      ...meta,
      number: i + 1,
      status: st,
      tasks: raw[i].tasks,
      blocking: raw[i].tasks.filter((t) => t.severity === "BLOCKING").length,
      warnings: raw[i].tasks.filter((t) => t.severity === "WARNING").length,
    }
  })
  const statuses = stepViews.map((s) => s.status)
  const blockers = stepViews.flatMap((s) =>
    s.tasks
      .filter((t) => t.severity === "BLOCKING")
      .map((t) => ({ step: s.number, code: t.code, title: t.title }))
  )
  const canOpen =
    preparing &&
    session.canManagePreparation &&
    checklist.ready &&
    blockers.length === 0

  return {
    session: {
      id: session.id,
      folio: session.folio,
      status,
      statusLabel: session.statusLabel,
      businessDate: session.businessDate,
      createdAt: session.createdAt,
      preparationStartedAt: session.preparationStartedAt,
      openedAt: session.openedAt,
      notes: session.notes,
      createdBy: session.createdBy,
      canManagePreparation: session.canManagePreparation,
      isHistorical: session.isHistorical,
      historicalRecordedAt: session.historicalRecordedAt,
      operatedOpenedAt: session.operatedOpenedAt,
    },
    progress: openingProgress(statuses),
    currentStep: progress?.currentStep ?? null,
    suggestedStep: suggestedOpeningStep(statuses),
    steps: stepViews,
    chipCount: count
      ? {
          id: count.id,
          status: count.status,
          reconciliationStatus: count.reconciliationStatus,
          current: count.current,
          complete: count.complete,
          expectedTotal: count.expectedTotal,
          countedTotal: count.countedTotal,
          differenceTotal: count.differenceTotal,
          countedBy: count.countedBy,
          confirmedBy: count.confirmedBy,
          confirmedAt: count.confirmedAt,
          details: count.details.map((d) => ({
            denominationId: d.denominationId,
            unitValue: d.unitValue,
            name: d.name,
            color: d.color,
            expectedQuantity: d.expectedQuantity,
            countedQuantity: d.countedQuantity,
            differenceQuantity: d.differenceQuantity,
          })),
        }
      : null,
    cash: {
      confirmed: steps.get("CASH_ZERO_CONFIRMED")!.status === "DONE",
      confirmedBy: steps.get("CASH_ZERO_CONFIRMED")!.completedBy,
      openingAmount: "0.00",
    },
    tables: {
      planned: plan,
      available: catalog
        .filter((c) => !plan.some((p) => p.tableId === c.id))
        .map((c) => ({
          tableId: c.id,
          code: c.code,
          name: c.name,
          blinds: {
            small: c.smallBlind.toFixed(2),
            big: c.bigBlind.toFixed(2),
          },
        })),
      noTablesConfirmed: Boolean(progress?.noTablesConfirmedAt),
    },
    blockers,
    canOpen,
    previewHash: openingFingerprint(checklist, plan),
  }
}
export type OpeningWizardView = Awaited<ReturnType<typeof getOpeningWizard>>

/** Bloquea la sesión y aplica la regla del creador para el asistente. */
async function lockForPreparation(
  tx: Prisma.TransactionClient,
  actor: SessionUser,
  sessionId: string,
  allowed: readonly string[]
) {
  const session = await lockSession(tx, sessionId)
  if (!canManagePreparation(actor, session))
    throw new ForbiddenError(PREPARATION_FORBIDDEN_MESSAGE)
  if (!allowed.includes(session.status))
    throw new BusinessRuleError(
      `La sesión ${session.folio} ya no está en preparación: su apertura no se edita.`
    )
  return session
}

/**
 * Guarda lo que el creador declara: paso actual, observación de la jornada
 * y «continuar sin mesas». Solo el creador o SUPERADMIN, con la sesión en
 * borrador o preparación (la base lo vuelve a exigir con un trigger).
 */
export async function saveOpeningWizardProgress(
  actor: SessionUser,
  sessionId: string,
  input: OpeningWizardProgressInput,
  ctx: RequestContext = {}
) {
  return prisma.$transaction(async (tx) => {
    const session = await lockForPreparation(tx, actor, sessionId, [
      "DRAFT",
      "PREPARATION",
    ])
    const before = await tx.sessionOpeningProgress.findUnique({
      where: { sessionId },
      select: { noTablesConfirmedAt: true },
    })
    const current = await tx.pokerSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: {
        notes: true,
        isHistorical: true,
        businessDate: true,
        operatedOpenedAt: true,
      },
    })
    const notesChanged =
      input.notes !== undefined && (input.notes ?? null) !== current.notes
    // Jornada histórica: la hora operativa de apertura se corrige aquí
    // (solo SUPERADMIN, nunca futura). Una jornada normal no la tiene.
    let operatedOpenedAt: Date | undefined
    if (input.openingTime !== undefined) {
      if (!current.isHistorical)
        throw new BusinessRuleError(
          "La hora de apertura solo se elige en una jornada histórica."
        )
      if (!can(actor, PERMISSIONS.SESSIONS_HISTORICAL_CREATE))
        throw new ForbiddenError(
          "Solo un superadministrador puede cambiar la hora de una jornada histórica."
        )
      const day = current.businessDate.toISOString().slice(0, 10)
      const at = zonedDateTimeToUtc(day, input.openingTime)
      if (!at) throw new BusinessRuleError("Hora de apertura inválida.")
      if (at.getTime() > Date.now())
        throw new BusinessRuleError(
          "La hora de apertura no puede estar en el futuro."
        )
      if (at.getTime() !== current.operatedOpenedAt?.getTime())
        operatedOpenedAt = at
    }
    if (notesChanged || operatedOpenedAt)
      await tx.pokerSession.update({
        where: { id: sessionId },
        data: {
          ...(notesChanged ? { notes: input.notes ?? null } : {}),
          ...(operatedOpenedAt ? { operatedOpenedAt } : {}),
        },
      })
    const noTables =
      input.noTables === undefined
        ? undefined
        : input.noTables
          ? { noTablesConfirmedAt: new Date(), noTablesConfirmedById: actor.id }
          : { noTablesConfirmedAt: null, noTablesConfirmedById: null }
    const noTablesChanged =
      input.noTables !== undefined &&
      input.noTables !== Boolean(before?.noTablesConfirmedAt)
    await tx.sessionOpeningProgress.upsert({
      where: { sessionId },
      create: {
        sessionId,
        currentStep: input.currentStep ?? 1,
        ...(noTables ?? {}),
        updatedById: actor.id,
      },
      update: {
        ...(input.currentStep !== undefined
          ? { currentStep: input.currentStep }
          : {}),
        ...(noTablesChanged ? noTables : {}),
        updatedById: actor.id,
      },
    })
    if (notesChanged || noTablesChanged || operatedOpenedAt)
      await recordAudit(
        {
          action: AUDIT_ACTIONS.SESSION_OPENING_PROGRESS_SAVED,
          entityType: "PokerSession",
          entityId: sessionId,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            folio: session.folio,
            ...(notesChanged ? { notesChanged: true } : {}),
            ...(noTablesChanged ? { noTables: input.noTables } : {}),
            ...(operatedOpenedAt
              ? {
                  operatedOpenedAt: operatedOpenedAt.toISOString(),
                  previousOperatedOpenedAt:
                    current.operatedOpenedAt?.toISOString() ?? null,
                }
              : {}),
            intervention: isSuperadminIntervention(actor, session),
          },
        },
        tx
      )
    return { saved: true }
  }, SESSION_TX)
}

/**
 * Agrega una mesa del catálogo al plan de la preparación. No abre la mesa,
 * no crea ciclos, no mueve fichas ni dinero: la mesa se abre al confirmar
 * la apertura (o después, desde la sesión abierta). Idempotente.
 */
export async function planOpeningTable(
  actor: SessionUser,
  sessionId: string,
  tableId: string,
  ctx: RequestContext = {}
) {
  try {
    return await prisma.$transaction(async (tx) => {
      const session = await lockForPreparation(tx, actor, sessionId, [
        "PREPARATION",
      ])
      const table = await tx.pokerTable.findUnique({
        where: { id: tableId },
        select: { id: true, name: true, isActive: true },
      })
      if (!table) throw new NotFoundError("Mesa no encontrada")
      if (!table.isActive)
        throw new BusinessRuleError(
          `La mesa ${table.name} está desactivada en el catálogo.`
        )
      const existing = await tx.sessionOpeningTable.findFirst({
        where: { sessionId, tableId, removedAt: null },
        select: { id: true },
      })
      if (existing) return { planId: existing.id, replayed: true }
      const created = await tx.sessionOpeningTable.create({
        data: { sessionId, tableId, addedById: actor.id },
        select: { id: true },
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.SESSION_OPENING_TABLE_PLANNED,
          entityType: "PokerSession",
          entityId: sessionId,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            folio: session.folio,
            table: table.name,
            tableId,
            intervention: isSuperadminIntervention(actor, session),
          },
        },
        tx
      )
      return { planId: created.id, replayed: false }
    }, SESSION_TX)
  } catch (error) {
    // Doble clic simultáneo: el índice único parcial dejó pasar solo una.
    if (isUniqueViolation(error)) {
      const existing = await prisma.sessionOpeningTable.findFirst({
        where: { sessionId, tableId, removedAt: null },
        select: { id: true },
      })
      if (existing) return { planId: existing.id, replayed: true }
    }
    throw error
  }
}

/** Quita una mesa del plan (queda el registro con quién y cuándo). Idempotente. */
export async function unplanOpeningTable(
  actor: SessionUser,
  sessionId: string,
  tableId: string,
  ctx: RequestContext = {}
) {
  return prisma.$transaction(async (tx) => {
    const session = await lockForPreparation(tx, actor, sessionId, [
      "PREPARATION",
    ])
    const row = await tx.sessionOpeningTable.findFirst({
      where: { sessionId, tableId, removedAt: null },
      select: { id: true, table: { select: { name: true } } },
    })
    if (!row) return { removed: false }
    await tx.sessionOpeningTable.update({
      where: { id: row.id },
      data: { removedAt: new Date(), removedById: actor.id },
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.SESSION_OPENING_TABLE_UNPLANNED,
        entityType: "PokerSession",
        entityId: sessionId,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          folio: session.folio,
          table: row.table.name,
          tableId,
          intervention: isSuperadminIntervention(actor, session),
        },
      },
      tx
    )
    return { removed: true }
  }, SESSION_TX)
}
