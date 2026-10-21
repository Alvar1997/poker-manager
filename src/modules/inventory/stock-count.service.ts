import "server-only"

import { Prisma } from "@/generated/prisma/client"
import {
  AppError,
  BusinessRuleError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import {
  assertAvailable,
  assertInitialized,
  bumpInventoryVersion,
  changeBalance,
  changeNominal,
  currentInventoryVersion,
  readNominal,
  recordNominalMovement,
  createOperation,
  denominationLabel,
  findReplay,
  getOperationView,
  inventoryTx,
  loadDenominations,
  lockChipSet,
  primaryContainer,
  readBalance,
  recordMovement,
  type LockedChipSet,
  type OperationView,
  type Tx,
} from "@/modules/inventory/inventory.core"
import {
  countDifference,
  nominalValue,
  requestHash,
  sumDecimals,
} from "@/modules/inventory/inventory.math"
import type {
  CountsQuery,
  CreateCountInput,
  InitialStockInput,
  ReconcileCountInput,
  UpdateCountInput,
} from "@/modules/inventory/inventory.schemas"
import { assertPreparationAccess } from "@/modules/sessions/session-access"

/**
 * Motor ÚNICO de arqueos (INITIAL, OPENING, CONTROL, CLOSING). El módulo de
 * sesiones lo reutiliza para apertura y cierre.
 *
 * CONTROL NOMINAL (compras por importe): el ESPERADO total es el saldo
 * nominal bajo custodia; el conteo físico por denominación da el valor
 * real. Las cantidades esperadas por denominación son la composición de
 * referencia y solo son exactas si no hubo entregas/devoluciones por
 * importe desde el último arqueo (`breakdownExact`). Si no lo son, la
 * diferencia que cuenta es la del VALOR total y la composición se actualiza
 * a lo contado (COMPOSITION_UPDATE) sin inventar desgloses anteriores.
 *
 * - Esperado = fichas BAJO CUSTODIA (incluye reservadas aún en el maletín,
 *   ARQ-18; nunca las que están en circulación, ARQ-19).
 * - Guardar o ver un borrador NO modifica inventario (REC-01/02).
 * - Confirmar exige que las existencias no hayan cambiado desde que se
 *   calculó el esperado (`inventoryVersion`, ARQ-16/17) y deja un snapshot
 *   inmutable (triggers en la base). Confirmar NO ajusta (ARQ-12).
 * - Conciliar es explícito, con motivo, transaccional y único: el ajuste
 *   queda ligado al arqueo y no puede aplicarse dos veces (ARQ-13/15).
 * - El inventario inicial es un arqueo INITIAL que al confirmarse crea las
 *   existencias (una sola vez por juego: índice único parcial).
 */

type CountType = "INITIAL" | "OPENING" | "CONTROL" | "CLOSING"

export type StockCountView = {
  id: string
  chipSet: { id: string; code: string; name: string }
  container: { id: string; code: string; name: string }
  countType: CountType
  status: "DRAFT" | "CONFIRMED" | "CANCELLED"
  reconciliationStatus: "NOT_REQUIRED" | "PENDING" | "RECONCILED" | "SUPERSEDED"
  /** Borrador cuyo esperado ya no coincide con las existencias actuales. */
  stale: boolean
  /** Las cantidades esperadas por denominación son exactas (si no, solo cuenta el valor total). */
  breakdownExact: boolean
  /** Versión del inventario tras los efectos del arqueo: vigente mientras coincida con la actual. */
  resultingInventoryVersion: number | null
  /** Confirmado y sin movimientos de inventario posteriores. */
  current: boolean
  sessionId: string | null
  complete: boolean
  inventoryVersion: number
  expectedTotal: string
  countedTotal: string
  differenceTotal: string
  notes: string | null
  reconciliationReason: string | null
  reconciliationOperationId: string | null
  createdAt: string
  confirmedAt: string | null
  reconciledAt: string | null
  countedBy: { id: string; name: string } | null
  confirmedBy: { id: string; name: string } | null
  reconciledBy: { id: string; name: string } | null
  details: {
    denominationId: string
    unitValue: string
    color: string | null
    name: string | null
    isActive: boolean
    expectedQuantity: number
    countedQuantity: number | null
    differenceQuantity: number | null
    differenceNominal: string | null
  }[]
}

const actor = { select: { id: true, name: true } } as const

const countSelect = {
  id: true,
  countType: true,
  status: true,
  reconciliationStatus: true,
  inventoryVersion: true,
  expectedTotal: true,
  countedTotal: true,
  differenceTotal: true,
  notes: true,
  reconciliationReason: true,
  reconciliationOperationId: true,
  breakdownExact: true,
  resultingInventoryVersion: true,
  sessionId: true,
  createdAt: true,
  confirmedAt: true,
  reconciledAt: true,
  chipSet: {
    select: {
      id: true,
      code: true,
      name: true,
      inventoryState: { select: { version: true } },
    },
  },
  container: { select: { id: true, code: true, name: true } },
  countedBy: actor,
  confirmedBy: actor,
  reconciledBy: actor,
  details: {
    orderBy: { unitValue: "asc" },
    select: {
      denominationId: true,
      unitValue: true,
      expectedQuantity: true,
      countedQuantity: true,
      differenceQuantity: true,
      denomination: { select: { color: true, name: true, isActive: true } },
    },
  },
} satisfies Prisma.ChipStockCountSelect

type CountRecord = Prisma.ChipStockCountGetPayload<{
  select: typeof countSelect
}>

function toView(c: CountRecord): StockCountView {
  const currentVersion = c.chipSet.inventoryState?.version ?? 0
  return {
    id: c.id,
    chipSet: { id: c.chipSet.id, code: c.chipSet.code, name: c.chipSet.name },
    container: c.container,
    countType: c.countType,
    status: c.status,
    reconciliationStatus: c.reconciliationStatus,
    stale: c.status === "DRAFT" && c.inventoryVersion !== currentVersion,
    breakdownExact: c.breakdownExact,
    resultingInventoryVersion: c.resultingInventoryVersion,
    current:
      c.status === "CONFIRMED" &&
      c.reconciliationStatus !== "PENDING" &&
      c.resultingInventoryVersion === currentVersion,
    sessionId: c.sessionId,
    complete:
      c.details.length > 0 &&
      c.details.every((d) => d.countedQuantity !== null),
    inventoryVersion: c.inventoryVersion,
    expectedTotal: c.expectedTotal.toFixed(2),
    countedTotal: c.countedTotal.toFixed(2),
    differenceTotal: c.differenceTotal.toFixed(2),
    notes: c.notes,
    reconciliationReason: c.reconciliationReason,
    reconciliationOperationId: c.reconciliationOperationId,
    createdAt: c.createdAt.toISOString(),
    confirmedAt: c.confirmedAt?.toISOString() ?? null,
    reconciledAt: c.reconciledAt?.toISOString() ?? null,
    countedBy: c.countedBy,
    confirmedBy: c.confirmedBy,
    reconciledBy: c.reconciledBy,
    details: c.details.map((d) => {
      const diff =
        d.countedQuantity === null
          ? null
          : countDifference(d.expectedQuantity, d.countedQuantity)
      return {
        denominationId: d.denominationId,
        unitValue: d.unitValue.toFixed(2),
        color: d.denomination.color,
        name: d.denomination.name,
        isActive: d.denomination.isActive,
        expectedQuantity: d.expectedQuantity,
        countedQuantity: d.countedQuantity,
        differenceQuantity: diff,
        differenceNominal:
          diff === null ? null : nominalValue(diff, d.unitValue).toFixed(2),
      }
    }),
  }
}

export async function getStockCount(id: string): Promise<StockCountView> {
  const count = await prisma.chipStockCount.findUnique({
    where: { id },
    select: countSelect,
  })
  if (!count) throw new NotFoundError("Arqueo no encontrado")
  return toView(count)
}

export async function listStockCounts(query: CountsQuery) {
  const where: Prisma.ChipStockCountWhereInput = {}
  if (query.chipSetId) where.chipSetId = query.chipSetId
  if (query.status) where.status = query.status
  if (query.reconciliationStatus)
    where.reconciliationStatus = query.reconciliationStatus
  const [total, rows] = await prisma.$transaction([
    prisma.chipStockCount.count({ where }),
    prisma.chipStockCount.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: countSelect,
    }),
  ])
  return {
    items: rows.map(toView),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  }
}

