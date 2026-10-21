import "server-only"

import { Prisma } from "@/generated/prisma/client"
import { AppError, BusinessRuleError, NotFoundError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import { nominalValue, sumDecimals } from "@/modules/inventory/inventory.math"

/**
 * Primitivas transaccionales del inventario de fichas. NADA fuera de este
 * módulo debe escribir en chip_inventory_balances / movements / operations.
 *
 * Concurrencia (BAL-07, sección 21):
 *  1. `lockChipSet` toma `SELECT … FOR UPDATE` sobre el renglón de estado
 *     del inventario. Hay UN inventario compartido por ambas mesas, así que
 *     todas las operaciones de las dos mesas se SERIALIZAN: nunca entregan
 *     las mismas fichas disponibles. Dentro del bloqueo, leer → validar →
 *     escribir es seguro.
 *  2. La base respalda con CHECKs (cantidad ≥ 0, reservado ≤ custodia) y
 *     FK compuestas (no mezclar juegos): aunque un bug saltara la
 *     validación, la transacción falla completa.
 *  3. Idempotencia (sección 22): clave única por operación + huella del
 *     contenido; el reintento se detecta DESPUÉS de tomar el bloqueo, así
 *     que dos envíos simultáneos con la misma clave no duplican nada.
 */

export type Tx = Prisma.TransactionClient
/** Lecturas que pueden ir dentro o fuera de una transacción. */
export type Db = Tx | typeof prisma

/** Margen generoso: Neon puede tardar al "despertar" y las operaciones se serializan por juego. */
export const INVENTORY_TX = { maxWait: 15_000, timeout: 20_000 } as const

export function inventoryTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn, INVENTORY_TX)
}

export type LockedChipSet = {
  id: string
  code: string
  name: string
  isActive: boolean
  version: number
  initializedAt: Date | null
}

export async function lockChipSet(
  tx: Tx,
  chipSetId: string
): Promise<LockedChipSet> {
  const chipSet = await tx.chipSet.findUnique({
    where: { id: chipSetId },
    select: { id: true, code: true, name: true, isActive: true },
  })
  if (!chipSet) throw new NotFoundError("Juego de fichas no encontrado")

  await tx.$executeRaw`
    INSERT INTO "chip_set_inventory_states" ("chipSetId", "version", "updatedAt")
    VALUES (${chipSetId}, 0, NOW())
    ON CONFLICT ("chipSetId") DO NOTHING
  `
  const rows = await tx.$queryRaw<
    { version: number; initializedAt: Date | null }[]
  >`
    SELECT "version", "initializedAt" FROM "chip_set_inventory_states"
    WHERE "chipSetId" = ${chipSetId}
    FOR UPDATE
  `
  return {
    ...chipSet,
    version: rows[0].version,
    initializedAt: rows[0].initializedAt,
  }
}

/**
 * El inventario físico ÚNICO compartido por todas las mesas (el juego
 * activo; la base impide que haya dos). Las operaciones de compras,
 * entregas y devoluciones lo usan cuando no indican un juego.
 */
export async function sharedChipSetId(db: Db): Promise<string> {
  const set = await db.chipSet.findFirst({
    where: { isActive: true },
    select: { id: true },
  })
  if (!set) {
    throw new BusinessRuleError(
      "No hay un inventario de fichas activo. Ejecuta `npm run db:seed`."
    )
  }
  return set.id
}

export async function bumpInventoryVersion(
  tx: Tx,
  chipSetId: string
): Promise<number> {
  const state = await tx.chipSetInventoryState.update({
    where: { chipSetId },
    data: { version: { increment: 1 } },
    select: { version: true },
  })
  return state.version
}

export function assertInitialized(set: LockedChipSet) {
  if (!set.initializedAt) {
    throw new BusinessRuleError(
      `Inventario pendiente de inicialización para ${set.name}: registra primero el inventario inicial`
    )
  }
}

export type ContainerRef = { id: string; code: string; name: string }

/** Ubicación principal activa del inventario (CON-01/08). */
export async function primaryContainer(
  tx: Db,
  chipSetId: string
): Promise<ContainerRef> {
  const container = await tx.chipContainer.findFirst({
    where: { chipSetId, isPrimary: true, isActive: true },
    select: { id: true, code: true, name: true },
  })
  if (!container) {
    throw new BusinessRuleError(
      "Este juego no tiene un maletín principal activo. Ejecuta `npm run db:seed`."
    )
  }
  return container
}

