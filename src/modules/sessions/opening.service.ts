import "server-only"

import { Prisma } from "@/generated/prisma/client"
import {
  AppError,
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@/lib/errors"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import { cashBalanceOf, lockCashBalance } from "@/modules/cash/ledger"
import {
  cancelCashReconciliation,
  confirmCashReconciliation,
  createCashReconciliation,
  getCashReconciliation,
} from "@/modules/cash/reconciliation.service"
import {
  lockChipSet,
  sharedChipSetId,
} from "@/modules/inventory/inventory.core"
import {
  createStockCount,
  getStockCount,
} from "@/modules/inventory/stock-count.service"
import { assertPreparationAccess } from "@/modules/sessions/session-access"
import type { OpeningCashInput } from "@/modules/sessions/session.schemas"
import {
  getSession,
  lockSession,
  SESSION_TX,
  transitionInTx,
} from "@/modules/sessions/session.service"
import {
  canManagePreparation,
  isSuperadminIntervention,
  PREPARATION_FORBIDDEN_MESSAGE,
} from "@/modules/sessions/session.state"

/**
 * APERTURA OPERATIVA (Módulo 06). La única forma válida de abrir es:
 *
 *   CREAR → PREPARAR → CONTAR EL INVENTARIO COMPARTIDO → CONCILIAR →
 *   CONFIRMAR EFECTIVO FÍSICO $0 → CONFIRMAR APERTURA
 *
 * Ningún rol (tampoco SUPERADMIN) omite estos controles. El checklist se
 * DERIVA de registros reales (arqueo de fichas OPENING de la sesión, arqueo
 * de efectivo OPENING, versión del inventario, circulación, libro de caja);
 * no hay booleanos editables. La apertura se confirma dentro de una
 * transacción que bloquea la sesión, el inventario compartido y el efectivo
 * de la sesión, y vuelve a evaluar todo antes de escribir.
 */

type Db = Prisma.TransactionClient | typeof prisma

export type ChecklistStepId =
  | "SESSION_CREATED"
  | "IN_PREPARATION"
  | "CHIPS_COUNTED"
  | "CHIP_COUNT_CONFIRMED"
  | "DIFFERENCES_RECONCILED"
  | "INVENTORY_CURRENT"
  | "NO_PENDING_CIRCULATION"
  | "CASH_COUNTED"
  | "CASH_ZERO_CONFIRMED"
  | "USER_AUTHORIZED"

export type ChecklistStep = {
  id: ChecklistStepId
  label: string
  status: "DONE" | "PENDING" | "BLOCKED"
  completedAt: string | null
  completedBy: { id: string; name: string } | null
  message: string | null
}

export type OpeningChecklist = {
  sessionId: string
  folio: string
  status: string
  ready: boolean
  steps: ChecklistStep[]
  blockers: string[]
  chipCountId: string | null
  cashReconciliationId: string | null
  /** Mesas abiertas al confirmar: siempre 0 (se abren después, Módulo 07). */
  initialOpenTables: 0
}

const money = (v: Prisma.Decimal) =>
  `$${v.toNumber().toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const user = { select: { id: true, name: true } } as const

/** Evalúa el checklist con el cliente dado (dentro de la transacción de apertura, con bloqueos). */
export async function computeOpeningChecklist(
  db: Db,
  sessionId: string,
  actor: { id: string; role: string }
): Promise<OpeningChecklist> {
  const session = await db.pokerSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      folio: true,
      status: true,
      createdAt: true,
      preparationStartedAt: true,
      createdById: true,
      createdBy: { select: { id: true, name: true, isActive: true } },
    },
  })
  if (!session) throw new NotFoundError("Sesión no encontrada")

  const set = await db.chipSet.findFirst({
    where: { isActive: true },
    select: {
      id: true,
      inventoryState: {
        select: {
          version: true,
          initializedAt: true,
          circulationNominal: true,
        },
      },
    },
  })
  const [count, cashRec, legacyCirculation, activeReservations] =
    await Promise.all([
      db.chipStockCount.findFirst({
        where: {
          sessionId,
          countType: "OPENING",
          status: { not: "CANCELLED" },
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          reconciliationStatus: true,
          resultingInventoryVersion: true,
          createdAt: true,
          confirmedAt: true,
          reconciledAt: true,
          countedBy: user,
          confirmedBy: user,
          reconciledBy: user,
          details: { select: { countedQuantity: true } },
        },
      }),
      db.cashReconciliation.findFirst({
        where: {
          sessionId,
          reconciliationType: "OPENING",
          status: { not: "CANCELLED" },
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          countedAmount: true,
          balanceVersion: true,
          createdAt: true,
          confirmedAt: true,
          createdBy: user,
          confirmedBy: user,
        },
      }),
      set
        ? db.chipInventoryBalance.aggregate({
            where: { chipSetId: set.id, location: "CIRCULATION" },
            _sum: { quantity: true },
          })
        : null,
      set
        ? db.chipReservation.count({
            where: { chipSetId: set.id, status: "ACTIVE" },
          })
        : 0,
    ])
  const [cash, cashMovements] = await Promise.all([
    cashBalanceOf(db, sessionId),
    db.cashTransaction.count({ where: { sessionId } }),
  ])

  const steps: ChecklistStep[] = []
  const step = (
    id: ChecklistStepId,
    label: string,
    status: ChecklistStep["status"],
    extra: Partial<Omit<ChecklistStep, "id" | "label" | "status">> = {}
  ) =>
    steps.push({
      id,
      label,
      status,
      completedAt: extra.completedAt ?? null,
      completedBy: extra.completedBy ?? null,
      message: extra.message ?? null,
    })
  const iso = (d: Date | null | undefined) => d?.toISOString() ?? null

  step("SESSION_CREATED", "Sesión creada", "DONE", {
    completedAt: iso(session.createdAt),
    completedBy: { id: session.createdBy.id, name: session.createdBy.name },
  })

  if (session.status === "DRAFT") {
    step("IN_PREPARATION", "Sesión en preparación", "PENDING", {
      message: "Inicia la preparación de la sesión.",
    })
  } else if (session.status === "CANCELLED") {
    step("IN_PREPARATION", "Sesión en preparación", "BLOCKED", {
      message: "La sesión fue cancelada.",
    })
  } else {
    step("IN_PREPARATION", "Sesión en preparación", "DONE", {
      completedAt: iso(session.preparationStartedAt),
    })
  }

  const initialized = Boolean(set?.inventoryState?.initializedAt)
  const counted =
    count &&
    count.details.length > 0 &&
    count.details.every((d) => d.countedQuantity !== null)
  if (!set) {
    step("CHIPS_COUNTED", "Inventario compartido contado", "BLOCKED", {
      message: "No hay un inventario de fichas activo.",
    })
  } else if (!initialized) {
    step("CHIPS_COUNTED", "Inventario compartido contado", "BLOCKED", {
      message:
        "Registra primero el inventario inicial de fichas (Inventario → Fichas).",
    })
  } else if (!count) {
    step("CHIPS_COUNTED", "Inventario compartido contado", "PENDING", {
      message: "Falta contar el inventario de fichas.",
    })
  } else if (!counted) {
    step("CHIPS_COUNTED", "Inventario compartido contado", "PENDING", {
      message: "Captura la cantidad contada de todas las denominaciones.",
    })
  } else {
    step("CHIPS_COUNTED", "Inventario compartido contado", "DONE", {
      completedBy: count.countedBy,
    })
  }

  const confirmed = count?.status === "CONFIRMED"
  step(
    "CHIP_COUNT_CONFIRMED",
    "Arqueo de fichas confirmado",
    confirmed ? "DONE" : "PENDING",
    confirmed
      ? {
          completedAt: iso(count!.confirmedAt),
          completedBy: count!.confirmedBy,
        }
      : { message: "Falta confirmar el arqueo de fichas." }
  )

  if (!confirmed) {
    step("DIFFERENCES_RECONCILED", "Diferencias conciliadas", "PENDING", {
      message: "Primero confirma el arqueo.",
    })
  } else if (count!.reconciliationStatus === "PENDING") {
    step("DIFFERENCES_RECONCILED", "Diferencias conciliadas", "BLOCKED", {
      message: "Existen diferencias pendientes de conciliar.",
    })
  } else if (count!.reconciliationStatus === "RECONCILED") {
    step("DIFFERENCES_RECONCILED", "Diferencias conciliadas", "DONE", {
      completedAt: iso(count!.reconciledAt),
      completedBy: count!.reconciledBy,
    })
  } else {
    step("DIFFERENCES_RECONCILED", "Diferencias conciliadas", "DONE", {
      completedAt: iso(count!.confirmedAt),
      message: "Sin diferencias.",
    })
  }

  const version = set?.inventoryState?.version ?? null
  if (!confirmed || count!.reconciliationStatus === "PENDING") {
    step("INVENTORY_CURRENT", "Inventario vigente", "PENDING", {
      message: "Requiere un arqueo confirmado y conciliado.",
    })
  } else if (count!.resultingInventoryVersion !== version) {
    step("INVENTORY_CURRENT", "Inventario vigente", "BLOCKED", {
      message:
        "Hubo movimientos de fichas después del arqueo: vuelve a contar el inventario.",
    })
  } else {
    step("INVENTORY_CURRENT", "Inventario vigente", "DONE")
  }

  // Módulo 12 (DEC-20/21/22): las fichas que no regresaron al cerrar una
  // sesión siguen identificadas como valor nominal EN CIRCULACIÓN (pendiente
  // de retorno) de forma global y continua entre sesiones. No es un faltante
  // del arqueo (el esperado es solo lo que está bajo custodia) y NO bloquea
  // abrir; se informa. Sí bloquean las reservas activas y la circulación por
  // denominación del modelo anterior (inconsistencia que debe conciliarse).
  const circulation = new Prisma.Decimal(
    set?.inventoryState?.circulationNominal ?? 0
  )
  const legacy = legacyCirculation?._sum.quantity ?? 0
  const label = "Sin reservas pendientes; circulación identificada"
  if (legacy > 0) {
    step("NO_PENDING_CIRCULATION", label, "BLOCKED", {
      message: `Hay ${legacy} fichas en circulación registradas por denominación (modelo anterior): registra su devolución o concilia el inventario antes de abrir.`,
    })
  } else if (activeReservations > 0) {
    step("NO_PENDING_CIRCULATION", label, "BLOCKED", {
      message: `Hay ${activeReservations} reserva(s) de fichas activas de operaciones anteriores.`,
    })
  } else {
    step(
      "NO_PENDING_CIRCULATION",
      label,
      "DONE",
      circulation.greaterThan(0)
        ? {
            message: `${money(circulation)} siguen fuera de custodia por sesiones cerradas ANTES de la conciliación global (registro histórico por revisar; nadie se lleva fichas): no bloquean la apertura.`,
          }
        : {}
    )
  }

  step(
    "CASH_COUNTED",
    "Caja física contada",
    cashRec ? "DONE" : "PENDING",
    cashRec
      ? { completedAt: iso(cashRec.createdAt), completedBy: cashRec.createdBy }
      : { message: "Cuenta físicamente el efectivo de la caja." }
  )

  if (!cashRec || cashRec.status !== "CONFIRMED") {
    step("CASH_ZERO_CONFIRMED", "Caja inicial confirmada en $0.00", "PENDING", {
      message: "La caja física debe confirmarse en $0.00.",
    })
  } else if (!new Prisma.Decimal(cashRec.countedAmount).isZero()) {
    step("CASH_ZERO_CONFIRMED", "Caja inicial confirmada en $0.00", "BLOCKED", {
      message: `Se contaron ${money(new Prisma.Decimal(cashRec.countedAmount))}: retira el efectivo, resuelve su procedencia y vuelve a contar ($0.00).`,
    })
  } else if (
    !cash.balance.isZero() ||
    cashMovements > 0 ||
    cash.version !== cashRec.balanceVersion
  ) {
    step("CASH_ZERO_CONFIRMED", "Caja inicial confirmada en $0.00", "BLOCKED", {
      message:
        "Hubo movimientos de efectivo después del conteo: vuelve a confirmar la caja en $0.00.",
    })
  } else {
    step("CASH_ZERO_CONFIRMED", "Caja inicial confirmada en $0.00", "DONE", {
      completedAt: iso(cashRec.confirmedAt),
      completedBy: cashRec.confirmedBy,
    })
  }

  if (canManagePreparation(actor, session)) {
    step("USER_AUTHORIZED", "Usuario autorizado para abrir", "DONE")
  } else {
    step("USER_AUTHORIZED", "Usuario autorizado para abrir", "BLOCKED", {
      message: session.createdBy.isActive
        ? PREPARATION_FORBIDDEN_MESSAGE
        : "Quien creó la sesión está desactivado: solo un superadministrador puede continuarla.",
    })
  }

  const blockers = steps
    .filter((s) => s.status !== "DONE")
    .map((s) => s.message ?? s.label)
  return {
    sessionId: session.id,
    folio: session.folio,
    status: session.status,
    ready: session.status === "PREPARATION" && blockers.length === 0,
    steps,
    blockers,
    chipCountId: count?.id ?? null,
    cashReconciliationId: cashRec?.id ?? null,
    initialOpenTables: 0,
  }
}

export function getOpeningChecklist(
  sessionId: string,
  actor: { id: string; role: string }
) {
  return computeOpeningChecklist(prisma, sessionId, actor)
}

// ── Integración con inventario (Módulo 04) ────────────────────────────

/** Estado del arqueo de apertura de la sesión (o null si aún no hay). */
export async function getOpeningInventoryStatus(sessionId: string) {
  const count = await prisma.chipStockCount.findFirst({
    where: { sessionId, countType: "OPENING", status: { not: "CANCELLED" } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  })
  return count ? getStockCount(count.id) : null
}

/**
 * Inicia (o retoma) el arqueo OPENING del inventario COMPARTIDO para la
 * sesión: uno solo para ambas mesas. Las capturas, confirmación y
 * conciliación usan el motor del Módulo 04, que aplica la regla del creador.
 */
export async function createOpeningChipCount(
  actor: SessionUser,
  sessionId: string,
  ctx: RequestContext = {}
) {
  await assertPreparationAccess(prisma, actor, sessionId)
  const latest = await prisma.chipStockCount.findFirst({
    where: { sessionId, countType: "OPENING", status: { not: "CANCELLED" } },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, reconciliationStatus: true },
  })
  if (latest?.status === "DRAFT")
    return { count: await getStockCount(latest.id), resumed: true }
  if (latest?.reconciliationStatus === "PENDING") {
    throw new BusinessRuleError(
      "El arqueo de apertura tiene diferencias sin conciliar: concílialas antes de volver a contar."
    )
  }
  if (latest) {
    const view = await getStockCount(latest.id)
    // Vigente: no se repite el conteo innecesariamente.
    if (view.current) return { count: view, resumed: true }
  }
  const chipSetId = await sharedChipSetId(prisma)
  const count = await createStockCount(
    actor,
    { chipSetId, countType: "OPENING" },
    { ...ctx, sessionId }
  )
  const session = await prisma.pokerSession.findUniqueOrThrow({
    where: { id: sessionId },
    select: { id: true, folio: true, createdById: true },
  })
  await recordAudit({
    action: AUDIT_ACTIONS.SESSION_OPENING_COUNT_STARTED,
    entityType: "PokerSession",
    entityId: sessionId,
    actorUserId: actor.id,
    requestId: ctx.requestId,
    metadata: {
      folio: session.folio,
      chipStockCountId: count.id,
      intervention: isSuperadminIntervention(actor, session),
    },
  })
  return { count, resumed: false }
}

/** true si la sesión cumple todos los controles de inventario del checklist. */
export async function validateInventoryReadyForOpening(
  sessionId: string,
  actor: { id: string; role: string }
) {
  const c = await getOpeningChecklist(sessionId, actor)
  const ids: ChecklistStepId[] = [
    "CHIPS_COUNTED",
    "CHIP_COUNT_CONFIRMED",
    "DIFFERENCES_RECONCILED",
    "INVENTORY_CURRENT",
    "NO_PENDING_CIRCULATION",
  ]
  return c.steps
    .filter((s) => ids.includes(s.id))
    .every((s) => s.status === "DONE")
}

// ── Integración con caja (Módulo 05) ──────────────────────────────────

/**
 * Registra el conteo físico de la caja inicial (arqueo de efectivo OPENING,
 * esperado SIEMPRE $0). No crea ningún movimiento de dinero (tampoco de $0).
 * Si se cuenta dinero queda como evidencia y BLOQUEA la apertura hasta que
 * se retire y se vuelva a contar.
 */
export async function confirmOpeningCashCount(
  actor: SessionUser,
  sessionId: string,
  input: OpeningCashInput,
  ctx: RequestContext = {}
) {
  const session = await assertPreparationAccess(prisma, actor, sessionId)
  const drafts = await prisma.cashReconciliation.findMany({
    where: { sessionId, reconciliationType: "OPENING", status: "DRAFT" },
    select: { id: true },
  })
  for (const d of drafts) await cancelCashReconciliation(actor, d.id, ctx)
  const created = await createCashReconciliation(
    actor,
    {
      sessionId,
      reconciliationType: "OPENING",
      countedAmount: input.countedAmount,
      notes: input.explanation,
    },
    ctx
  )
  const confirmed = await confirmCashReconciliation(
    actor,
    created.id,
    { explanation: input.explanation },
    ctx
  )
  await recordAudit({
    action: AUDIT_ACTIONS.SESSION_OPENING_CASH_CONFIRMED,
    entityType: "PokerSession",
    entityId: sessionId,
    actorUserId: actor.id,
    requestId: ctx.requestId,
    metadata: {
      folio: session.folio,
      cashReconciliationId: confirmed.id,
      countedAmount: confirmed.countedAmount,
      physicallyVerified: true,
      intervention: session.intervention,
    },
  })
  return confirmed
}

/** true si el efectivo inicial está confirmado en $0 y sigue vigente. */
export async function validateZeroOpeningCash(
  sessionId: string,
  actor: { id: string; role: string }
) {
  const c = await getOpeningChecklist(sessionId, actor)
  return c.steps.find((s) => s.id === "CASH_ZERO_CONFIRMED")?.status === "DONE"
}

// ── Confirmar apertura ────────────────────────────────────────────────

/**
 * PREPARATION → OPEN. Atómica e idempotente:
 * - bloquea la sesión (dos confirmaciones simultáneas se serializan), el
 *   inventario compartido (ningún movimiento de fichas se cuela) y el
 *   efectivo de la sesión;
 * - re-evalúa el checklist dentro de la transacción;
 * - registra la evidencia (`SessionOpening`, única por sesión) con la hora
 *   del SERVIDOR; no acepta fechas del cliente; no exige mesas.
 */
export async function openSession(
  actor: SessionUser,
  sessionId: string,
  input: { idempotencyKey: string },
  ctx: RequestContext = {}
) {
  let replayed = false
  try {
    await prisma.$transaction(async (tx) => {
      const session = await lockSession(tx, sessionId)
      if (session.status === "OPEN") {
        const opening = await tx.sessionOpening.findUnique({
          where: { sessionId },
          select: { idempotencyKey: true },
        })
        if (opening?.idempotencyKey === input.idempotencyKey) {
          replayed = true
          return
        }
        throw new ConflictError(`La sesión ${session.folio} ya está abierta.`)
      }
      if (!canManagePreparation(actor, session))
        throw new ForbiddenError(PREPARATION_FORBIDDEN_MESSAGE)
      if (session.status !== "PREPARATION") {
        throw new ConflictError(
          session.status === "DRAFT"
            ? "Primero inicia la preparación de la sesión."
            : `La sesión ${session.folio} no está en preparación.`
        )
      }

      const chipSetId = await sharedChipSetId(tx)
      const inventory = await lockChipSet(tx, chipSetId)
      await lockCashBalance(tx, sessionId)
      const checklist = await computeOpeningChecklist(tx, sessionId, actor)
      if (!checklist.ready) {
        throw new BusinessRuleError(
          `No se puede abrir la sesión: ${checklist.blockers.join(" ")}`,
          { steps: checklist.steps }
        )
      }

      const now = new Date()
      await tx.sessionOpening.create({
        data: {
          sessionId,
          chipStockCountId: checklist.chipCountId!,
          cashReconciliationId: checklist.cashReconciliationId!,
          confirmedById: actor.id,
          confirmedAt: now,
          inventoryVersion: inventory.version,
          openingCashAmount: 0,
          superadminIntervention: isSuperadminIntervention(actor, session),
          idempotencyKey: input.idempotencyKey,
        },
      })
      await transitionInTx(tx, session, "OPEN", actor, {
        openedAt: now,
        openedById: actor.id,
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.SESSION_OPENED,
          entityType: "PokerSession",
          entityId: sessionId,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            folio: session.folio,
            openedAt: now.toISOString(),
            chipStockCountId: checklist.chipCountId,
            cashReconciliationId: checklist.cashReconciliationId,
            inventoryVersion: inventory.version,
            openingCash: "0.00",
            openTables: 0,
            intervention: isSuperadminIntervention(actor, session),
          },
        },
        tx
      )
      if (isSuperadminIntervention(actor, session)) {
        await recordAudit(
          {
            action: AUDIT_ACTIONS.SESSION_SUPERADMIN_INTERVENTION,
            entityType: "PokerSession",
            entityId: sessionId,
            actorUserId: actor.id,
            requestId: ctx.requestId,
            metadata: {
              folio: session.folio,
              action: "open",
              creatorId: session.createdById,
            },
          },
          tx
        )
      }
    }, SESSION_TX)
  } catch (error) {
    if (isUniqueViolation(error)) {
      const opening = await prisma.sessionOpening.findUnique({
        where: { sessionId },
        select: { idempotencyKey: true },
      })
      if (opening?.idempotencyKey === input.idempotencyKey) replayed = true
      else
        throw new AppError(
          "CONFLICT",
          "La sesión ya fue abierta por otra solicitud."
        )
    } else {
      throw error
    }
  }
  return { session: await getSession(sessionId, actor), replayed }
}

/** Evidencia de apertura con referencias a los arqueos (sin copiar cantidades). */
export async function getOpeningEvidence(sessionId: string) {
  const opening = await prisma.sessionOpening.findUnique({
    where: { sessionId },
    select: {
      id: true,
      confirmedAt: true,
      inventoryVersion: true,
      openingCashAmount: true,
      superadminIntervention: true,
      chipStockCountId: true,
      cashReconciliationId: true,
      confirmedBy: user,
    },
  })
  if (!opening) {
    const exists = await prisma.pokerSession.findUnique({
      where: { id: sessionId },
      select: { id: true },
    })
    if (!exists) throw new NotFoundError("Sesión no encontrada")
    return null
  }
  const [chipCount, cashReconciliation] = await Promise.all([
    getStockCount(opening.chipStockCountId),
    getCashReconciliation(opening.cashReconciliationId),
  ])
  return {
    ...opening,
    confirmedAt: opening.confirmedAt.toISOString(),
    openingCashAmount: opening.openingCashAmount.toFixed(2),
    chipCount,
    cashReconciliation,
  }
}
