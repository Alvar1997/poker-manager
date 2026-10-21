import "server-only"

import { Prisma } from "@/generated/prisma/client"
import { BusinessRuleError, NotFoundError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext } from "@/modules/auth/auth.service"
import {
  allocateFifo,
  ExcessPaymentError,
  receivableStatus,
  ZERO,
  type FifoAllocation,
} from "@/modules/credits/credit.math"

/**
 * Cuentas por cobrar (Módulo 10). La deuda es `PlayerDebt` (creada por el
 * Módulo 08 al confirmar una entrega con crédito, firmada y autorizada por
 * un socio). Su saldo se DERIVA del libro inmutable `payment_allocations`.
 *
 * Serialización: toda operación que aplica o revierte aplicaciones bloquea
 * antes el renglón del jugador (`FOR UPDATE`), así dos abonos, una
 * verificación de transferencia y una compensación del Módulo 11 sobre el
 * mismo jugador nunca sobreaplican. Orden de bloqueos: sesión → compra →
 * jugador → saldos financieros. La base vuelve a impedir aplicar más que
 * la deuda o que el abono (trigger).
 */

type Tx = Prisma.TransactionClient
type Db = Tx | typeof prisma
const dec = (v: Prisma.Decimal | string | number) => new Prisma.Decimal(v)
const fmt = (v: Prisma.Decimal) => v.toFixed(2)

export async function lockPlayerInTx(tx: Tx, playerId: string) {
  const rows = await tx.$queryRaw<{ id: string; name: string }[]>`
    SELECT "id", "name" FROM "players" WHERE "id" = ${playerId} FOR UPDATE
  `
  if (rows.length === 0) throw new NotFoundError("Jugador no encontrado")
  return rows[0]
}

/** Aplicado neto por deuda (APPLICATION − REVERSAL). */
export async function appliedByReceivable(db: Db, receivableIds: string[]) {
  if (receivableIds.length === 0) return new Map<string, Prisma.Decimal>()
  const rows = await db.paymentAllocation.groupBy({
    by: ["receivableId", "kind"],
    where: { receivableId: { in: receivableIds } },
    _sum: { amount: true },
  })
  const map = new Map<string, Prisma.Decimal>()
  for (const r of rows) {
    const v = dec(r._sum.amount ?? 0)
    map.set(
      r.receivableId,
      (map.get(r.receivableId) ?? ZERO)[
        r.kind === "APPLICATION" ? "add" : "sub"
      ](v)
    )
  }
  return map
}

/** Deudas de un jugador con su saldo derivado (orden de nacimiento). */
export async function receivablesOf(db: Db, playerId: string) {
  const debts = await db.playerDebt.findMany({
    where: { playerId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, createdAt: true, originalAmount: true },
  })
  const applied = await appliedByReceivable(
    db,
    debts.map((d) => d.id)
  )
  return debts.map((d) => {
    const a = applied.get(d.id) ?? ZERO
    const original = dec(d.originalAmount)
    return {
      id: d.id,
      createdAt: d.createdAt,
      original,
      applied: a,
      balance: original.sub(a),
      status: receivableStatus(original, a),
    }
  })
}

export async function outstandingOf(db: Db, playerId: string) {
  const list = await receivablesOf(db, playerId)
  return list.reduce((acc, r) => acc.add(r.balance), ZERO)
}

/** Saldo derivado de UNA deuda. */
export async function receivableBalance(db: Db, receivableId: string) {
  const d = await db.playerDebt.findUnique({
    where: { id: receivableId },
    select: { originalAmount: true },
  })
  if (!d) throw new NotFoundError("Deuda no encontrada")
  const applied =
    (await appliedByReceivable(db, [receivableId])).get(receivableId) ?? ZERO
  const original = dec(d.originalAmount)
  return { original, applied, balance: original.sub(applied) }
}

type AllocationSourceRef =
  | { source: "RECEIVABLE_PAYMENT"; receivablePaymentId: string }
  | { source: "CHIP_SETTLEMENT_OFFSET"; settlementId: string }

