import "server-only"

import { Prisma } from "@/generated/prisma/client"
import { BusinessRuleError, NotFoundError } from "@/lib/errors"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import {
  adjustmentDelta,
  availableQuantity,
  nominalValue,
  requestHash,
  sumDecimals,
} from "@/modules/inventory/inventory.math"
import {
  assertAvailable,
  assertInitialized,
  bumpInventoryVersion,
  changeBalance,
  changeNominal,
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
  type OperationView,
  type Tx,
} from "@/modules/inventory/inventory.core"
import type {
  AdjustmentInput,
  MovementsQuery,
  StockEntryInput,
  StockWithdrawalInput,
} from "@/modules/inventory/inventory.schemas"

/**
 * Operaciones administrativas de inventario (entradas, bajas, ajustes) y
 * consultas. Las lecturas nunca modifican inventario. Ninguna operación
 * toca la caja financiera: el valor nominal de las fichas NO es efectivo.
 */

/**
 * Ejecuta una operación idempotente. Si la clave ya existe (reintento,
 * incluso simultáneo) devuelve la operación original sin mover fichas.
 */
export async function runIdempotent(
  key: string,
  hash: string,
  work: (tx: Tx) => Promise<string | { replayOf: string }>
): Promise<OperationView> {
  try {
    const result = await inventoryTx(work)
    if (typeof result === "string")
      return getOperationView(prisma, result, false)
    return getOperationView(prisma, result.replayOf, true)
  } catch (error) {
    // Carrera entre juegos distintos con la misma clave: el UNIQUE decide.
    if (isUniqueViolation(error)) {
      const existing = await prisma.chipInventoryOperation.findUnique({
        where: { idempotencyKey: key },
        select: { id: true, requestHash: true },
      })
      if (existing && existing.requestHash === hash) {
        return getOperationView(prisma, existing.id, true)
      }
    }
    throw error
  }
}

// ── Entradas ──────────────────────────────────────────────────────────

export async function registerStockEntry(
  actor: SessionUser,
  input: StockEntryInput,
  ctx: RequestContext = {}
): Promise<OperationView> {
  const hash = requestHash(input)
  return runIdempotent(input.idempotencyKey, hash, async (tx) => {
    const set = await lockChipSet(tx, input.chipSetId)
    const replay = await findReplay(tx, input.idempotencyKey, hash)
    if (replay) return { replayOf: replay }

    assertInitialized(set)
    if (!set.isActive)
      throw new BusinessRuleError("El juego de fichas está inactivo")
    const container = await primaryContainer(tx, set.id)
    const denominations = await loadDenominations(
      tx,
      set.id,
      input.lines.map((l) => l.denominationId)
    )
    for (const line of input.lines) {
      const d = denominations.get(line.denominationId)!
      if (!d.isActive) {
        throw new BusinessRuleError(
          `La denominación ${denominationLabel(d)} está inactiva: actívala antes de incorporar fichas`
        )
      }
    }

    const op = await createOperation(tx, {
      type: "STOCK_ENTRY",
      chipSetId: set.id,
      containerId: container.id,
      idempotencyKey: input.idempotencyKey,
      requestHash: hash,
      reason: input.reason,
      notes: input.notes,
      actorId: actor.id,
    })
    for (const line of input.lines) {
      const d = denominations.get(line.denominationId)!
      const change = await changeBalance(
        tx,
        {
          chipSetId: set.id,
          containerId: container.id,
          denominationId: d.id,
          location: "CUSTODY",
        },
        line.quantity
      )
      await recordMovement(tx, {
        operationId: op.id,
        chipSetId: set.id,
        container,
        denomination: d,
        movementType: "STOCK_ENTRY",
        quantity: line.quantity,
        fromLocation: null,
        toLocation: "CUSTODY",
        custodyBefore: change.before,
        custodyAfter: change.after,
        reason: input.reason,
        actorId: actor.id,
      })
    }
    const amount = sumDecimals(
      input.lines.map((l) =>
        nominalValue(l.quantity, denominations.get(l.denominationId)!.value)
      )
    )
    const nominal = await changeNominal(tx, set.id, { custody: amount })
    await recordNominalMovement(tx, {
      operationId: op.id,
      chipSetId: set.id,
      movementType: "STOCK_ENTRY",
      amount,
      ...nominal,
      reason: input.reason,
      actorId: actor.id,
    })
    await bumpInventoryVersion(tx, set.id)
    await recordAudit(
      {
        action: AUDIT_ACTIONS.CHIP_STOCK_ENTRY,
        entityType: "ChipInventoryOperation",
        entityId: op.id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          chipSetCode: set.code,
          containerCode: container.code,
          reason: input.reason,
          lines: input.lines.map((l) => ({
            value: denominations.get(l.denominationId)!.value.toFixed(2),
            quantity: l.quantity,
          })),
        },
      },
      tx
    )
    return op.id
  })
}

