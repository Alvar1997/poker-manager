import "server-only"

import { randomUUID } from "node:crypto"

import type { Prisma } from "@/generated/prisma/client"
import {
  AppError,
  BusinessRuleError,
  ConflictError,
  NotFoundError,
} from "@/lib/errors"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import { recordSettlementPayoutInTx } from "@/modules/cash/payment-contracts"
import {
  asBusiness,
  dec,
  fmt,
  lockPayable,
  lockSessionShare,
  lockSettlement,
  refreshPayableInTx,
  SETTLEMENT_TX,
  type SettlementCore,
  type Tx,
} from "@/modules/settlements/settlement-core"
import {
  assertPayoutFits,
  payableState,
} from "@/modules/settlements/settlement.math"
import type {
  RegisterPayoutInput,
  ResolvePayoutInput,
} from "@/modules/settlements/settlement.schemas"
import { createSettlementReceiptInTx } from "@/modules/settlements/settlement-receipt.service"

/**
 * Desembolsos al jugador (Módulo 11): la cuenta por pagar (`SettlementPayable`)
 * se cubre con uno o varios pagos, en efectivo, por transferencia o ambos.
 *
 *  - EFECTIVO: se entrega y se contabiliza en el mismo momento. Mientras la
 *    sesión de origen está OPEN/CLOSING sale de SU caja; después del cierre
 *    sale de la CUSTODIA ADMINISTRATIVA de quien paga (nunca de una caja
 *    cerrada ni de otra sesión). Ninguna cuenta de efectivo queda negativa.
 *  - TRANSFERENCIA: queda PENDING (reserva el importe, NO cuenta como
 *    pagada) hasta que alguien verifica en el banco que salió (EXECUTED,
 *    asiento banco −). FAILED/CANCELLED liberan la reserva.
 *  - Nunca se paga más que lo pendiente, descontando lo reservado (servicio
 *    con la cuenta por pagar bloqueada + trigger en la base).
 *  - Al quedar pagada: liquidación COMPLETED y participación SETTLED.
 * Lo decide el servidor: origen del dinero, cuenta bancaria, fechas y folios.
 */

const user = { select: { id: true, name: true } } as const

const payoutSelect = {
  id: true,
  sequence: true,
  amount: true,
  method: true,
  funding: true,
  status: true,
  bankReference: true,
  notes: true,
  failureReason: true,
  createdAt: true,
  resolvedAt: true,
  executedAt: true,
  session: { select: { id: true, folio: true } },
  custodian: user,
  paymentAccount: {
    select: { id: true, name: true, bankName: true, accountNumberLast4: true },
  },
  financialTransaction: { select: { id: true, folio: true } },
  requestedBy: user,
  resolvedBy: user,
  receipt: { select: { id: true, status: true } },
} satisfies Prisma.SettlementPayoutSelect

type PayoutRow = Prisma.SettlementPayoutGetPayload<{
  select: typeof payoutSelect
}>

export function payoutView(p: PayoutRow) {
  return {
    ...p,
    amount: fmt(dec(p.amount)),
    createdAt: p.createdAt.toISOString(),
    resolvedAt: p.resolvedAt?.toISOString() ?? null,
    executedAt: p.executedAt?.toISOString() ?? null,
  }
}
export type SettlementPayoutView = ReturnType<typeof payoutView>

export async function listSettlementPayouts(settlementId: string) {
  const s = await prisma.playerSettlement.findUnique({
    where: { id: settlementId },
    select: { id: true },
  })
  if (!s) throw new NotFoundError("Liquidación no encontrada")
  const rows = await prisma.settlementPayout.findMany({
    where: { settlementId },
    orderBy: { sequence: "asc" },
    select: payoutSelect,
  })
  return rows.map(payoutView)
}

/**
 * Origen del EFECTIVO decidido por el servidor: la caja de la sesión de
 * origen mientras siga OPEN (bloqueada en modo compartido para que no
 * cierre a la mitad); si ya cerró, la custodia administrativa de quien
 * entrega el dinero. Durante CLOSING la caja solo admite arqueo y retiro
 * final (Módulo 12): el pago en efectivo espera al regreso a OPEN o al
 * cierre (custodia); la transferencia sí puede registrarse.
 */