export type DenominationRef = {
  id: string
  value: Prisma.Decimal
  isActive: boolean
  name: string | null
  color: string | null
}

/**
 * Carga denominaciones verificando que TODAS pertenezcan al juego
 * (CHIP-03/05: nunca mezclar juegos).
 */
export async function loadDenominations(
  tx: Tx,
  chipSetId: string,
  ids: string[]
): Promise<Map<string, DenominationRef>> {
  const found = await tx.chipDenomination.findMany({
    where: { chipSetId, id: { in: ids } },
    select: { id: true, value: true, isActive: true, name: true, color: true },
  })
  const map = new Map(found.map((d) => [d.id, d]))
  const missing = ids.filter((id) => !map.has(id))
  if (missing.length > 0) {
    throw new BusinessRuleError(
      "Una o más denominaciones no pertenecen al inventario de fichas",
      { denominationIds: missing }
    )
  }
  return map
}

type Location = "CUSTODY" | "CIRCULATION" | "RETIRED"

export type BalanceKey = {
  chipSetId: string
  containerId: string
  denominationId: string
  location: Location
}

export async function readBalance(tx: Db, key: BalanceKey) {
  const row = await tx.chipInventoryBalance.findUnique({
    where: {
      containerId_denominationId_location: {
        containerId: key.containerId,
        denominationId: key.denominationId,
        location: key.location,
      },
    },
    select: { quantity: true, reserved: true },
  })
  return { quantity: row?.quantity ?? 0, reserved: row?.reserved ?? 0 }
}

export class InsufficientStockError extends AppError {
  constructor(message: string, details: Record<string, unknown>) {
    super("BUSINESS_RULE_ERROR", message, details)
  }
}

/**
 * Aplica un cambio a una existencia. Debe llamarse con el juego bloqueado.
 * Rechaza cantidades negativas y reservas fuera de rango antes de escribir
 * (y la base lo vuelve a impedir con CHECKs).
 */
export async function changeBalance(
  tx: Tx,
  key: BalanceKey,
  deltaQuantity: number,
  deltaReserved = 0
): Promise<{ before: number; after: number; reservedAfter: number }> {
  const current = await readBalance(tx, key)
  const after = current.quantity + deltaQuantity
  const reservedAfter = current.reserved + deltaReserved
  if (after < 0) {
    throw new InsufficientStockError("Existencias insuficientes", {
      denominationId: key.denominationId,
      location: key.location,
      current: current.quantity,
      requested: -deltaQuantity,
    })
  }
  if (reservedAfter < 0 || reservedAfter > after) {
    throw new InsufficientStockError(
      "Las fichas reservadas no pueden usarse para esta operación",
      {
        denominationId: key.denominationId,
        reserved: current.reserved,
        custodyAfter: after,
      }
    )
  }

  await tx.chipInventoryBalance.upsert({
    where: {
      containerId_denominationId_location: {
        containerId: key.containerId,
        denominationId: key.denominationId,
        location: key.location,
      },
    },
    create: {
      chipSetId: key.chipSetId,
      containerId: key.containerId,
      denominationId: key.denominationId,
      location: key.location,
      quantity: after,
      reserved: reservedAfter,
    },
    update: {
      quantity: after,
      reserved: reservedAfter,
      version: { increment: 1 },
    },
  })
  return { before: current.quantity, after, reservedAfter }
}

/** Disponible = custodia − reservadas (BAJ-03/04). Lanza si no alcanza. */
export async function assertAvailable(
  tx: Tx,
  key: Omit<BalanceKey, "location">,
  quantity: number,
  denominationLabel: string
) {
  const custody = await readBalance(tx, { ...key, location: "CUSTODY" })
  const available = custody.quantity - custody.reserved
  if (quantity > available) {
    throw new InsufficientStockError(
      `Solo hay ${available} ficha(s) disponibles de ${denominationLabel} en el maletín` +
        (custody.reserved > 0 ? ` (${custody.reserved} reservadas)` : ""),
      {
        denominationId: key.denominationId,
        available,
        reserved: custody.reserved,
        requested: quantity,
      }
    )
  }
}

/**
 * Contexto operativo de un movimiento del inventario COMPARTIDO: el stock
 * es común a todas las mesas; la mesa, la sesión y el jugador solo trazan
 * el origen (filtros e historial), nunca separan existencias.
 */