async function auditAllocations(
  tx: Tx,
  actorId: string,
  playerId: string,
  allocations: FifoAllocation[],
  meta: Record<string, unknown>,
  ctx: RequestContext
) {
  await recordAudit(
    {
      action: AUDIT_ACTIONS.PAYMENT_ALLOCATED,
      entityType: "Player",
      entityId: playerId,
      actorUserId: actorId,
      requestId: ctx.requestId,
      metadata: {
        ...meta,
        allocations: allocations.map((a) => ({
          receivableId: a.receivableId,
          order: a.order,
          amount: fmt(a.amount),
          balanceBefore: fmt(a.balanceBefore),
          balanceAfter: fmt(a.balanceAfter),
        })),
      },
    },
    tx
  )
  for (const a of allocations)
    await recordAudit(
      {
        action: a.balanceAfter.isZero()
          ? AUDIT_ACTIONS.RECEIVABLE_PAID
          : AUDIT_ACTIONS.RECEIVABLE_PARTIALLY_PAID,
        entityType: "PlayerDebt",
        entityId: a.receivableId,
        actorUserId: actorId,
        requestId: ctx.requestId,
        metadata: {
          playerId,
          amount: fmt(a.amount),
          from: fmt(a.balanceBefore),
          to: fmt(a.balanceAfter),
          ...meta,
        },
      },
      tx
    )
}

/**
 * Motor FIFO central (el jugador ya debe estar bloqueado). Calcula en el
 * servidor la distribución; el cliente nunca la envía. Lanza si el importe
 * excede la deuda pendiente.
 */
export async function allocateFifoInTx(
  tx: Tx,
  actorId: string,
  input: { playerId: string; amount: Prisma.Decimal } & AllocationSourceRef,
  ctx: RequestContext = {}
): Promise<FifoAllocation[]> {
  const receivables = await receivablesOf(tx, input.playerId)
  let allocations: FifoAllocation[]
  try {
    allocations = allocateFifo(receivables, input.amount)
  } catch (e) {
    if (e instanceof ExcessPaymentError) throw new BusinessRuleError(e.message)
    throw new BusinessRuleError(
      e instanceof Error ? e.message : "Importe inválido"
    )
  }
  const now = new Date()
  for (const a of allocations)
    await tx.paymentAllocation.create({
      data: {
        receivableId: a.receivableId,
        playerId: input.playerId,
        kind: "APPLICATION",
        source: input.source,
        amount: a.amount,
        allocationOrder: a.order,
        receivablePaymentId:
          input.source === "RECEIVABLE_PAYMENT"
            ? input.receivablePaymentId
            : null,
        settlementId:
          input.source === "CHIP_SETTLEMENT_OFFSET" ? input.settlementId : null,
        createdById: actorId,
        allocatedAt: now,
      },
    })
  await auditAllocations(
    tx,
    actorId,
    input.playerId,
    allocations,
    input.source === "RECEIVABLE_PAYMENT"
      ? { source: input.source, receivablePaymentId: input.receivablePaymentId }
      : { source: input.source, settlementId: input.settlementId },
    ctx
  )
  return allocations
}

/**
 * Aplica un pago VINCULADO a una compra (transferencia anunciada en la
 * compra y verificada después de entregar) a SU deuda, sin FIFO. Devuelve
 * lo aplicado; el resto (si la deuda ya estaba cubierta) es excedente.
 */
export async function allocatePurchasePaymentInTx(
  tx: Tx,
  actorId: string,
  input: {
    receivableId: string
    playerId: string
    purchasePaymentId: string
    amount: Prisma.Decimal
  },
  ctx: RequestContext = {}
) {
  const { balance } = await receivableBalance(tx, input.receivableId)
  const applicable = Prisma.Decimal.min(
    input.amount,
    Prisma.Decimal.max(balance, ZERO)
  )
  if (applicable.greaterThan(0)) {
    await tx.paymentAllocation.create({
      data: {
        receivableId: input.receivableId,
        playerId: input.playerId,
        kind: "APPLICATION",
        source: "PURCHASE_PAYMENT",
        amount: applicable,
        allocationOrder: 1,
        purchasePaymentId: input.purchasePaymentId,
        createdById: actorId,
      },
    })
    await auditAllocations(
      tx,
      actorId,
      input.playerId,
      [
        {
          receivableId: input.receivableId,
          amount: applicable,
          order: 1,
          balanceBefore: balance,
          balanceAfter: balance.sub(applicable),
        },
      ],
      {
        source: "PURCHASE_PAYMENT",
        purchasePaymentId: input.purchasePaymentId,
      },
      ctx
    )
  }
  return { applied: applicable, excess: input.amount.sub(applicable) }
}