export const CLOSING_CASH_PAYOUT_MESSAGE =
  "La sesión está en cierre: su caja solo admite el arqueo y el retiro final. Regresa la sesión a Abierta para pagar en efectivo, registra una transferencia o paga después del cierre desde la custodia."

async function cashFundingInTx(tx: Tx, sessionId: string, actor: SessionUser) {
  const session = await lockSessionShare(tx, sessionId)
  if (session.status === "CLOSING")
    throw new BusinessRuleError(CLOSING_CASH_PAYOUT_MESSAGE)
  return session.status === "OPEN"
    ? { funding: "SESSION_CASH" as const, sessionId, custodianUserId: null }
    : {
        funding: "ADMIN_CUSTODY" as const,
        sessionId: null,
        custodianUserId: actor.id,
      }
}

async function primaryBankAccount(tx: Tx) {
  const account = await tx.paymentAccount.findFirst({
    where: { isActive: true, isPrimary: true },
    select: { id: true },
  })
  if (!account)
    throw new BusinessRuleError(
      "Configura la cuenta bancaria principal antes de registrar transferencias."
    )
  return account.id
}

/**
 * Desembolso en efectivo ya entregado: asiento único + registro EXECUTED.
 * Lo usan el registro de pagos y la confirmación de recepción (pago
 * inmediato). La cuenta por pagar debe estar bloqueada por quien llama.
 */
export async function executeCashPayoutInTx(
  tx: Tx,
  actor: SessionUser,
  s: Pick<
    SettlementCore,
    "id" | "folio" | "sessionId" | "tableId" | "playerId"
  >,
  input: {
    payableId: string
    sequence: number
    amount: Prisma.Decimal
    funding: {
      funding: "SESSION_CASH" | "ADMIN_CUSTODY"
      sessionId: string | null
      custodianUserId: string | null
    }
    notes: string | null
    idempotencyKey: string
  },
  ctx: RequestContext = {}
) {
  const payoutId = randomUUID()
  const posted = await recordSettlementPayoutInTx(
    tx,
    actor,
    {
      payoutId,
      settlementId: s.id,
      settlementFolio: s.folio,
      funding: input.funding.funding,
      sessionId: input.funding.sessionId,
      custodianUserId: input.funding.custodianUserId,
      tableId: s.tableId,
      playerId: s.playerId,
      amount: input.amount,
      idempotencyKey: `settlement-payout-${input.idempotencyKey}`,
    },
    ctx
  )
  const now = new Date()
  await tx.settlementPayout.create({
    data: {
      id: payoutId,
      payableId: input.payableId,
      settlementId: s.id,
      playerId: s.playerId,
      sequence: input.sequence,
      amount: input.amount,
      method: "CASH",
      funding: input.funding.funding,
      status: "EXECUTED",
      sessionId: input.funding.sessionId,
      custodianUserId: input.funding.custodianUserId,
      financialTransactionId: posted.transactionId,
      notes: input.notes,
      requestedById: actor.id,
      resolvedById: actor.id,
      resolvedAt: now,
      executedAt: now,
      idempotencyKey: input.idempotencyKey,
    },
  })
  const meta = {
    settlementId: s.id,
    folio: s.folio,
    playerId: s.playerId,
    sessionId: s.sessionId,
    payoutId,
    sequence: input.sequence,
    method: "CASH",
    funding: input.funding.funding,
    custodianUserId: input.funding.custodianUserId,
    amount: fmt(input.amount),
    financialTransactionId: posted.transactionId,
  }
  await recordAudit(
    {
      action: AUDIT_ACTIONS.SETTLEMENT_PAYOUT_REGISTERED,
      entityType: "SettlementPayout",
      entityId: payoutId,
      actorUserId: actor.id,
      requestId: ctx.requestId,
      metadata: meta,
    },
    tx
  )
  await recordAudit(
    {
      action: AUDIT_ACTIONS.SETTLEMENT_PAYOUT_CONFIRMED,
      entityType: "SettlementPayout",
      entityId: payoutId,
      actorUserId: actor.id,
      requestId: ctx.requestId,
      metadata: { ...meta, from: null, to: "EXECUTED" },
    },
    tx
  )
  return payoutId
}