export type OperationContext = {
  tableId?: string | null
  sessionId?: string | null
  playerId?: string | null
}

export type OperationHeader = OperationContext & {
  type:
    | "INITIAL_STOCK"
    | "STOCK_ENTRY"
    | "STOCK_WITHDRAWAL"
    | "INVENTORY_ADJUSTMENT"
    | "COUNT_RECONCILIATION"
    | "COMPOSITION_UPDATE"
    | "CHIP_DELIVERY"
    | "CHIP_RETURN"
  chipSetId: string
  containerId: string
  idempotencyKey: string
  requestHash: string
  reason?: string | null
  notes?: string | null
  adjustmentKind?: "SHORTAGE" | "SURPLUS" | "CORRECTION" | null
  withdrawalCategory?:
    "DAMAGE" | "CONFIRMED_LOSS" | "PERMANENT_RETIREMENT" | "OTHER" | null
  referenceType?: string | null
  referenceId?: string | null
  stockCountId?: string | null
  actorId: string | null
}

/**
 * Si la clave ya se usó: devuelve el id de la operación previa (reintento),
 * o lanza 409 si el contenido es distinto. Llamar con el juego bloqueado.
 */
export async function findReplay(
  tx: Tx,
  idempotencyKey: string,
  requestHash: string
): Promise<string | null> {
  const existing = await tx.chipInventoryOperation.findUnique({
    where: { idempotencyKey },
    select: { id: true, requestHash: true },
  })
  if (!existing) return null
  if (existing.requestHash !== requestHash) {
    throw new AppError(
      "CONFLICT",
      "Esta clave de operación ya se usó con datos distintos. Recarga el formulario e intenta de nuevo."
    )
  }
  return existing.id
}

export async function createOperation(tx: Tx, header: OperationHeader) {
  return tx.chipInventoryOperation.create({
    data: {
      type: header.type,
      chipSetId: header.chipSetId,
      containerId: header.containerId,
      idempotencyKey: header.idempotencyKey,
      requestHash: header.requestHash,
      reason: header.reason ?? null,
      notes: header.notes ?? null,
      adjustmentKind: header.adjustmentKind ?? null,
      withdrawalCategory: header.withdrawalCategory ?? null,
      referenceType: header.referenceType ?? null,
      referenceId: header.referenceId ?? null,
      stockCountId: header.stockCountId ?? null,
      tableId: header.tableId ?? null,
      sessionId: header.sessionId ?? null,
      playerId: header.playerId ?? null,
      createdById: header.actorId,
    },
    select: { id: true },
  })
}

export type MovementInput = OperationContext & {
  operationId: string
  chipSetId: string
  container: ContainerRef
  denomination: DenominationRef
  movementType:
    | "COMPOSITION_UPDATE"
    | "INITIAL_STOCK"
    | "STOCK_ENTRY"
    | "STOCK_WITHDRAWAL"
    | "INVENTORY_ADJUSTMENT"
    | "CHIP_DELIVERY"
    | "CHIP_RETURN"
  quantity: number
  fromLocation: Location | null
  toLocation: Location | null
  custodyBefore: number
  custodyAfter: number
  reason?: string | null
  referenceType?: string | null
  referenceId?: string | null
  actorId: string | null
}

export async function recordMovement(tx: Tx, m: MovementInput) {
  await tx.chipInventoryMovement.create({
    data: {
      operationId: m.operationId,
      chipSetId: m.chipSetId,
      containerId: m.container.id,
      containerCode: m.container.code,
      denominationId: m.denomination.id,
      unitValue: m.denomination.value,
      movementType: m.movementType,
      quantity: m.quantity,
      fromLocation: m.fromLocation,
      toLocation: m.toLocation,
      custodyBefore: m.custodyBefore,
      custodyAfter: m.custodyAfter,
      reason: m.reason ?? null,
      referenceType: m.referenceType ?? null,
      referenceId: m.referenceId ?? null,
      tableId: m.tableId ?? null,
      sessionId: m.sessionId ?? null,
      playerId: m.playerId ?? null,
      createdById: m.actorId,
    },
  })
}

// ── Vista de una operación ────────────────────────────────────────────