/**
 * CONTRATO (Módulo 11 — liquidaciones): compensa deuda con el valor de las
 * fichas devueltas usando el MISMO motor FIFO, sin crear movimientos de
 * efectivo ni banco. Bloquea al jugador (serializa con abonos simultáneos).
 * Solo se llama cuando el cajero DECIDIÓ compensar (la compensación es
 * opcional) y por el importe que eligió (parcial o máximo).
 */
export async function applyChipSettlementOffsetInTx(
  tx: Tx,
  actorId: string,
  input: { playerId: string; settlementId: string; amount: Prisma.Decimal },
  ctx: RequestContext = {}
) {
  await lockPlayerInTx(tx, input.playerId)
  return allocateFifoInTx(
    tx,
    actorId,
    {
      playerId: input.playerId,
      amount: input.amount,
      source: "CHIP_SETTLEMENT_OFFSET",
      settlementId: input.settlementId,
    },
    ctx
  )
}

/**
 * CONTRATO (Módulo 11 — reverso de liquidación): contraasientos exactos de
 * las compensaciones con fichas de UNA liquidación (la deuda vuelve a su
 * saldo previo). No re-ejecuta FIFO ni toca aplicaciones de otros abonos.
 */
export async function reverseSettlementOffsetsInTx(
  tx: Tx,
  actorId: string,
  settlementId: string
) {
  const originals = await tx.paymentAllocation.findMany({
    where: { settlementId, kind: "APPLICATION", reversedBy: null },
    orderBy: { allocationOrder: "asc" },
  })
  for (const a of originals)
    await tx.paymentAllocation.create({
      data: {
        receivableId: a.receivableId,
        playerId: a.playerId,
        kind: "REVERSAL",
        source: a.source,
        amount: a.amount,
        allocationOrder: a.allocationOrder,
        settlementId,
        reversesAllocationId: a.id,
        createdById: actorId,
      },
    })
  return originals.map((a) => ({
    receivableId: a.receivableId,
    amount: dec(a.amount),
  }))
}

/** Contraasientos de todas las aplicaciones vigentes de un abono (reverso). */
export async function reversePaymentAllocationsInTx(
  tx: Tx,
  actorId: string,
  receivablePaymentId: string
) {
  const originals = await tx.paymentAllocation.findMany({
    where: { receivablePaymentId, kind: "APPLICATION", reversedBy: null },
    orderBy: { allocationOrder: "asc" },
  })
  // Módulo 16: la deuda de una compra revertida quedó cerrada (el abono
  // aplicado se reembolsa por el reverso; aquí no se reabre).
  const closed = await tx.purchaseReversal.count({
    where: {
      purchase: {
        debt: { id: { in: originals.map((a) => a.receivableId) } },
      },
    },
  })
  if (closed > 0)
    throw new BusinessRuleError(
      "El abono se aplicó a la deuda de una compra revertida (Módulo 16): su reembolso se gestiona en Operaciones especiales y no se revierte aquí."
    )
  for (const a of originals)
    await tx.paymentAllocation.create({
      data: {
        receivableId: a.receivableId,
        playerId: a.playerId,
        kind: "REVERSAL",
        source: a.source,
        amount: a.amount,
        allocationOrder: a.allocationOrder,
        receivablePaymentId,
        reversesAllocationId: a.id,
        createdById: actorId,
      },
    })
  return originals.map((a) => ({
    receivableId: a.receivableId,
    amount: dec(a.amount),
  }))
}

// ── Consultas ─────────────────────────────────────────────────────────