async function nextSequence(tx: Tx, settlementId: string) {
  const last = await tx.settlementPayout.aggregate({
    where: { settlementId },
    _max: { sequence: true },
  })
  return (last._max.sequence ?? 0) + 1
}

function assertPayable(s: SettlementCore) {
  if (s.status === "COMPLETED")
    throw new BusinessRuleError("La liquidación ya está pagada por completo.")
  if (s.status === "DRAFT" || s.status === "READY_FOR_CONFIRMATION")
    throw new BusinessRuleError(
      "Primero confirma la recepción de las fichas: todavía no hay nada por pagar."
    )
  if (s.status !== "PENDING_PAYOUT")
    throw new BusinessRuleError("Esta liquidación no admite pagos.")
}

// ── Registrar ─────────────────────────────────────────────────────────

/** Registra un desembolso (efectivo entregado o transferencia en trámite). */
export async function registerPayout(
  actor: SessionUser,
  settlementId: string,
  input: RegisterPayoutInput,
  ctx: RequestContext = {}
) {
  const amount = dec(input.amount)
  const replay = async () => {
    const r = await prisma.settlementPayout.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true, settlementId: true, amount: true, method: true },
    })
    if (
      r &&
      (r.settlementId !== settlementId ||
        !dec(r.amount).equals(amount) ||
        r.method !== input.method)
    )
      throw new AppError(
        "CONFLICT",
        "Esta clave de operación ya se usó para otro pago"
      )
    return r
  }
  const previous = await replay()
  if (previous) return { payoutId: previous.id, replayed: true }
  const head = await prisma.playerSettlement.findUnique({
    where: { id: settlementId },
    select: { sessionId: true },
  })
  if (!head) throw new NotFoundError("Liquidación no encontrada")
  try {
    return await prisma.$transaction(async (tx) => {
      const cashFunding =
        input.method === "CASH"
          ? await cashFundingInTx(tx, head.sessionId, actor)
          : (await lockSessionShare(tx, head.sessionId), null)
      const s = await lockSettlement(tx, settlementId)
      const again = await tx.settlementPayout.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true },
      })
      if (again) return { payoutId: again.id, replayed: true }
      assertPayable(s)
      const { payable, state } = await lockPayable(tx, settlementId)
      try {
        assertPayoutFits(state, amount)
      } catch (e) {
        asBusiness(e)
      }
      const sequence = await nextSequence(tx, settlementId)
      let payoutId: string
      if (input.method === "CASH") {
        payoutId = await executeCashPayoutInTx(
          tx,
          actor,
          s,
          {
            payableId: payable.id,
            sequence,
            amount,
            funding: cashFunding!,
            notes: input.notes ?? null,
            idempotencyKey: input.idempotencyKey,
          },
          ctx
        )
      } else {
        const created = await tx.settlementPayout.create({
          data: {
            payableId: payable.id,
            settlementId: s.id,
            playerId: s.playerId,
            sequence,
            amount,
            method: "BANK_TRANSFER",
            funding: "BANK",
            status: "PENDING",
            paymentAccountId: await primaryBankAccount(tx),
            bankReference: input.bankReference ?? null,
            notes: input.notes ?? null,
            requestedById: actor.id,
            idempotencyKey: input.idempotencyKey,
          },
          select: { id: true },
        })
        payoutId = created.id
        await recordAudit(
          {
            action: AUDIT_ACTIONS.SETTLEMENT_PAYOUT_REGISTERED,
            entityType: "SettlementPayout",
            entityId: payoutId,
            actorUserId: actor.id,
            requestId: ctx.requestId,
            metadata: {
              settlementId: s.id,
              folio: s.folio,
              playerId: s.playerId,
              sessionId: s.sessionId,
              sequence,
              method: "BANK_TRANSFER",
              status: "PENDING",
              amount: fmt(amount),
              note: "Transferencia en trámite: reserva el importe pero NO cuenta como pagada.",
            },
          },
          tx
        )
      }
      await refreshPayableInTx(tx, actor, s, ctx)
      if (input.method === "CASH")
        await createSettlementReceiptInTx(
          tx,
          actor,
          s.id,
          { kind: "PAYOUT", payoutId },
          ctx
        )
      return { payoutId, replayed: false }
    }, SETTLEMENT_TX)
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await replay()
      if (again) return { payoutId: again.id, replayed: true }
      throw new ConflictError(
        "Otro pago de esta liquidación se registró al mismo tiempo. Recarga e intenta de nuevo."
      )
    }
    throw error
  }
}

