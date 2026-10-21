import "server-only"

import { Prisma } from "@/generated/prisma/client"
import { AppError, BusinessRuleError, NotFoundError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import {
  assertInitialized,
  bumpInventoryVersion,
  changeBalance,
  changeNominal,
  createOperation,
  findReplay,
  getOperationView,
  InsufficientNominalError,
  inventoryTx,
  lockChipSet,
  primaryContainer,
  readNominal,
  recordNominalMovement,
  sharedChipSetId,
  type Db,
  type OperationContext,
  type OperationView,
  type Tx,
} from "@/modules/inventory/inventory.core"
import {
  parseNominalAmount,
  requestHash,
} from "@/modules/inventory/inventory.math"

/**
 * Reservas, entregas y devoluciones por IMPORTE NOMINAL — infraestructura
 * interna para compras/recompras (Módulo 08) y liquidaciones (Módulo 11).
 * No hay endpoints públicos.
 *
 * Regla definitiva: las compras se capturan SOLO por importe. No se pide ni
 * se guarda cuántas fichas de cada denominación se entregan; el cajero elige
 * libremente la combinación física. El inventario operativo es un saldo
 * nominal compartido por ambas mesas; las cantidades por denominación se
 * verifican en los arqueos.
 *
 *   reserveNominalAmount        apartado: custodia igual, reservado += importe
 *   releaseNominalReservation   cancelación: reservado −= importe
 *   confirmNominalChipDelivery  entrega confirmada (una sola vez):
 *                               custodia −, reservado −, circulación +
 *   confirmNominalChipReturn    devolución física: circulación −, custodia +
 *
 * Todas bloquean el inventario compartido (las dos mesas se serializan),
 * son idempotentes y guardan mesa, sesión, jugador y referencia de origen.
 * Entregas y devoluciones vuelven no exacta la composición por denominación
 * hasta el siguiente arqueo.
 */

type Amount = Prisma.Decimal | string

function toAmount(value: Amount): Prisma.Decimal {
  try {
    return parseNominalAmount(value)
  } catch (e) {
    throw new BusinessRuleError(
      e instanceof Error ? e.message : "Importe inválido"
    )
  }
}

// ── Consultas ─────────────────────────────────────────────────────────

/** Valor nominal disponible del inventario compartido (custodia − reservado). */
export async function getAvailableNominalValue(
  chipSetId?: string,
  db: Db = prisma
) {
  const id = chipSetId ?? (await sharedChipSetId(db))
  const n = await readNominal(db, id)
  return {
    chipSetId: id,
    custody: n.custody.toFixed(2),
    reserved: n.reserved.toFixed(2),
    available: n.available.toFixed(2),
    circulation: n.circulation.toFixed(2),
    breakdownExact: n.breakdownExact,
  }
}

/** Verificación previa (sin bloqueo). La garantía real está en la reserva. */
export async function validateNominalAvailability(
  amount: Amount,
  chipSetId?: string
) {
  const requested = toAmount(amount)
  const id = chipSetId ?? (await sharedChipSetId(prisma))
  const n = await readNominal(prisma, id)
  if (n.available.lessThan(requested))
    throw new InsufficientNominalError(n.available, requested)
  return { available: n.available.toFixed(2) }
}

// ── Reservas ──────────────────────────────────────────────────────────

export type NominalReservationInput = OperationContext & {
  chipSetId?: string
  amount: Amount
  referenceType: string
  referenceId: string
  expiresAt: Date
  idempotencyKey: string
}

type ReservationResult = { id: string; status: string; replayed: boolean }

export async function reserveNominalAmountInTx(
  tx: Tx,
  actor: SessionUser,
  input: NominalReservationInput,
  ctx: RequestContext = {}
): Promise<ReservationResult> {
  const set = await lockChipSet(
    tx,
    input.chipSetId ?? (await sharedChipSetId(tx))
  )
  const existing = await tx.chipReservation.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, status: true, referenceType: true, referenceId: true },
  })
  if (existing) {
    if (
      existing.referenceType !== input.referenceType ||
      existing.referenceId !== input.referenceId
    ) {
      throw new AppError(
        "CONFLICT",
        "Clave de reserva reutilizada para otra operación"
      )
    }
    return { id: existing.id, status: existing.status, replayed: true }
  }
  assertInitialized(set)
  if (!set.isActive)
    throw new BusinessRuleError("El inventario de fichas está inactivo")
  if (!input.referenceType || !input.referenceId) {
    throw new BusinessRuleError(
      "Una reserva debe asociarse a una operación concreta"
    )
  }
  if (input.expiresAt.getTime() <= Date.now()) {
    throw new BusinessRuleError("La reserva debe vencer en el futuro")
  }
  const amount = toAmount(input.amount)
  // No descuenta la custodia: solo aparta valor (nunca más del disponible).
  await changeNominal(tx, set.id, { reserved: amount })
  const container = await primaryContainer(tx, set.id)
  const reservation = await tx.chipReservation.create({
    data: {
      chipSetId: set.id,
      containerId: container.id,
      amount,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      idempotencyKey: input.idempotencyKey,
      expiresAt: input.expiresAt,
      tableId: input.tableId ?? null,
      sessionId: input.sessionId ?? null,
      playerId: input.playerId ?? null,
      createdById: actor.id,
    },
    select: { id: true, status: true },
  })
  await recordAudit(
    {
      action: AUDIT_ACTIONS.CHIP_RESERVATION_CREATED,
      entityType: "ChipReservation",
      entityId: reservation.id,
      actorUserId: actor.id,
      requestId: ctx.requestId,
      metadata: {
        chipSetCode: set.code,
        amount: amount.toFixed(2),
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        tableId: input.tableId ?? null,
        sessionId: input.sessionId ?? null,
        playerId: input.playerId ?? null,
      },
    },
    tx
  )
  return { ...reservation, replayed: false }
}