const receivableSelect = {
  id: true,
  createdAt: true,
  originalAmount: true,
  sessionId: true,
  tableId: true,
  session: { select: { id: true, folio: true, status: true } },
  player: { select: { id: true, name: true, nickname: true, phone: true } },
  purchase: {
    select: {
      id: true,
      folio: true,
      nominalAmount: true,
      purchaseType: true,
      rebuyNumber: true,
      participationId: true,
      table: { select: { id: true, name: true } },
      delivery: {
        select: { signatureId: true, deliveredAt: true },
      },
    },
  },
  authorization: {
    select: {
      partnerNameSnapshot: true,
      authorizationChannel: true,
      authorizedByPartnerId: true,
    },
  },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.PlayerDebtSelect

type ReceivableRow = Prisma.PlayerDebtGetPayload<{
  select: typeof receivableSelect
}>

function receivableView(
  r: ReceivableRow,
  applied: Prisma.Decimal,
  opts: { showPhone: boolean }
) {
  const original = dec(r.originalAmount)
  return {
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    originalAmount: fmt(original),
    appliedAmount: fmt(applied),
    balance: fmt(original.sub(applied)),
    status: receivableStatus(original, applied),
    player: { ...r.player, phone: opts.showPhone ? r.player.phone : null },
    origin: {
      purchaseId: r.purchase.id,
      purchaseFolio: r.purchase.folio,
      purchaseType: r.purchase.purchaseType,
      rebuyNumber: r.purchase.rebuyNumber,
      nominalAmount: fmt(dec(r.purchase.nominalAmount)),
      session: r.session,
      table: r.purchase.table,
      participationId: r.purchase.participationId,
      deliveredAt: r.purchase.delivery?.deliveredAt.toISOString() ?? null,
    },
    partner: {
      id: r.authorization.authorizedByPartnerId,
      name: r.authorization.partnerNameSnapshot,
      channel: r.authorization.authorizationChannel,
    },
    signatureId: r.purchase.delivery?.signatureId ?? null,
    createdBy: r.createdBy,
  }
}
export type ReceivableView = ReturnType<typeof receivableView>

export async function listReceivables(
  filters: {
    playerId?: string
    status?: "OPEN" | "PARTIALLY_PAID" | "PAID"
    page: number
    pageSize: number
  },
  opts: { showPhone: boolean }
) {
  const rows = await prisma.playerDebt.findMany({
    where: filters.playerId ? { playerId: filters.playerId } : {},
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: receivableSelect,
  })
  const applied = await appliedByReceivable(
    prisma,
    rows.map((r) => r.id)
  )
  const all = rows
    .map((r) => receivableView(r, applied.get(r.id) ?? ZERO, opts))
    .filter((v) => !filters.status || v.status === filters.status)
  return {
    items: all.slice(
      (filters.page - 1) * filters.pageSize,
      filters.page * filters.pageSize
    ),
    page: filters.page,
    pageSize: filters.pageSize,
    total: all.length,
    totalPages: Math.max(1, Math.ceil(all.length / filters.pageSize)),
  }
}

export async function getReceivable(id: string, opts: { showPhone: boolean }) {
  const r = await prisma.playerDebt.findUnique({
    where: { id },
    select: receivableSelect,
  })
  if (!r) throw new NotFoundError("Deuda no encontrada")
  const allocations = await prisma.paymentAllocation.findMany({
    where: { receivableId: id },
    orderBy: [{ allocatedAt: "asc" }, { allocationOrder: "asc" }],
    select: {
      id: true,
      kind: true,
      source: true,
      amount: true,
      allocationOrder: true,
      allocatedAt: true,
      settlementId: true,
      receivablePayment: {
        select: { id: true, folio: true, method: true, origin: true },
      },
      purchasePayment: { select: { id: true, method: true } },
      createdBy: { select: { id: true, name: true } },
    },
  })
  const applied = allocations.reduce(
    (acc, a) =>
      a.kind === "APPLICATION" ? acc.add(a.amount) : acc.sub(a.amount),
    ZERO
  )
  return {
    ...receivableView(r, applied, opts),
    history: allocations.map((a) => ({
      ...a,
      amount: fmt(dec(a.amount)),
      allocatedAt: a.allocatedAt.toISOString(),
    })),
  }
}

/** Resumen por jugador: deuda global, créditos, saldos y deuda más antigua. */
export async function getPlayerCreditSummary(
  playerId: string,
  opts: { showPhone: boolean }
) {
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: {
      id: true,
      name: true,
      nickname: true,
      phone: true,
      isActive: true,
    },
  })
  if (!player) throw new NotFoundError("Jugador no encontrado")
  const list = await listReceivables(
    { playerId, page: 1, pageSize: 1000 },
    opts
  )
  const items = list.items
  const sum = (f: (i: (typeof items)[number]) => string) =>
    items.reduce((acc, i) => acc.add(dec(f(i))), ZERO)
  const open = items.filter((i) => i.status !== "PAID")
  const pending = await prisma.receivablePayment.aggregate({
    where: { playerId, status: "PENDING" },
    _sum: { amount: true },
    _count: true,
  })
  const unapplied = await prisma.unappliedPlayerFunds.aggregate({
    where: { playerId, status: "PENDING_RESOLUTION" },
    _sum: { amount: true },
  })
  return {
    player: { ...player, phone: opts.showPhone ? player.phone : null },
    totalOriginal: fmt(sum((i) => i.originalAmount)),
    totalApplied: fmt(sum((i) => i.appliedAmount)),
    outstanding: fmt(sum((i) => i.balance)),
    openCount: open.length,
    oldestOpen: open[0] ?? null,
    receivables: items,
    pendingTransfers: {
      count: pending._count,
      amount: fmt(dec(pending._sum.amount ?? 0)),
    },
    unappliedFunds: fmt(dec(unapplied._sum.amount ?? 0)),
  }
}