// ── Bajas ─────────────────────────────────────────────────────────────

/**
 * Baja definitiva: custodia → retiradas. Solo de fichas DISPONIBLES en el
 * maletín (no reservadas, no en circulación). No es un gasto financiero.
 */
export async function registerStockWithdrawal(
  actor: SessionUser,
  input: StockWithdrawalInput,
  ctx: RequestContext = {}
): Promise<OperationView> {
  const hash = requestHash(input)
  return runIdempotent(input.idempotencyKey, hash, async (tx) => {
    const set = await lockChipSet(tx, input.chipSetId)
    const replay = await findReplay(tx, input.idempotencyKey, hash)
    if (replay) return { replayOf: replay }

    assertInitialized(set)
    const container = await primaryContainer(tx, set.id)
    const denominations = await loadDenominations(
      tx,
      set.id,
      input.lines.map((l) => l.denominationId)
    )
    for (const line of input.lines) {
      const d = denominations.get(line.denominationId)!
      await assertAvailable(
        tx,
        { chipSetId: set.id, containerId: container.id, denominationId: d.id },
        line.quantity,
        denominationLabel(d)
      )
    }
    const amount = sumDecimals(
      input.lines.map((l) =>
        nominalValue(l.quantity, denominations.get(l.denominationId)!.value)
      )
    )

    const op = await createOperation(tx, {
      type: "STOCK_WITHDRAWAL",
      chipSetId: set.id,
      containerId: container.id,
      idempotencyKey: input.idempotencyKey,
      requestHash: hash,
      reason: input.reason,
      notes: input.notes,
      withdrawalCategory: input.category,
      actorId: actor.id,
    })
    for (const line of input.lines) {
      const d = denominations.get(line.denominationId)!
      const base = {
        chipSetId: set.id,
        containerId: container.id,
        denominationId: d.id,
      }
      const custody = await changeBalance(
        tx,
        { ...base, location: "CUSTODY" },
        -line.quantity
      )
      await changeBalance(tx, { ...base, location: "RETIRED" }, line.quantity)
      await recordMovement(tx, {
        operationId: op.id,
        chipSetId: set.id,
        container,
        denomination: d,
        movementType: "STOCK_WITHDRAWAL",
        quantity: line.quantity,
        fromLocation: "CUSTODY",
        toLocation: "RETIRED",
        custodyBefore: custody.before,
        custodyAfter: custody.after,
        reason: input.reason,
        actorId: actor.id,
      })
    }
    // Nunca bajo lo reservado para compras en curso (saldo nominal).
    const nominal = await changeNominal(tx, set.id, { custody: amount.neg() })
    await recordNominalMovement(tx, {
      operationId: op.id,
      chipSetId: set.id,
      movementType: "STOCK_WITHDRAWAL",
      amount,
      ...nominal,
      reason: input.reason,
      actorId: actor.id,
    })
    await bumpInventoryVersion(tx, set.id)
    await recordAudit(
      {
        action: AUDIT_ACTIONS.CHIP_STOCK_WITHDRAWAL,
        entityType: "ChipInventoryOperation",
        entityId: op.id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          chipSetCode: set.code,
          containerCode: container.code,
          category: input.category,
          reason: input.reason,
          lines: input.lines.map((l) => ({
            value: denominations.get(l.denominationId)!.value.toFixed(2),
            quantity: l.quantity,
          })),
        },
      },
      tx
    )
    return op.id
  })
}