/** Denominaciones a contar: activas, o inactivas que aún tienen fichas bajo custodia (ARQ-03). */
async function expectedLines(
  tx: Tx,
  set: LockedChipSet,
  containerId: string,
  initial: boolean
) {
  const denominations = await tx.chipDenomination.findMany({
    where: { chipSetId: set.id },
    orderBy: { value: "asc" },
    select: { id: true, value: true, isActive: true },
  })
  const lines: {
    denominationId: string
    unitValue: Prisma.Decimal
    expectedQuantity: number
  }[] = []
  for (const d of denominations) {
    const custody = initial
      ? 0
      : (
          await readBalance(tx, {
            chipSetId: set.id,
            containerId,
            denominationId: d.id,
            location: "CUSTODY",
          })
        ).quantity
    if (d.isActive || custody > 0) {
      lines.push({
        denominationId: d.id,
        unitValue: d.value,
        expectedQuantity: custody,
      })
    }
  }
  if (lines.length === 0) {
    throw new BusinessRuleError(
      "El inventario no tiene denominaciones activas. Configúralas en Configuración → Inventario de fichas."
    )
  }
  return lines
}

/**
 * Crea un arqueo en borrador con el esperado calculado bajo bloqueo.
 * `sessionId` queda disponible para OPENING/CLOSING del módulo de sesiones.
 */
const INACTIVE_SET_MESSAGE =
  "Ese juego de fichas está inactivo: se opera sobre el inventario general compartido"