/**
 * Estado de cuenta cronológico: créditos generados, aplicaciones (abonos,
 * transferencias de compra, compensaciones) y reversos, con saldo
 * resultante. Las transferencias pendientes se listan aparte: no cambian
 * el saldo.
 */
export async function getPlayerStatement(playerId: string) {
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: { id: true, name: true },
  })
  if (!player) throw new NotFoundError("Jugador no encontrado")
  const [debts, allocations, pending] = await Promise.all([
    prisma.playerDebt.findMany({
      where: { playerId },
      select: {
        id: true,
        createdAt: true,
        originalAmount: true,
        purchase: {
          select: { folio: true, table: { select: { name: true } } },
        },
        session: { select: { folio: true } },
      },
    }),
    prisma.paymentAllocation.findMany({
      where: { playerId },
      select: {
        id: true,
        kind: true,
        source: true,
        amount: true,
        allocatedAt: true,
        allocationOrder: true,
        receivableId: true,
        receivable: { select: { purchase: { select: { folio: true } } } },
        receivablePayment: { select: { id: true, folio: true, method: true } },
        purchasePayment: { select: { method: true } },
      },
    }),
    prisma.receivablePayment.findMany({
      where: { playerId, status: "PENDING" },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        folio: true,
        amount: true,
        method: true,
        createdAt: true,
        externalReference: true,
      },
    }),
  ])
  type Event = {
    at: Date
    order: number
    kind:
      "CREDIT" | "PAYMENT" | "PURCHASE_TRANSFER" | "CHIP_OFFSET" | "REVERSAL"
    description: string
    reference: string | null
    paymentId: string | null
    receivableId: string
    delta: Prisma.Decimal
  }
  const events: Event[] = [
    ...debts.map((d) => ({
      at: d.createdAt,
      order: 0,
      kind: "CREDIT" as const,
      description: `Crédito por compra ${d.purchase.folio} (${d.purchase.table.name}, sesión ${d.session.folio})`,
      reference: d.purchase.folio,
      paymentId: null,
      receivableId: d.id,
      delta: dec(d.originalAmount),
    })),
    ...allocations.map((a) => ({
      at: a.allocatedAt,
      order: a.allocationOrder,
      kind:
        a.kind === "REVERSAL"
          ? ("REVERSAL" as const)
          : a.source === "RECEIVABLE_PAYMENT"
            ? ("PAYMENT" as const)
            : a.source === "PURCHASE_PAYMENT"
              ? ("PURCHASE_TRANSFER" as const)
              : ("CHIP_OFFSET" as const),
      description:
        a.kind === "REVERSAL"
          ? `Reverso de aplicación a ${a.receivable.purchase.folio}`
          : a.source === "RECEIVABLE_PAYMENT"
            ? `Abono ${a.receivablePayment?.folio} aplicado a ${a.receivable.purchase.folio}`
            : a.source === "PURCHASE_PAYMENT"
              ? `Transferencia de la compra ${a.receivable.purchase.folio} verificada`
              : `Compensación con fichas a ${a.receivable.purchase.folio}`,
      reference: a.receivablePayment?.folio ?? a.receivable.purchase.folio,
      paymentId: a.receivablePayment?.id ?? null,
      receivableId: a.receivableId,
      delta: a.kind === "REVERSAL" ? dec(a.amount) : dec(a.amount).neg(),
    })),
  ].sort((x, y) => x.at.getTime() - y.at.getTime() || x.order - y.order)
  let balance = ZERO
  const lines = events.map((e) => {
    balance = balance.add(e.delta)
    return {
      at: e.at.toISOString(),
      kind: e.kind,
      description: e.description,
      reference: e.reference,
      paymentId: e.paymentId,
      receivableId: e.receivableId,
      amount: fmt(e.delta.abs()),
      direction: e.delta.isNegative()
        ? ("DECREASE" as const)
        : ("INCREASE" as const),
      balance: fmt(balance),
    }
  })
  return {
    player,
    lines,
    balance: fmt(balance),
    pending: pending.map((p) => ({
      ...p,
      amount: fmt(dec(p.amount)),
      createdAt: p.createdAt.toISOString(),
    })),
  }
}