// ── Ajustes ───────────────────────────────────────────────────────────

/**
 * Ajuste de inventario (faltante, sobrante, corrección). Los tres roles
 * pueden registrarlo sin aprobación adicional; el motivo es obligatorio y
 * queda el saldo anterior y el resultante en el movimiento.
 */
export async function registerInventoryAdjustment(
  actor: SessionUser,
  input: AdjustmentInput,
  ctx: RequestContext = {}
): Promise<OperationView> {
  const hash = requestHash(input)
  return runIdempotent(input.idempotencyKey, hash, async (tx) => {
    const set = await lockChipSet(tx, input.chipSetId)
    const replay = await findReplay(tx, input.idempotencyKey, hash)
    if (replay) return { replayOf: replay }

    assertInitialized(set)
    const container = await primaryContainer(tx, set.id)
    const d = (await loadDenominations(tx, set.id, [input.denominationId])).get(
      input.denominationId
    )!
    const delta = adjustmentDelta(input.kind, input.quantity, input.direction)
    const key = {
      chipSetId: set.id,
      containerId: container.id,
      denominationId: d.id,
    }
    if (delta < 0) await assertAvailable(tx, key, -delta, denominationLabel(d))

    const op = await createOperation(tx, {
      type: "INVENTORY_ADJUSTMENT",
      chipSetId: set.id,
      containerId: container.id,
      idempotencyKey: input.idempotencyKey,
      requestHash: hash,
      reason: input.reason,
      notes: input.notes,
      adjustmentKind: input.kind,
      actorId: actor.id,
    })
    const change = await changeBalance(
      tx,
      { ...key, location: "CUSTODY" },
      delta
    )
    await recordMovement(tx, {
      operationId: op.id,
      chipSetId: set.id,
      container,
      denomination: d,
      movementType: "INVENTORY_ADJUSTMENT",
      quantity: Math.abs(delta),
      fromLocation: delta < 0 ? "CUSTODY" : null,
      toLocation: delta > 0 ? "CUSTODY" : null,
      custodyBefore: change.before,
      custodyAfter: change.after,
      reason: input.reason,
      actorId: actor.id,
    })
    const amount = nominalValue(delta, d.value)
    const nominal = await changeNominal(tx, set.id, { custody: amount })
    await recordNominalMovement(tx, {
      operationId: op.id,
      chipSetId: set.id,
      movementType: "INVENTORY_ADJUSTMENT",
      amount,
      ...nominal,
      reason: input.reason,
      actorId: actor.id,
    })
    await bumpInventoryVersion(tx, set.id)
    await recordAudit(
      {
        action: AUDIT_ACTIONS.CHIP_INVENTORY_ADJUSTED,
        entityType: "ChipInventoryOperation",
        entityId: op.id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          chipSetCode: set.code,
          containerCode: container.code,
          denominationValue: d.value.toFixed(2),
          kind: input.kind,
          direction: input.direction ?? null,
          quantity: input.quantity,
          custodyBefore: change.before,
          custodyAfter: change.after,
          reason: input.reason,
        },
      },
      tx
    )
    return op.id
  })
}

// ── Consultas ─────────────────────────────────────────────────────────

export type DenominationStock = {
  denominationId: string
  value: string
  name: string | null
  color: string | null
  isActive: boolean
  custody: number
  reserved: number
  available: number
  circulation: number
  retired: number
  activeInventory: number
  custodyNominal: string
  activeNominal: string
}