export async function createStockCount(
  actorUser: SessionUser,
  input:
    | CreateCountInput
    | { chipSetId: string; countType: CountType; notes?: string | null },
  ctx: RequestContext & { sessionId?: string } = {}
): Promise<StockCountView> {
  try {
    const id = await inventoryTx(async (tx) => {
      const set = await lockChipSet(tx, input.chipSetId)
      if (!set.isActive) throw new BusinessRuleError(INACTIVE_SET_MESSAGE)
      await assertSessionCountAccess(tx, actorUser, {
        sessionId: ctx.sessionId ?? null,
        countType: input.countType,
      })
      const initial = input.countType === "INITIAL"
      if (initial && set.initializedAt) {
        throw new BusinessRuleError(
          "El inventario inicial ya fue registrado: las correcciones se hacen con ajustes"
        )
      }
      if (!initial) assertInitialized(set)
      const container = await primaryContainer(tx, set.id)
      const lines = await expectedLines(tx, set, container.id, initial)
      const nominal = await readNominal(tx, set.id)

      const created = await tx.chipStockCount.create({
        data: {
          chipSetId: set.id,
          containerId: container.id,
          countType: input.countType,
          inventoryVersion: set.version,
          notes: input.notes ?? null,
          sessionId: ctx.sessionId ?? null,
          countedById: actorUser.id,
          // Esperado = saldo NOMINAL bajo custodia (no la suma de cantidades
          // de referencia, que pueden no ser exactas).
          expectedTotal: initial ? 0 : nominal.custody,
          breakdownExact: initial ? true : nominal.breakdownExact,
        },
        select: { id: true },
      })
      // createMany (no anidado): chipSetId forma parte de la FK compuesta
      // con el arqueo y de la FK con la denominación.
      await tx.chipStockCountDetail.createMany({
        data: lines.map((l) => ({
          stockCountId: created.id,
          chipSetId: set.id,
          denominationId: l.denominationId,
          unitValue: l.unitValue,
          expectedQuantity: l.expectedQuantity,
        })),
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.CHIP_COUNT_CREATED,
          entityType: "ChipStockCount",
          entityId: created.id,
          actorUserId: actorUser.id,
          requestId: ctx.requestId,
          metadata: {
            chipSetCode: set.code,
            containerCode: container.code,
            countType: input.countType,
          },
        },
        tx
      )
      return created.id
    })
    return getStockCount(id)
  } catch (error) {
    if (isUniqueViolation(error)) {
      const draft = await prisma.chipStockCount.findFirst({
        where: { chipSetId: input.chipSetId, status: "DRAFT" },
        select: { id: true },
      })
      throw new AppError(
        "CONFLICT",
        "Ya hay un arqueo en borrador del inventario: termínalo o cancélalo antes de iniciar otro",
        { existingCountId: draft?.id ?? null }
      )
    }
    throw error
  }
}

/**
 * Un arqueo de APERTURA solo lo opera quien creó la sesión o SUPERADMIN, y
 * solo en PREPARATION (aplica también a los endpoints genéricos: no hay
 * atajo). El arqueo de CIERRE (Módulo 12) lo prepara cualquier rol con
 * permiso de operar sesiones (DEC-05), pero solo con la sesión en CLOSING.
 */
async function assertSessionCountAccess(
  tx: Tx,
  actorUser: SessionUser,
  count: { sessionId: string | null; countType: CountType }
) {
  if (!count.sessionId) return
  if (count.countType === "CLOSING") {
    const session = await tx.pokerSession.findUnique({
      where: { id: count.sessionId },
      select: { folio: true, status: true },
    })
    if (!session) throw new NotFoundError("Sesión no encontrada")
    if (session.status !== "CLOSING") {
      throw new BusinessRuleError(
        `El arqueo de cierre requiere que la sesión ${session.folio} esté en cierre.`
      )
    }
    return
  }
  await assertPreparationAccess(tx, actorUser, count.sessionId, ["PREPARATION"])
}

/** Los arqueos de cierre de una sesión solo se confirman/concilian desde el cierre (Módulo 12). */
export const CLOSING_COUNT_VIA_CLOSURE_MESSAGE =
  "El arqueo de cierre de una sesión se confirma y se concilia desde el cierre de sesión (diferencias y ajustes autorizados)."

function assertNotClosureCount(
  count: { sessionId: string | null; countType: CountType },
  viaClosure: boolean
) {
  if (count.countType === "CLOSING" && count.sessionId && !viaClosure) {
    throw new BusinessRuleError(CLOSING_COUNT_VIA_CLOSURE_MESSAGE)
  }
}