export function reserveNominalAmount(
  actor: SessionUser,
  input: NominalReservationInput,
  ctx: RequestContext = {}
) {
  return inventoryTx((tx) => reserveNominalAmountInTx(tx, actor, input, ctx))
}

async function loadReservation(tx: Tx, reservationId: string) {
  const head = await tx.chipReservation.findUnique({
    where: { id: reservationId },
    select: { chipSetId: true },
  })
  if (!head) throw new NotFoundError("Reserva no encontrada")
  const set = await lockChipSet(tx, head.chipSetId)
  const reservation = await tx.chipReservation.findUniqueOrThrow({
    where: { id: reservationId },
    select: {
      id: true,
      status: true,
      amount: true,
      containerId: true,
      referenceType: true,
      referenceId: true,
      consumeOperationId: true,
      tableId: true,
      sessionId: true,
      playerId: true,
      items: { select: { denominationId: true, quantity: true } },
    },
  })
  return { set, reservation }
}

async function releaseInTx(
  tx: Tx,
  actor: SessionUser | null,
  reservationId: string,
  to: "RELEASED" | "EXPIRED",
  ctx: RequestContext
): Promise<ReservationResult> {
  const { set, reservation } = await loadReservation(tx, reservationId)
  if (reservation.status === to)
    return { id: reservation.id, status: to, replayed: true }
  if (reservation.status !== "ACTIVE") {
    throw new BusinessRuleError(
      reservation.status === "CONSUMED"
        ? "La reserva ya se entregó: no se puede liberar"
        : "La reserva ya no está activa"
    )
  }
  if (reservation.amount) {
    await changeNominal(tx, set.id, {
      reserved: new Prisma.Decimal(reservation.amount).neg(),
    })
  } else {
    // Reserva antigua por denominación (antes de la corrección nominal).
    for (const item of reservation.items) {
      await changeBalance(
        tx,
        {
          chipSetId: set.id,
          containerId: reservation.containerId,
          denominationId: item.denominationId,
          location: "CUSTODY",
        },
        0,
        -item.quantity
      )
    }
  }
  const { count } = await tx.chipReservation.updateMany({
    where: { id: reservation.id, status: "ACTIVE" },
    data: { status: to, releasedAt: new Date() },
  })
  if (count !== 1) throw new AppError("CONFLICT", "La reserva cambió de estado")
  await recordAudit(
    {
      action:
        to === "EXPIRED"
          ? AUDIT_ACTIONS.CHIP_RESERVATION_EXPIRED
          : AUDIT_ACTIONS.CHIP_RESERVATION_RELEASED,
      entityType: "ChipReservation",
      entityId: reservation.id,
      actorUserId: actor?.id ?? null,
      requestId: ctx.requestId,
      metadata: {
        chipSetCode: set.code,
        amount: reservation.amount
          ? new Prisma.Decimal(reservation.amount).toFixed(2)
          : null,
        referenceType: reservation.referenceType,
        referenceId: reservation.referenceId,
      },
    },
    tx
  )
  return { id: reservation.id, status: to, replayed: false }
}