export type ChipSetInventory = {
  chipSet: { id: string; code: string; name: string; isActive: boolean }
  container: { id: string; code: string; name: string } | null
  initialized: boolean
  initializedAt: string | null
  version: number
  totals: {
    custody: number
    reserved: number
    available: number
    circulation: number
    retired: number
    activeInventory: number
    custodyNominal: string
    availableNominal: string
    circulationNominal: string
    activeNominal: string
  }
  /**
   * SALDO NOMINAL operativo (fuente de verdad para compras). Las cantidades
   * de `denominations`/`totals` son la composición de referencia del último
   * arqueo: exactas solo si `nominal.breakdownExact`.
   */
  nominal: {
    custody: string
    reserved: string
    available: string
    circulation: string
    breakdownExact: boolean
  }
  denominations: DenominationStock[]
  lastCountAt: string | null
  pendingDifferences: number
  hasDraftCount: boolean
}

async function buildChipSetInventory(
  chipSetId: string
): Promise<ChipSetInventory> {
  const set = await prisma.chipSet.findUnique({
    where: { id: chipSetId },
    select: {
      id: true,
      code: true,
      name: true,
      isActive: true,
      inventoryState: {
        select: {
          version: true,
          initializedAt: true,
          custodyNominal: true,
          reservedNominal: true,
          circulationNominal: true,
          breakdownExact: true,
        },
      },
      containers: {
        where: { isPrimary: true, isActive: true },
        select: { id: true, code: true, name: true },
        take: 1,
      },
      denominations: {
        orderBy: [{ value: "asc" }],
        select: {
          id: true,
          value: true,
          name: true,
          color: true,
          isActive: true,
        },
      },
      inventoryBalances: {
        select: {
          denominationId: true,
          location: true,
          quantity: true,
          reserved: true,
        },
      },
    },
  })
  if (!set) throw new NotFoundError("Juego de fichas no encontrado")

  const [lastCount, pendingDifferences, draft] = await Promise.all([
    prisma.chipStockCount.findFirst({
      where: { chipSetId, status: "CONFIRMED" },
      orderBy: { confirmedAt: "desc" },
      select: { confirmedAt: true },
    }),
    prisma.chipStockCount.count({
      where: { chipSetId, reconciliationStatus: "PENDING" },
    }),
    prisma.chipStockCount.count({ where: { chipSetId, status: "DRAFT" } }),
  ])

  const denominations: DenominationStock[] = set.denominations
    .map((d) => {
      const rows = set.inventoryBalances.filter(
        (b) => b.denominationId === d.id
      )
      const sumOf = (loc: string) =>
        rows
          .filter((r) => r.location === loc)
          .reduce((acc, r) => acc + r.quantity, 0)
      const custody = sumOf("CUSTODY")
      const reserved = rows
        .filter((r) => r.location === "CUSTODY")
        .reduce((acc, r) => acc + r.reserved, 0)
      const circulation = sumOf("CIRCULATION")
      return {
        denominationId: d.id,
        value: d.value.toFixed(2),
        name: d.name,
        color: d.color,
        isActive: d.isActive,
        custody,
        reserved,
        available: availableQuantity({ custody, reserved }),
        circulation,
        retired: sumOf("RETIRED"),
        activeInventory: custody + circulation,
        custodyNominal: nominalValue(custody, d.value).toFixed(2),
        activeNominal: nominalValue(custody + circulation, d.value).toFixed(2),
      }
    })
    // Inactivas solo si aún tienen fichas (ARQ-03).
    .filter((d) => d.isActive || d.activeInventory > 0 || d.retired > 0)

  const total = (f: (d: DenominationStock) => number) =>
    denominations.reduce((acc, d) => acc + f(d), 0)
  const nominal = (f: (d: DenominationStock) => number) =>
    sumDecimals(denominations.map((d) => nominalValue(f(d), d.value))).toFixed(
      2
    )

  return {
    chipSet: {
      id: set.id,
      code: set.code,
      name: set.name,
      isActive: set.isActive,
    },
    container: set.containers[0] ?? null,
    initialized: Boolean(set.inventoryState?.initializedAt),
    initializedAt: set.inventoryState?.initializedAt?.toISOString() ?? null,
    version: set.inventoryState?.version ?? 0,
    totals: {
      custody: total((d) => d.custody),
      reserved: total((d) => d.reserved),
      available: total((d) => d.available),
      circulation: total((d) => d.circulation),
      retired: total((d) => d.retired),
      activeInventory: total((d) => d.activeInventory),
      custodyNominal: nominal((d) => d.custody),
      availableNominal: nominal((d) => d.available),
      circulationNominal: nominal((d) => d.circulation),
      activeNominal: nominal((d) => d.activeInventory),
    },
    nominal: (() => {
      const st = set.inventoryState
      const custody = new Prisma.Decimal(st?.custodyNominal ?? 0)
      const reserved = new Prisma.Decimal(st?.reservedNominal ?? 0)
      return {
        custody: custody.toFixed(2),
        reserved: reserved.toFixed(2),
        available: custody.sub(reserved).toFixed(2),
        circulation: new Prisma.Decimal(st?.circulationNominal ?? 0).toFixed(2),
        breakdownExact: st?.breakdownExact ?? true,
      }
    })(),
    denominations,
    lastCountAt: lastCount?.confirmedAt?.toISOString() ?? null,
    pendingDifferences,
    hasDraftCount: draft > 0,
  }
}