// ── Resolver transferencias ───────────────────────────────────────────

/**
 * Resuelve una transferencia saliente PENDING: EXECUTED (verificada en el
 * banco: asiento banco − y cuenta como pagada), FAILED o CANCELLED (libera
 * la reserva). Idempotente; una transferencia resuelta no cambia.
 */
export async function resolvePayout(
  actor: SessionUser,
  settlementId: string,
  payoutId: string,
  input: ResolvePayoutInput,
  ctx: RequestContext = {}
) {
  const head = await prisma.settlementPayout.findUnique({
    where: { id: payoutId },
    select: {
      settlementId: true,
      resolveIdempotencyKey: true,
      status: true,
      settlement: { select: { sessionId: true } },
    },
  })
  if (!head || head.settlementId !== settlementId)
    throw new NotFoundError("Pago no encontrado")
  if (head.resolveIdempotencyKey === input.idempotencyKey)
    return { payoutId, replayed: true }
  try {
    return await prisma.$transaction(async (tx) => {
      await lockSessionShare(tx, head.settlement.sessionId)
      const s = await lockSettlement(tx, settlementId)
      await lockPayable(tx, settlementId)
      await tx.$queryRaw`SELECT "id" FROM "settlement_payouts" WHERE "id" = ${payoutId} FOR UPDATE`
      const p = await tx.settlementPayout.findUniqueOrThrow({
        where: { id: payoutId },
        select: {
          id: true,
          sequence: true,
          amount: true,
          status: true,
          method: true,
          bankReference: true,
          createdAt: true,
          resolveIdempotencyKey: true,
        },
      })
      if (p.resolveIdempotencyKey === input.idempotencyKey)
        return { payoutId, replayed: true }
      if (p.status !== "PENDING")
        throw new ConflictError(
          "Esta transferencia ya fue resuelta: no se modifica."
        )
      if (p.method !== "BANK_TRANSFER")
        throw new BusinessRuleError("Solo una transferencia queda pendiente.")
      const now = new Date()
      const amount = dec(p.amount)
      const meta = {
        settlementId: s.id,
        folio: s.folio,
        playerId: s.playerId,
        sessionId: s.sessionId,
        payoutId,
        sequence: p.sequence,
        amount: fmt(amount),
      }
      if (input.outcome === "EXECUTED") {
        const executedAt = input.executedAt ? new Date(input.executedAt) : now
        if (executedAt.getTime() > now.getTime() + 60_000)
          throw new BusinessRuleError(
            "La fecha de ejecución no puede estar en el futuro."
          )
        if (
          s.receivedAt &&
          executedAt.getTime() < s.receivedAt.getTime() - 60_000
        )
          throw new BusinessRuleError(
            "La fecha de ejecución no puede ser anterior a la recepción de las fichas."
          )
        const posted = await recordSettlementPayoutInTx(
          tx,
          actor,
          {
            payoutId,
            settlementId: s.id,
            settlementFolio: s.folio,
            funding: "BANK",
            tableId: s.tableId,
            playerId: s.playerId,
            amount,
            bankReference: input.bankReference,
            idempotencyKey: `settlement-payout-bank-${payoutId}`,
          },
          ctx
        )
        const { count } = await tx.settlementPayout.updateMany({
          where: { id: payoutId, status: "PENDING" },
          data: {
            status: "EXECUTED",
            financialTransactionId: posted.transactionId,
            bankReference: input.bankReference,
            executedAt,
            resolvedById: actor.id,
            resolvedAt: now,
            resolveIdempotencyKey: input.idempotencyKey,
          },
        })
        if (count !== 1)
          throw new ConflictError("La transferencia cambió de estado.")
        await recordAudit(
          {
            action: AUDIT_ACTIONS.SETTLEMENT_PAYOUT_CONFIRMED,
            entityType: "SettlementPayout",
            entityId: payoutId,
            actorUserId: actor.id,
            requestId: ctx.requestId,
            metadata: {
              ...meta,
              from: "PENDING",
              to: "EXECUTED",
              method: "BANK_TRANSFER",
              executedAt: executedAt.toISOString(),
              financialTransactionId: posted.transactionId,
            },
          },
          tx
        )
        await refreshPayableInTx(tx, actor, s, ctx)
        await createSettlementReceiptInTx(
          tx,
          actor,
          s.id,
          { kind: "PAYOUT", payoutId },
          ctx
        )
      } else {
        const { count } = await tx.settlementPayout.updateMany({
          where: { id: payoutId, status: "PENDING" },
          data: {
            status: input.outcome,
            failureReason: input.reason,
            resolvedById: actor.id,
            resolvedAt: now,
            resolveIdempotencyKey: input.idempotencyKey,
          },
        })
        if (count !== 1)
          throw new ConflictError("La transferencia cambió de estado.")
        await recordAudit(
          {
            action: AUDIT_ACTIONS.SETTLEMENT_PAYOUT_FAILED,
            entityType: "SettlementPayout",
            entityId: payoutId,
            actorUserId: actor.id,
            requestId: ctx.requestId,
            metadata: {
              ...meta,
              from: "PENDING",
              to: input.outcome,
              reason: input.reason,
              note: "Reserva liberada: el importe vuelve a estar pendiente de pago.",
            },
          },
          tx
        )
      }
      return { payoutId, replayed: false }
    }, SETTLEMENT_TX)
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await prisma.settlementPayout.findUnique({
        where: { id: payoutId },
        select: { resolveIdempotencyKey: true },
      })
      if (again?.resolveIdempotencyKey === input.idempotencyKey)
        return { payoutId, replayed: true }
      throw new ConflictError("La transferencia se resolvió en otra solicitud.")
    }
    throw error
  }
}