export function releaseNominalReservationInTx(
  tx: Tx,
  actor: SessionUser,
  reservationId: string,
  ctx: RequestContext = {}
) {
  return releaseInTx(tx, actor, reservationId, "RELEASED", ctx)
}

export function releaseNominalReservation(
  actor: SessionUser,
  reservationId: string,
  ctx: RequestContext = {}
) {
  return inventoryTx((tx) =>
    releaseInTx(tx, actor, reservationId, "RELEASED", ctx)
  )
}

/** Libera reservas vencidas (cron). Seguro de repetir. */
export async function expireReservations(now = new Date()): Promise<number> {
  const expired = await prisma.chipReservation.findMany({
    where: { status: "ACTIVE", expiresAt: { lt: now } },
    select: { id: true },
  })
  let count = 0
  for (const r of expired) {
    const result = await inventoryTx((tx) =>
      releaseInTx(tx, null, r.id, "EXPIRED", {})
    )
    if (!result.replayed) count++
  }
  return count
}

// ── Entrega y devolución ──────────────────────────────────────────────

/**
 * Entrega confirmada: descuenta el importe UNA sola vez (al confirmar, no en
 * el borrador). Idempotente: una reserva consumida devuelve la misma operación.
 */
export async function confirmNominalChipDeliveryInTx(
  tx: Tx,
  actor: SessionUser,
  reservationId: string,
  idempotencyKey: string,
  ctx: RequestContext = {}
): Promise<{ operationId: string; replayed: boolean }> {
  const { set, reservation } = await loadReservation(tx, reservationId)
  if (reservation.status === "CONSUMED" && reservation.consumeOperationId) {
    return { operationId: reservation.consumeOperationId, replayed: true }
  }
  if (reservation.status !== "ACTIVE") {
    throw new BusinessRuleError(
      "La reserva ya no está activa: no se puede entregar"
    )
  }
  if (!reservation.amount) {
    throw new BusinessRuleError(
      "Reserva antigua por denominación: libérala y registra la entrega por importe"
    )
  }
  const hash = requestHash({ reservationId })
  const replay = await findReplay(tx, idempotencyKey, hash)
  if (replay) return { operationId: replay, replayed: true }

  const amount = new Prisma.Decimal(reservation.amount)
  const container = await primaryContainer(tx, set.id)
  const context = {
    tableId: reservation.tableId,
    sessionId: reservation.sessionId,
    playerId: reservation.playerId,
  }
  const op = await createOperation(tx, {
    type: "CHIP_DELIVERY",
    chipSetId: set.id,
    containerId: container.id,
    idempotencyKey,
    requestHash: hash,
    referenceType: reservation.referenceType,
    referenceId: reservation.referenceId,
    ...context,
    actorId: actor.id,
  })
  const nominal = await changeNominal(
    tx,
    set.id,
    { custody: amount.neg(), reserved: amount.neg(), circulation: amount },
    { breakdownExact: false }
  )
  await recordNominalMovement(tx, {
    operationId: op.id,
    chipSetId: set.id,
    movementType: "CHIP_DELIVERY",
    amount,
    ...nominal,
    referenceType: reservation.referenceType,
    referenceId: reservation.referenceId,
    ...context,
    actorId: actor.id,
  })
  const { count } = await tx.chipReservation.updateMany({
    where: { id: reservation.id, status: "ACTIVE" },
    data: {
      status: "CONSUMED",
      consumedAt: new Date(),
      consumeOperationId: op.id,
    },
  })
  if (count !== 1) throw new AppError("CONFLICT", "La reserva cambió de estado")
  await bumpInventoryVersion(tx, set.id)
  await recordAudit(
    {
      action: AUDIT_ACTIONS.CHIP_RESERVATION_CONSUMED,
      entityType: "ChipReservation",
      entityId: reservation.id,
      actorUserId: actor.id,
      requestId: ctx.requestId,
      metadata: {
        chipSetCode: set.code,
        operationId: op.id,
        amount: amount.toFixed(2),
        referenceType: reservation.referenceType,
        referenceId: reservation.referenceId,
        ...context,
      },
    },
    tx
  )
  return { operationId: op.id, replayed: false }
}