/**
 * Resumen del inventario. Hay UN inventario activo compartido por todas las
 * mesas; un juego inactivo solo aparece si aún conserva fichas (nunca se
 * muestran dos saldos físicos como inventarios independientes).
 */
export async function getInventorySummary(): Promise<ChipSetInventory[]> {
  const sets = await prisma.chipSet.findMany({
    where: {
      OR: [
        { isActive: true },
        {
          inventoryBalances: {
            some: { OR: [{ quantity: { gt: 0 } }, { reserved: { gt: 0 } }] },
          },
        },
      ],
    },
    orderBy: { code: "desc" },
    select: { id: true },
  })
  return Promise.all(sets.map((s) => buildChipSetInventory(s.id)))
}

export function getInventoryByChipSet(chipSetId: string) {
  return buildChipSetInventory(chipSetId)
}

/** Disponibles de una denominación (para compras futuras). Solo lectura. */
export async function getAvailableStock(
  chipSetId: string,
  denominationId: string
) {
  const container = await primaryContainer(prisma, chipSetId)
  const custody = await readBalance(prisma, {
    chipSetId,
    containerId: container.id,
    denominationId,
    location: "CUSTODY",
  })
  return availableQuantity({
    custody: custody.quantity,
    reserved: custody.reserved,
  })
}

export async function getCirculatingStock(
  chipSetId: string,
  denominationId: string
) {
  const container = await primaryContainer(prisma, chipSetId)
  const row = await readBalance(prisma, {
    chipSetId,
    containerId: container.id,
    denominationId,
    location: "CIRCULATION",
  })
  return row.quantity
}

export async function listContainers() {
  const containers = await prisma.chipContainer.findMany({
    orderBy: { code: "desc" },
    select: {
      id: true,
      code: true,
      name: true,
      description: true,
      isPrimary: true,
      isActive: true,
      chipSet: { select: { id: true, code: true, name: true } },
    },
  })
  return containers
}

export type MovementView = {
  id: string
  createdAt: string
  movementType: string
  quantity: number
  fromLocation: string | null
  toLocation: string | null
  custodyBefore: number
  custodyAfter: number
  unitValue: string
  nominalValue: string
  reason: string | null
  referenceType: string | null
  referenceId: string | null
  containerCode: string
  operationId: string
  stockCountId: string | null
  chipSet: { id: string; code: string; name: string }
  denomination: { id: string; color: string | null; name: string | null }
  /** Mesa/sesión/jugador de origen (solo trazabilidad: el stock es común). */
  table: { id: string; name: string } | null
  sessionId: string | null
  player: { id: string; name: string } | null
  createdBy: { id: string; name: string } | null
}