async function lockDraft(tx: Tx, countId: string) {
  const head = await tx.chipStockCount.findUnique({
    where: { id: countId },
    select: { chipSetId: true },
  })
  if (!head) throw new NotFoundError("Arqueo no encontrado")
  const set = await lockChipSet(tx, head.chipSetId)
  const count = await tx.chipStockCount.findUniqueOrThrow({
    where: { id: countId },
    select: {
      id: true,
      status: true,
      countType: true,
      containerId: true,
      inventoryVersion: true,
      reconciliationStatus: true,
      expectedTotal: true,
      differenceTotal: true,
      breakdownExact: true,
      sessionId: true,
      details: {
        select: {
          id: true,
          denominationId: true,
          unitValue: true,
          expectedQuantity: true,
          countedQuantity: true,
        },
      },
    },
  })
  return { set, count }
}

/** Captura de cantidades / notas / actualización del esperado (solo DRAFT). */
export async function updateStockCount(
  actorUser: SessionUser,
  countId: string,
  input: UpdateCountInput
): Promise<StockCountView> {
  await inventoryTx(async (tx) => {
    const { set, count } = await lockDraft(tx, countId)
    await assertSessionCountAccess(tx, actorUser, count)
    if (count.status !== "DRAFT") {
      throw new BusinessRuleError(
        "Solo se puede capturar un arqueo en borrador"
      )
    }

    if (input.refreshExpected) {
      // ARQ-17: recalcular y exigir nueva verificación donde cambió el esperado.
      const lines = await expectedLines(
        tx,
        set,
        count.containerId,
        count.countType === "INITIAL"
      )
      for (const line of lines) {
        const existing = count.details.find(
          (d) => d.denominationId === line.denominationId
        )
        if (!existing) {
          await tx.chipStockCountDetail.create({
            data: {
              stockCountId: count.id,
              chipSetId: set.id,
              denominationId: line.denominationId,
              unitValue: line.unitValue,
              expectedQuantity: line.expectedQuantity,
            },
          })
        } else if (existing.expectedQuantity !== line.expectedQuantity) {
          await tx.chipStockCountDetail.update({
            where: { id: existing.id },
            data: {
              expectedQuantity: line.expectedQuantity,
              countedQuantity: null,
              differenceQuantity: null,
            },
          })
        }
      }
      const nominal = await readNominal(tx, set.id)
      await tx.chipStockCount.update({
        where: { id: count.id },
        data: {
          inventoryVersion: set.version,
          expectedTotal: count.countType === "INITIAL" ? 0 : nominal.custody,
          breakdownExact:
            count.countType === "INITIAL" ? true : nominal.breakdownExact,
        },
      })
    }

    if (input.lines) {
      for (const line of input.lines) {
        const detail = count.details.find(
          (d) => d.denominationId === line.denominationId
        )
        if (!detail) {
          throw new ValidationError(
            "La denominación no forma parte de este arqueo",
            [{ path: "lines", message: "Denominación ajena al arqueo" }]
          )
        }
        await tx.chipStockCountDetail.update({
          where: { id: detail.id },
          data: { countedQuantity: line.countedQuantity },
        })
      }
    }

    await tx.chipStockCount.update({
      where: { id: count.id },
      data: {
        countedById: actorUser.id,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
    })
  })
  return getStockCount(countId)
}

export async function cancelStockCount(
  actorUser: SessionUser,
  countId: string,
  ctx: RequestContext = {}
): Promise<StockCountView> {
  await inventoryTx(async (tx) => {
    const { set, count } = await lockDraft(tx, countId)
    await assertSessionCountAccess(tx, actorUser, count)
    if (count.status === "CANCELLED") return
    if (count.status !== "DRAFT")
      throw new BusinessRuleError("Un arqueo confirmado no se puede cancelar")
    await tx.chipStockCount.update({
      where: { id: count.id },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.CHIP_COUNT_CANCELLED,
        entityType: "ChipStockCount",
        entityId: count.id,
        actorUserId: actorUser.id,
        requestId: ctx.requestId,
        metadata: { chipSetCode: set.code, countType: count.countType },
      },
      tx
    )
  })
  return getStockCount(countId)
}

/**
 * Confirma un arqueo. Idempotente: si ya estaba confirmado, devuelve el
 * mismo resultado sin volver a aplicar nada. Para INITIAL, crea las
 * existencias iniciales (una sola vez por juego).
 */
export async function confirmStockCount(
  actorUser: SessionUser,
  countId: string,
  idempotencyKey: string,
  ctx: RequestContext = {}
): Promise<StockCountView> {
  try {
    await inventoryTx((tx) =>
      confirmInTx(tx, actorUser, countId, idempotencyKey, ctx, false)
    )
  } catch (error) {
    // Dos confirmaciones simultáneas del inventario inicial: gana una.
    if (isUniqueViolation(error)) {
      const count = await getStockCount(countId)
      if (count.status === "CONFIRMED") return count
    }
    throw error
  }
  return getStockCount(countId)
}

/**
 * Confirmación dentro de una transacción ajena (Módulo 12: el cierre
 * confirma su arqueo y registra la diferencia física en la misma
 * transacción). Mismas reglas que `confirmStockCount`.
 */
export function confirmStockCountInTx(
  tx: Tx,
  actorUser: SessionUser,
  countId: string,
  idempotencyKey: string,
  ctx: RequestContext = {}
) {
  return confirmInTx(tx, actorUser, countId, idempotencyKey, ctx, true)
}

async function confirmInTx(
  tx: Tx,
  actorUser: SessionUser,
  countId: string,
  idempotencyKey: string,
  ctx: RequestContext,
  viaClosure: boolean
) {
  const { set, count } = await lockDraft(tx, countId)
  if (count.status === "CONFIRMED") return // reintento: respuesta segura
  assertNotClosureCount(count, viaClosure)
  await assertSessionCountAccess(tx, actorUser, count)
  if (count.status === "CANCELLED")
    throw new BusinessRuleError("El arqueo fue cancelado")

  const initial = count.countType === "INITIAL"
  if (initial && set.initializedAt) {
    throw new BusinessRuleError(
      "El inventario inicial ya fue registrado: las correcciones se hacen con ajustes"
    )
  }
  if (count.inventoryVersion !== set.version) {
    throw new AppError(
      "CONFLICT",
      "Las existencias cambiaron desde que se calculó el esperado. Actualiza el arqueo y vuelve a verificar el conteo.",
      { stale: true }
    )
  }
  const uncounted = count.details.filter((d) => d.countedQuantity === null)
  if (uncounted.length > 0) {
    throw new ValidationError(
      "Captura la cantidad contada de todas las denominaciones",
      [
        {
          path: "lines",
          message: `${uncounted.length} denominación(es) sin capturar`,
        },
      ]
    )
  }

  // Snapshot: diferencias por denominación y totales nominales (servidor).
  let hasDenominationDifferences = false
  for (const d of count.details) {
    const diff = countDifference(d.expectedQuantity, d.countedQuantity!)
    if (diff !== 0) hasDenominationDifferences = true
    await tx.chipStockCountDetail.update({
      where: { id: d.id },
      data: { differenceQuantity: diff },
    })
  }
  const countedTotal = sumDecimals(
    count.details.map((d) => nominalValue(d.countedQuantity!, d.unitValue))
  )
  // Esperado nominal: el saldo bajo custodia (no cambió: misma versión).
  const expectedTotal = initial
    ? countedTotal
    : new Prisma.Decimal(count.expectedTotal)
  const valueDifference = countedTotal.sub(expectedTotal)

  if (initial) {
    await applyInitialStock(tx, actorUser, set, count, idempotencyKey, ctx)
  }

  // ARQ-07/09: con composición exacta, "cuadrado" exige cero diferencias
  // por denominación (no basta el total). Sin composición exacta (hubo
  // entregas/devoluciones por importe) solo es comparable el VALOR total.
  const pending =
    !initial &&
    (!valueDifference.isZero() ||
      (count.breakdownExact && hasDenominationDifferences))

  // Sin diferencias de valor pero con composición distinta (no exacta):
  // la composición de referencia pasa a ser lo contado, sin cambio nominal.
  let compositionOperationId: string | null = null
  if (!initial && !pending && hasDenominationDifferences) {
    compositionOperationId = await applyComposition(
      tx,
      actorUser,
      set,
      count,
      "COMPOSITION_UPDATE",
      `composition-${count.id}`,
      "Actualización de composición por arqueo",
      null
    )
  }
  if (!initial && !pending) {
    await tx.chipSetInventoryState.update({
      where: { chipSetId: set.id },
      data: { breakdownExact: true },
    })
  }

  await tx.chipStockCount.update({
    where: { id: count.id },
    data: {
      status: "CONFIRMED",
      reconciliationStatus: pending ? "PENDING" : "NOT_REQUIRED",
      expectedTotal,
      countedTotal,
      differenceTotal: valueDifference,
      compositionOperationId,
      resultingInventoryVersion: await currentInventoryVersion(tx, set.id),
      confirmedById: actorUser.id,
      confirmedAt: new Date(),
    },
  })
  await recordAudit(
    {
      action: AUDIT_ACTIONS.CHIP_COUNT_CONFIRMED,
      entityType: "ChipStockCount",
      entityId: count.id,
      actorUserId: actorUser.id,
      requestId: ctx.requestId,
      metadata: {
        chipSetCode: set.code,
        countType: count.countType,
        sessionId: count.sessionId,
        pending,
        breakdownExact: count.breakdownExact,
        expectedTotal: expectedTotal.toFixed(2),
        countedTotal: countedTotal.toFixed(2),
        valueDifference: valueDifference.toFixed(2),
        compositionUpdated: Boolean(compositionOperationId),
      },
    },
    tx
  )
}

/**
 * Lleva la composición por denominación a lo contado (movimientos por
 * denominación) y, si se indica, ajusta el saldo nominal a `nominalDelta`.
 */
async function applyComposition(
  tx: Tx,
  actorUser: SessionUser,
  set: LockedChipSet,
  count: {
    id: string
    sessionId: string | null
    details: {
      denominationId: string
      expectedQuantity: number
      countedQuantity: number | null
    }[]
  },
  type: "COMPOSITION_UPDATE" | "COUNT_RECONCILIATION",
  idempotencyKey: string,
  reason: string,
  nominalDelta: Prisma.Decimal | null,
  extra: { requestHash?: string; notes?: string | null } = {}
): Promise<string> {
  const container = await primaryContainer(tx, set.id)
  const denominations = await loadDenominations(
    tx,
    set.id,
    count.details.map((d) => d.denominationId)
  )
  const differences = count.details
    .map((d) => ({
      ...d,
      diff: countDifference(d.expectedQuantity, d.countedQuantity!),
    }))
    .filter((d) => d.diff !== 0)
  for (const d of differences.filter((x) => x.diff < 0)) {
    await assertAvailable(
      tx,
      {
        chipSetId: set.id,
        containerId: container.id,
        denominationId: d.denominationId,
      },
      -d.diff,
      denominationLabel(denominations.get(d.denominationId)!)
    )
  }
  const op = await createOperation(tx, {
    type,
    chipSetId: set.id,
    containerId: container.id,
    idempotencyKey,
    requestHash: extra.requestHash ?? requestHash({ countId: count.id, type }),
    reason,
    notes: extra.notes ?? null,
    stockCountId: count.id,
    referenceType: "ChipStockCount",
    referenceId: count.id,
    sessionId: count.sessionId,
    actorId: actorUser.id,
  })
  for (const d of differences) {
    const change = await changeBalance(
      tx,
      {
        chipSetId: set.id,
        containerId: container.id,
        denominationId: d.denominationId,
        location: "CUSTODY",
      },
      d.diff
    )
    await recordMovement(tx, {
      operationId: op.id,
      chipSetId: set.id,
      container,
      denomination: denominations.get(d.denominationId)!,
      movementType:
        type === "COMPOSITION_UPDATE"
          ? "COMPOSITION_UPDATE"
          : "INVENTORY_ADJUSTMENT",
      quantity: Math.abs(d.diff),
      fromLocation: d.diff < 0 ? "CUSTODY" : null,
      toLocation: d.diff > 0 ? "CUSTODY" : null,
      custodyBefore: change.before,
      custodyAfter: change.after,
      reason,
      referenceType: "ChipStockCount",
      referenceId: count.id,
      sessionId: count.sessionId,
      actorId: actorUser.id,
    })
  }
  if (nominalDelta && !nominalDelta.isZero()) {
    const nominal = await changeNominal(
      tx,
      set.id,
      { custody: nominalDelta },
      { breakdownExact: true }
    )
    await recordNominalMovement(tx, {
      operationId: op.id,
      chipSetId: set.id,
      movementType: "INVENTORY_ADJUSTMENT",
      amount: nominalDelta,
      ...nominal,
      reason,
      referenceType: "ChipStockCount",
      referenceId: count.id,
      sessionId: count.sessionId,
      actorId: actorUser.id,
    })
  } else {
    await tx.chipSetInventoryState.update({
      where: { chipSetId: set.id },
      data: { breakdownExact: true },
    })
  }
  await bumpInventoryVersion(tx, set.id)
  return op.id
}

async function applyInitialStock(
  tx: Tx,
  actorUser: SessionUser,
  set: LockedChipSet,
  count: {
    id: string
    containerId: string
    details: { denominationId: string; countedQuantity: number | null }[]
  },
  idempotencyKey: string,
  ctx: RequestContext
) {
  const container = await primaryContainer(tx, set.id)
  const denominations = await loadDenominations(
    tx,
    set.id,
    count.details.map((d) => d.denominationId)
  )
  const op = await createOperation(tx, {
    type: "INITIAL_STOCK",
    chipSetId: set.id,
    containerId: container.id,
    idempotencyKey,
    requestHash: requestHash({ countId: count.id }),
    reason: "Inventario inicial",
    stockCountId: count.id,
    actorId: actorUser.id,
  })
  for (const d of count.details) {
    const denomination = denominations.get(d.denominationId)!
    const quantity = d.countedQuantity ?? 0
    const change = await changeBalance(
      tx,
      {
        chipSetId: set.id,
        containerId: container.id,
        denominationId: d.denominationId,
        location: "CUSTODY",
      },
      quantity
    )
    if (quantity > 0) {
      await recordMovement(tx, {
        operationId: op.id,
        chipSetId: set.id,
        container,
        denomination,
        movementType: "INITIAL_STOCK",
        quantity,
        fromLocation: null,
        toLocation: "CUSTODY",
        custodyBefore: change.before,
        custodyAfter: change.after,
        reason: "Inventario inicial",
        referenceType: "ChipStockCount",
        referenceId: count.id,
        actorId: actorUser.id,
      })
    }
  }
  await tx.chipSetInventoryState.update({
    where: { chipSetId: set.id },
    data: {
      initializedAt: new Date(),
      initializedById: actorUser.id,
      initialCountId: count.id,
    },
  })
  const initialValue = sumDecimals(
    count.details.map((d) =>
      nominalValue(
        d.countedQuantity ?? 0,
        denominations.get(d.denominationId)!.value
      )
    )
  )
  const nominal = await changeNominal(
    tx,
    set.id,
    { custody: initialValue },
    { breakdownExact: true }
  )
  await recordNominalMovement(tx, {
    operationId: op.id,
    chipSetId: set.id,
    movementType: "INITIAL_STOCK",
    amount: initialValue,
    ...nominal,
    reason: "Inventario inicial",
    referenceType: "ChipStockCount",
    referenceId: count.id,
    actorId: actorUser.id,
  })
  await bumpInventoryVersion(tx, set.id)
  await recordAudit(
    {
      action: AUDIT_ACTIONS.CHIP_INITIAL_STOCK_CREATED,
      entityType: "ChipInventoryOperation",
      entityId: op.id,
      actorUserId: actorUser.id,
      requestId: ctx.requestId,
      metadata: {
        chipSetCode: set.code,
        containerCode: container.code,
        stockCountId: count.id,
        lines: count.details.map((d) => ({
          value: denominations.get(d.denominationId)!.value.toFixed(2),
          quantity: d.countedQuantity ?? 0,
        })),
      },
    },
    tx
  )
}

/**
 * Inventario inicial en un paso (captura + confirmación). Exige TODAS las
 * denominaciones activas (INI-02). Reutiliza el borrador INITIAL si existe.
 * Repetir la misma solicitud devuelve el resultado ya registrado.
 */
export async function initializeStock(
  actorUser: SessionUser,
  input: InitialStockInput,
  ctx: RequestContext = {}
): Promise<StockCountView> {
  try {
    const countId = await inventoryTx(async (tx) => {
      const set = await lockChipSet(tx, input.chipSetId)
      const replay = await tx.chipInventoryOperation.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { stockCountId: true, chipSetId: true },
      })
      if (replay?.stockCountId && replay.chipSetId === set.id)
        return replay.stockCountId
      if (replay) {
        throw new AppError(
          "CONFLICT",
          "Esta clave de operación ya se usó para otra operación"
        )
      }
      if (!set.isActive) throw new BusinessRuleError(INACTIVE_SET_MESSAGE)
      if (set.initializedAt) {
        throw new BusinessRuleError(
          "El inventario inicial ya fue registrado: las correcciones se hacen con ajustes"
        )
      }

      const container = await primaryContainer(tx, set.id)
      const active = await tx.chipDenomination.findMany({
        where: { chipSetId: set.id, isActive: true },
        select: { id: true },
      })
      if (active.length === 0) {
        throw new BusinessRuleError(
          "El inventario no tiene denominaciones activas. Configúralas antes del inventario inicial."
        )
      }
      await loadDenominations(
        tx,
        set.id,
        input.lines.map((l) => l.denominationId)
      )
      const provided = new Set(input.lines.map((l) => l.denominationId))
      const missing = active.filter((d) => !provided.has(d.id))
      if (missing.length > 0) {
        throw new ValidationError(
          "Captura todas las denominaciones activas (aunque sea 0)",
          [
            {
              path: "lines",
              message: `Faltan ${missing.length} denominación(es)`,
            },
          ]
        )
      }

      // Reutiliza el borrador INITIAL (INI-05) o crea el arqueo.
      let draft = await tx.chipStockCount.findFirst({
        where: { chipSetId: set.id, status: "DRAFT" },
        select: { id: true, countType: true },
      })
      if (draft && draft.countType !== "INITIAL") {
        throw new BusinessRuleError(
          "Hay otro arqueo en borrador del inventario"
        )
      }
      if (!draft) {
        draft = await tx.chipStockCount.create({
          data: {
            chipSetId: set.id,
            containerId: container.id,
            countType: "INITIAL",
            inventoryVersion: set.version,
            notes: input.notes ?? null,
            countedById: actorUser.id,
          },
          select: { id: true, countType: true },
        })
      }
      await tx.chipStockCountDetail.deleteMany({
        where: { stockCountId: draft.id },
      })
      const denominations = await loadDenominations(
        tx,
        set.id,
        input.lines.map((l) => l.denominationId)
      )
      await tx.chipStockCountDetail.createMany({
        data: input.lines.map((l) => ({
          stockCountId: draft!.id,
          chipSetId: set.id,
          denominationId: l.denominationId,
          unitValue: denominations.get(l.denominationId)!.value,
          expectedQuantity: 0,
          countedQuantity: l.quantity,
        })),
      })
      await tx.chipStockCount.update({
        where: { id: draft.id },
        data: {
          inventoryVersion: set.version,
          countedById: actorUser.id,
          notes: input.notes ?? null,
        },
      })
      await confirmInTx(
        tx,
        actorUser,
        draft.id,
        input.idempotencyKey,
        ctx,
        false
      )
      return draft.id
    })
    return getStockCount(countId)
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new BusinessRuleError(
        "El inventario inicial ya fue registrado: las correcciones se hacen con ajustes"
      )
    }
    throw error
  }
}