export type OperationView = {
  id: string
  type: string
  chipSet: { id: string; code: string; name: string }
  containerCode: string
  reason: string | null
  notes: string | null
  adjustmentKind: string | null
  withdrawalCategory: string | null
  stockCountId: string | null
  createdAt: string
  createdBy: { id: string; name: string } | null
  lines: {
    denominationId: string
    unitValue: string
    movementType: string
    quantity: number
    fromLocation: string | null
    toLocation: string | null
    custodyBefore: number
    custodyAfter: number
    nominalValue: string
  }[]
  nominalTotal: string
  /** Movimiento del saldo nominal (entregas y devoluciones solo tienen este). */
  nominal: {
    movementType: string
    amount: string
    custodyBefore: string
    custodyAfter: string
    circulationBefore: string
    circulationAfter: string
  }[]
  /** true si la respuesta corresponde a un reintento (no movió inventario). */
  replayed: boolean
}

export async function getOperationView(
  db: Db,
  operationId: string,
  replayed: boolean
): Promise<OperationView> {
  const op = await db.chipInventoryOperation.findUniqueOrThrow({
    where: { id: operationId },
    select: {
      id: true,
      type: true,
      reason: true,
      notes: true,
      adjustmentKind: true,
      withdrawalCategory: true,
      stockCountId: true,
      createdAt: true,
      chipSet: { select: { id: true, code: true, name: true } },
      container: { select: { code: true } },
      createdBy: { select: { id: true, name: true } },
      movements: {
        orderBy: { unitValue: "asc" },
        select: {
          denominationId: true,
          unitValue: true,
          movementType: true,
          quantity: true,
          fromLocation: true,
          toLocation: true,
          custodyBefore: true,
          custodyAfter: true,
        },
      },
      nominalMovements: {
        orderBy: { createdAt: "asc" },
        select: {
          movementType: true,
          amount: true,
          custodyBefore: true,
          custodyAfter: true,
          circulationBefore: true,
          circulationAfter: true,
        },
      },
    },
  })
  const lines = op.movements.map((m) => ({
    ...m,
    unitValue: m.unitValue.toFixed(2),
    nominalValue: nominalValue(m.quantity, m.unitValue).toFixed(2),
  }))
  return {
    id: op.id,
    type: op.type,
    chipSet: op.chipSet,
    containerCode: op.container.code,
    reason: op.reason,
    notes: op.notes,
    adjustmentKind: op.adjustmentKind,
    withdrawalCategory: op.withdrawalCategory,
    stockCountId: op.stockCountId,
    createdAt: op.createdAt.toISOString(),
    createdBy: op.createdBy,
    lines,
    nominalTotal: (op.movements.length > 0
      ? sumDecimals(
          op.movements.map((m) => nominalValue(m.quantity, m.unitValue))
        )
      : sumDecimals(
          op.nominalMovements.map((m) => new Prisma.Decimal(m.amount))
        )
    ).toFixed(2),
    nominal: op.nominalMovements.map((m) => ({
      movementType: m.movementType,
      amount: m.amount.toFixed(2),
      custodyBefore: m.custodyBefore.toFixed(2),
      custodyAfter: m.custodyAfter.toFixed(2),
      circulationBefore: m.circulationBefore.toFixed(2),
      circulationAfter: m.circulationAfter.toFixed(2),
    })),
    replayed,
  }
}

export function denominationLabel(d: DenominationRef): string {
  return `$${d.value.toFixed(2)}${d.color ? ` (${d.color})` : ""}`
}

// ── Saldo NOMINAL (compras y recompras por importe) ───────────────────

/**
 * El inventario operativo se controla por VALOR NOMINAL compartido:
 * custodia (incluye lo reservado), reservado y en circulación. Las
 * cantidades por denominación son la composición física de referencia que
 * fijan los arqueos; las entregas y devoluciones por importe no tienen
 * desglose y marcan esa composición como no exacta.
 */
export type NominalState = {
  custody: Prisma.Decimal
  reserved: Prisma.Decimal
  circulation: Prisma.Decimal
  available: Prisma.Decimal
  breakdownExact: boolean
}