// ── Consultas: cuentas por pagar pendientes ──────────────────────────

const pendingSelect = {
  id: true,
  originalAmount: true,
  status: true,
  createdAt: true,
  sourceSession: { select: { id: true, folio: true, status: true } },
  player: { select: { id: true, name: true, nickname: true } },
  settlement: {
    select: {
      id: true,
      folio: true,
      status: true,
      receivedAt: true,
      table: { select: { id: true, name: true } },
    },
  },
  payouts: {
    orderBy: { sequence: "asc" },
    select: payoutSelect,
  },
} satisfies Prisma.SettlementPayableSelect

type PendingRow = Prisma.SettlementPayableGetPayload<{
  select: typeof pendingSelect
}>

function pendingView(r: PendingRow) {
  const state = payableState(
    dec(r.originalAmount),
    r.payouts.map((p) => ({ amount: dec(p.amount), status: p.status }))
  )
  return {
    payableId: r.id,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    session: r.sourceSession,
    player: r.player,
    settlement: {
      ...r.settlement,
      receivedAt: r.settlement.receivedAt?.toISOString() ?? null,
    },
    netPayout: fmt(state.original),
    paid: fmt(state.executed),
    inTransit: fmt(state.reserved),
    pending: fmt(state.pending),
    available: fmt(state.available),
    payouts: r.payouts.map(payoutView),
  }
}
export type PendingPayableView = ReturnType<typeof pendingView>

/**
 * Obligaciones por pagar a jugadores (abiertas o parcialmente pagadas),
 * aunque su mesa o su sesión ya hayan cerrado. Contrato para el reporte de
 * cierre del Módulo 12 (`sessionId` filtra por sesión de origen).
 */
export async function listPendingPayables(
  filters: { sessionId?: string; playerId?: string } = {}
) {
  const rows = await prisma.settlementPayable.findMany({
    where: {
      status: { in: ["OPEN", "PARTIALLY_PAID"] },
      ...(filters.sessionId ? { sourceSessionId: filters.sessionId } : {}),
      ...(filters.playerId ? { playerId: filters.playerId } : {}),
    },
    orderBy: { createdAt: "asc" },
    select: pendingSelect,
  })
  const items = rows.map(pendingView)
  const total = items.reduce((acc, i) => acc.add(i.pending), dec(0))
  const inTransit = items.reduce((acc, i) => acc.add(i.inTransit), dec(0))
  return {
    items,
    totals: {
      count: items.length,
      players: new Set(items.map((i) => i.player.id)).size,
      pending: fmt(total),
      inTransit: fmt(inTransit),
    },
  }
}