/**
 * Concilia las diferencias de un arqueo confirmado con un ajuste explícito
 * ligado al arqueo. Idempotente y único (REC-05): un segundo intento
 * devuelve la conciliación existente sin volver a mover fichas.
 */
export async function reconcileStockCount(
  actorUser: SessionUser,
  countId: string,
  input: ReconcileCountInput,
  ctx: RequestContext = {}
): Promise<{ count: StockCountView; operation: OperationView | null }> {
  const operationId = await inventoryTx((tx) =>
    reconcileInTx(tx, actorUser, countId, input, ctx, false)
  )
  return {
    count: await getStockCount(countId),
    operation: operationId
      ? await getOperationView(prisma, operationId, false)
      : null,
  }
}

/**
 * Conciliación dentro de una transacción ajena: el cierre (Módulo 12) la usa
 * para el AJUSTE EXCEPCIONAL autorizado de su arqueo. Devuelve la operación.
 */
export function reconcileStockCountInTx(
  tx: Tx,
  actorUser: SessionUser,
  countId: string,
  input: ReconcileCountInput,
  ctx: RequestContext = {}
) {
  return reconcileInTx(tx, actorUser, countId, input, ctx, true)
}

/**
 * Sustituye la diferencia PENDIENTE de un arqueo de CIERRE (recuento físico
 * posterior o regreso auditado a OPEN). No mueve inventario ni oculta la
 * diferencia: el arqueo se conserva tal cual, solo deja de estar pendiente.
 */