export async function confirmNominalChipDelivery(
  actor: SessionUser,
  reservationId: string,
  idempotencyKey: string,
  ctx: RequestContext = {}
): Promise<OperationView> {
  const result = await inventoryTx((tx) =>
    confirmNominalChipDeliveryInTx(
      tx,
      actor,
      reservationId,
      idempotencyKey,
      ctx
    )
  )
  return getOperationView(prisma, result.operationId, result.replayed)
}

export type NominalReturnInput = OperationContext & {
  chipSetId?: string
  amount: Amount
  referenceType: string
  referenceId: string
  idempotencyKey: string
}

/** Devolución física confirmada (liquidaciones): circulación → custodia, por importe. */
export async function confirmNominalChipReturnInTx(
  tx: Tx,
  actor: SessionUser,
  input: NominalReturnInput,
  ctx: RequestContext = {}
): Promise<{ operationId: string; replayed: boolean }> {
  const set = await lockChipSet(
    tx,
    input.chipSetId ?? (await sharedChipSetId(tx))
  )
  const amount = toAmount(input.amount)
  const hash = requestHash({ ...input, amount: amount.toFixed(2) })
  const replay = await findReplay(tx, input.idempotencyKey, hash)
  if (replay) return { operationId: replay, replayed: true }
  assertInitialized(set)
  const container = await primaryContainer(tx, set.id)
  const context = {
    tableId: input.tableId ?? null,
    sessionId: input.sessionId ?? null,
    playerId: input.playerId ?? null,
  }
  const op = await createOperation(tx, {
    type: "CHIP_RETURN",
    chipSetId: set.id,
    containerId: container.id,
    idempotencyKey: input.idempotencyKey,
    requestHash: hash,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    ...context,
    actorId: actor.id,
  })
  const nominal = await changeNominal(
    tx,
    set.id,
    { custody: amount, circulation: amount.neg() },
    { breakdownExact: false }
  )
  await recordNominalMovement(tx, {
    operationId: op.id,
    chipSetId: set.id,
    movementType: "CHIP_RETURN",
    amount,
    ...nominal,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    ...context,
    actorId: actor.id,
  })
  await bumpInventoryVersion(tx, set.id)
  await recordAudit(
    {
      action: AUDIT_ACTIONS.CHIP_RETURN_RECORDED,
      entityType: "ChipInventoryOperation",
      entityId: op.id,
      actorUserId: actor.id,
      requestId: ctx.requestId,
      metadata: {
        chipSetCode: set.code,
        amount: amount.toFixed(2),
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        ...context,
      },
    },
    tx
  )
  return { operationId: op.id, replayed: false }
}

export async function confirmNominalChipReturn(
  actor: SessionUser,
  input: NominalReturnInput,
  ctx: RequestContext = {}
) {
  const result = await inventoryTx((tx) =>
    confirmNominalChipReturnInTx(tx, actor, input, ctx)
  )
  return getOperationView(prisma, result.operationId, result.replayed)
}

/** La conciliación nominal es la del arqueo físico (motor de arqueos). */
export { reconcileStockCount as reconcileNominalInventory } from "@/modules/inventory/stock-count.service"