/** Jugadores con deuda (saldo derivado > 0), de mayor a menor. */
export async function listPlayersWithDebt(q?: string) {
  const debts = await prisma.playerDebt.findMany({
    where: q
      ? {
          player: {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { nickname: { contains: q, mode: "insensitive" } },
            ],
          },
        }
      : {},
    select: {
      id: true,
      createdAt: true,
      originalAmount: true,
      player: { select: { id: true, name: true, nickname: true } },
    },
  })
  const applied = await appliedByReceivable(
    prisma,
    debts.map((d) => d.id)
  )
  const byPlayer = new Map<
    string,
    {
      player: (typeof debts)[number]["player"]
      balance: Prisma.Decimal
      open: number
      oldest: Date | null
    }
  >()
  for (const d of debts) {
    const balance = dec(d.originalAmount).sub(applied.get(d.id) ?? ZERO)
    const entry = byPlayer.get(d.player.id) ?? {
      player: d.player,
      balance: ZERO,
      open: 0,
      oldest: null,
    }
    if (balance.greaterThan(0)) {
      entry.balance = entry.balance.add(balance)
      entry.open += 1
      if (!entry.oldest || d.createdAt < entry.oldest)
        entry.oldest = d.createdAt
    }
    byPlayer.set(d.player.id, entry)
  }
  return [...byPlayer.values()]
    .filter((e) => e.balance.greaterThan(0))
    .sort((a, b) => b.balance.comparedTo(a.balance))
    .map((e) => ({
      player: e.player,
      outstanding: fmt(e.balance),
      openCount: e.open,
      oldestAt: e.oldest?.toISOString() ?? null,
    }))
}

/** Tablero de créditos (sin sumar dos veces terminal y depósitos). */
export async function getCreditsDashboard(periodDays = 7) {
  const players = await listPlayersWithDebt()
  const since = new Date(Date.now() - periodDays * 86_400_000)
  const [confirmed, pending, oldestDebts, unapplied] = await Promise.all([
    prisma.receivablePayment.aggregate({
      where: { status: "CONFIRMED", confirmedAt: { gte: since } },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.receivablePayment.aggregate({
      where: { status: "PENDING" },
      _sum: { amount: true },
      _count: true,
    }),
    listReceivables({ page: 1, pageSize: 1000 }, { showPhone: false }),
    prisma.unappliedPlayerFunds.aggregate({
      where: { status: "PENDING_RESOLUTION" },
      _sum: { amount: true },
      _count: true,
    }),
  ])
  const open = oldestDebts.items.filter((i) => i.status !== "PAID")
  return {
    totalOutstanding: fmt(
      players.reduce((acc, p) => acc.add(dec(p.outstanding)), ZERO)
    ),
    playersWithDebt: players.length,
    openReceivables: open.length,
    periodDays,
    confirmedPayments: {
      count: confirmed._count,
      amount: fmt(dec(confirmed._sum.amount ?? 0)),
    },
    pendingVerification: {
      count: pending._count,
      amount: fmt(dec(pending._sum.amount ?? 0)),
    },
    unappliedFunds: {
      count: unapplied._count,
      amount: fmt(dec(unapplied._sum.amount ?? 0)),
    },
    oldest: open.slice(0, 5),
    topPlayers: players.slice(0, 5),
  }
}