export async function listMovements(query: MovementsQuery) {
  const where: Prisma.ChipInventoryMovementWhereInput = {}
  if (query.chipSetId) where.chipSetId = query.chipSetId
  if (query.tableId) where.tableId = query.tableId
  if (query.type) where.movementType = query.type
  if (query.denominationId) where.denominationId = query.denominationId
  if (query.userId) where.createdById = query.userId
  if (query.from || query.to) {
    where.createdAt = {
      ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
      ...(query.to
        ? {
            lt: new Date(
              new Date(`${query.to}T00:00:00.000Z`).getTime() + 86_400_000
            ),
          }
        : {}),
    }
  }

  const [total, rows] = await prisma.$transaction([
    prisma.chipInventoryMovement.count({ where }),
    prisma.chipInventoryMovement.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        id: true,
        createdAt: true,
        movementType: true,
        quantity: true,
        fromLocation: true,
        toLocation: true,
        custodyBefore: true,
        custodyAfter: true,
        unitValue: true,
        reason: true,
        referenceType: true,
        referenceId: true,
        containerCode: true,
        operationId: true,
        operation: { select: { stockCountId: true } },
        chipSet: { select: { id: true, code: true, name: true } },
        denomination: { select: { id: true, color: true, name: true } },
        table: { select: { id: true, name: true } },
        sessionId: true,
        player: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
      },
    }),
  ])

  const items: MovementView[] = rows.map(({ operation, ...m }) => ({
    ...m,
    createdAt: m.createdAt.toISOString(),
    unitValue: m.unitValue.toFixed(2),
    nominalValue: nominalValue(m.quantity, m.unitValue).toFixed(2),
    stockCountId: operation.stockCountId,
  }))

  return {
    items,
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  }
}

/** Opciones de filtro del historial (inventario, mesas, denominaciones y usuarios con movimientos). */
export async function movementFilterOptions() {
  const [chipSets, tables, users] = await Promise.all([
    prisma.chipSet.findMany({
      where: { OR: [{ isActive: true }, { inventoryMovements: { some: {} } }] },
      orderBy: { code: "desc" },
      select: {
        id: true,
        name: true,
        denominations: {
          orderBy: { value: "asc" },
          select: { id: true, value: true, color: true },
        },
      },
    }),
    prisma.pokerTable.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true },
    }),
    prisma.user.findMany({
      where: { chipMovements: { some: {} } },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ])
  return {
    chipSets: chipSets.map((s) => ({
      ...s,
      denominations: s.denominations.map((d) => ({
        ...d,
        value: d.value.toFixed(2),
      })),
    })),
    tables,
    users,
  }
}

/** Libro NOMINAL (entregas y devoluciones por importe, y el valor de toda operación). */
export async function listNominalMovements(query: MovementsQuery) {
  const where: Prisma.ChipNominalMovementWhereInput = {}
  if (query.chipSetId) where.chipSetId = query.chipSetId
  if (query.tableId) where.tableId = query.tableId
  if (query.type) where.movementType = query.type
  if (query.userId) where.createdById = query.userId
  if (query.from || query.to) {
    where.createdAt = {
      ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
      ...(query.to
        ? {
            lt: new Date(
              new Date(`${query.to}T00:00:00.000Z`).getTime() + 86_400_000
            ),
          }
        : {}),
    }
  }
  const [total, rows] = await prisma.$transaction([
    prisma.chipNominalMovement.count({ where }),
    prisma.chipNominalMovement.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        id: true,
        createdAt: true,
        movementType: true,
        amount: true,
        custodyBefore: true,
        custodyAfter: true,
        circulationBefore: true,
        circulationAfter: true,
        reason: true,
        referenceType: true,
        referenceId: true,
        sessionId: true,
        operationId: true,
        table: { select: { id: true, name: true } },
        player: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
      },
    }),
  ])
  return {
    items: rows.map((m) => ({
      ...m,
      createdAt: m.createdAt.toISOString(),
      amount: m.amount.toFixed(2),
      custodyBefore: m.custodyBefore.toFixed(2),
      custodyAfter: m.custodyAfter.toFixed(2),
      circulationBefore: m.circulationBefore.toFixed(2),
      circulationAfter: m.circulationAfter.toFixed(2),
    })),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  }
}
export type NominalMovementView = Awaited<
  ReturnType<typeof listNominalMovements>
>["items"][number]