export async function supersedeClosingCountInTx(tx: Tx, countId: string) {
  const { count } = await tx.chipStockCount.updateMany({
    where: {
      id: countId,
      countType: "CLOSING",
      status: "CONFIRMED",
      reconciliationStatus: "PENDING",
    },
    data: { reconciliationStatus: "SUPERSEDED" },
  })
  return count === 1
}

async function reconcileInTx(
  tx: Tx,
  actorUser: SessionUser,
  countId: string,
  input: ReconcileCountInput,
  ctx: RequestContext,
  viaClosure: boolean
): Promise<string | null> {
  const hash = requestHash({ countId, ...input })
  {
    const { set, count } = await lockDraft(tx, countId)
    assertNotClosureCount(count, viaClosure)
    await assertSessionCountAccess(tx, actorUser, count)
    if (count.status !== "CONFIRMED") {
      throw new BusinessRuleError("Solo se concilian arqueos confirmados")
    }
    if (count.reconciliationStatus === "RECONCILED") {
      const done = await tx.chipStockCount.findUniqueOrThrow({
        where: { id: count.id },
        select: { reconciliationOperationId: true },
      })
      return done.reconciliationOperationId
    }
    if (count.reconciliationStatus !== "PENDING") {
      throw new BusinessRuleError(
        "Este arqueo no tiene diferencias por conciliar"
      )
    }
    const replay = await findReplay(tx, input.idempotencyKey, hash)
    if (replay) return replay

    // Composición → lo contado; saldo nominal → valor contado.
    const operationId = await applyComposition(
      tx,
      actorUser,
      set,
      count,
      "COUNT_RECONCILIATION",
      input.idempotencyKey,
      input.reason,
      new Prisma.Decimal(count.differenceTotal),
      { requestHash: hash, notes: input.notes }
    )
    const op = { id: operationId }
    const differences = count.details
      .map((d) => ({
        denominationId: d.denominationId,
        unitValue: d.unitValue,
        diff: countDifference(d.expectedQuantity, d.countedQuantity!),
      }))
      .filter((d) => d.diff !== 0)

    // Transición condicional: solo PENDING → RECONCILED (y el UNIQUE de
    // reconciliationOperationId impide ligar dos ajustes al mismo arqueo).
    const { count: updated } = await tx.chipStockCount.updateMany({
      where: { id: count.id, reconciliationStatus: "PENDING" },
      data: {
        reconciliationStatus: "RECONCILED",
        reconciliationOperationId: op.id,
        reconciliationReason: input.reason,
        reconciledById: actorUser.id,
        reconciledAt: new Date(),
        resultingInventoryVersion: await currentInventoryVersion(tx, set.id),
      },
    })
    if (updated !== 1)
      throw new AppError("CONFLICT", "El arqueo ya fue conciliado")

    await recordAudit(
      {
        action: AUDIT_ACTIONS.CHIP_COUNT_RECONCILED,
        entityType: "ChipStockCount",
        entityId: count.id,
        actorUserId: actorUser.id,
        requestId: ctx.requestId,
        metadata: {
          chipSetCode: set.code,
          operationId: op.id,
          reason: input.reason,
          valueDifference: new Prisma.Decimal(count.differenceTotal).toFixed(2),
          adjustments: differences.map((d) => ({
            value: new Prisma.Decimal(d.unitValue).toFixed(2),
            difference: d.diff,
          })),
        },
      },
      tx
    )
    return op.id
  }
}