export async function readNominal(
  db: Db,
  chipSetId: string
): Promise<NominalState> {
  const st = await db.chipSetInventoryState.findUnique({
    where: { chipSetId },
    select: {
      custodyNominal: true,
      reservedNominal: true,
      circulationNominal: true,
      breakdownExact: true,
    },
  })
  const custody = new Prisma.Decimal(st?.custodyNominal ?? 0)
  const reserved = new Prisma.Decimal(st?.reservedNominal ?? 0)
  return {
    custody,
    reserved,
    circulation: new Prisma.Decimal(st?.circulationNominal ?? 0),
    available: custody.sub(reserved),
    breakdownExact: st?.breakdownExact ?? true,
  }
}

const mxn = (v: Prisma.Decimal) =>
  `$${v.toNumber().toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export class InsufficientNominalError extends AppError {
  constructor(available: Prisma.Decimal, requested: Prisma.Decimal) {
    super(
      "BUSINESS_RULE_ERROR",
      `Valor en fichas insuficiente: hay ${mxn(available)} disponibles y se requieren ${mxn(requested)}.`,
      { available: available.toFixed(2), requested: requested.toFixed(2) }
    )
  }
}

/**
 * Cambia el saldo nominal. Llamar con el inventario BLOQUEADO (lockChipSet).
 * Valida antes de escribir: nada negativo y reservado ≤ custodia (la base lo
 * vuelve a exigir con CHECK).
 */
export async function changeNominal(
  tx: Tx,
  chipSetId: string,
  delta: {
    custody?: Prisma.Decimal
    reserved?: Prisma.Decimal
    circulation?: Prisma.Decimal
  },
  options: { breakdownExact?: boolean } = {}
): Promise<{ before: NominalState; after: NominalState }> {
  const before = await readNominal(tx, chipSetId)
  const zero = new Prisma.Decimal(0)
  const custody = before.custody.add(delta.custody ?? zero)
  const reserved = before.reserved.add(delta.reserved ?? zero)
  const circulation = before.circulation.add(delta.circulation ?? zero)
  if (
    custody.isNegative() ||
    reserved.isNegative() ||
    reserved.greaterThan(custody)
  ) {
    const requested = (delta.reserved ?? zero).greaterThan(0)
      ? delta.reserved!
      : (delta.custody ?? zero).neg()
    throw new InsufficientNominalError(before.available, requested)
  }
  if (circulation.isNegative()) {
    throw new BusinessRuleError(
      `El importe excede las fichas en circulación (${mxn(before.circulation)}).`
    )
  }
  const breakdownExact = options.breakdownExact ?? before.breakdownExact
  await tx.chipSetInventoryState.update({
    where: { chipSetId },
    data: {
      custodyNominal: custody,
      reservedNominal: reserved,
      circulationNominal: circulation,
      breakdownExact,
    },
  })
  return {
    before,
    after: {
      custody,
      reserved,
      circulation,
      available: custody.sub(reserved),
      breakdownExact,
    },
  }
}

export type NominalMovementInput = OperationContext & {
  operationId: string
  chipSetId: string
  movementType:
    | "INITIAL_STOCK"
    | "STOCK_ENTRY"
    | "STOCK_WITHDRAWAL"
    | "INVENTORY_ADJUSTMENT"
    | "CHIP_DELIVERY"
    | "CHIP_RETURN"
  amount: Prisma.Decimal
  before: NominalState
  after: NominalState
  reason?: string | null
  referenceType?: string | null
  referenceId?: string | null
  actorId: string | null
}

/** Libro nominal inmutable (trigger). Ignora importes en cero. */
export async function recordNominalMovement(tx: Tx, m: NominalMovementInput) {
  if (m.amount.isZero()) return
  await tx.chipNominalMovement.create({
    data: {
      operationId: m.operationId,
      chipSetId: m.chipSetId,
      movementType: m.movementType,
      amount: m.amount.abs(),
      custodyBefore: m.before.custody,
      custodyAfter: m.after.custody,
      circulationBefore: m.before.circulation,
      circulationAfter: m.after.circulation,
      reason: m.reason ?? null,
      referenceType: m.referenceType ?? null,
      referenceId: m.referenceId ?? null,
      tableId: m.tableId ?? null,
      sessionId: m.sessionId ?? null,
      playerId: m.playerId ?? null,
      createdById: m.actorId,
    },
  })
}

/** Versión actual del inventario (leer dentro del bloqueo). */
export async function currentInventoryVersion(tx: Db, chipSetId: string) {
  const st = await tx.chipSetInventoryState.findUniqueOrThrow({
    where: { chipSetId },
    select: { version: true },
  })
  return st.version
}
