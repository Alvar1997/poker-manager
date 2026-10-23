import "server-only"

import { Prisma } from "@/generated/prisma/client"
import { BusinessRuleError, ConflictError, NotFoundError } from "@/lib/errors"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import {
  createSpecialPayableInTx,
  isBankingPayableKind,
  lockPayableInTx,
  registerSpecialPayoutInTx,
  resolveSpecialPayoutInTx,
  type ResolvePayoutInput,
} from "@/modules/special-operations/special-payout.service"

import {
  ADVANCE_SOURCE,
  advanceLimitOf,
  audit,
  auditBankingFailure,
  BANKING_TX,
  lockBankingRow,
  lockPlayerInTx,
  payablesOfSource,
  payoutTotals,
  supersedeOpenClosingsInTx,
  WITHDRAWAL_SOURCE,
  type Tx,
} from "./banking-core"
import { dec, disbursementStatus, fmt, ZERO } from "./banking.math"
import type { DisburseInput } from "./banking.schemas"

/**
 * Desembolsos REALES del Módulo 17 sobre la infraestructura del Módulo 16:
 * cada pago es una obligación especial (`special_payables`, tipo BANKING_*)
 * pagada con `registerSpecialPayoutInTx` en la MISMA transacción en que se
 * revalida el límite (anticipos) o lo comprometido (retiros). Efectivo:
 * custodia administrativa del pagador o caja de la sesión ABIERTA; nunca una
 * caja cerrada ni saldo negativo (lo impide el libro). Transferencia:
 * PENDIENTE (no cuenta como pagada) hasta confirmarla con referencia.
 * La autorización nunca equivale al desembolso.
 */

async function openSessionId(tx: Tx) {
  const s = await tx.pokerSession.findFirst({
    where: { status: "OPEN" },
    select: { id: true },
  })
  return s?.id ?? null
}

async function playerName(tx: Tx, playerId: string) {
  const p = await tx.player.findUniqueOrThrow({
    where: { id: playerId },
    select: { name: true },
  })
  return p.name
}

/** Recalcula el estado de un anticipo o retiro a partir de lo PAGADO. */
export async function refreshSourceStatusInTx(
  tx: Tx,
  kind: string,
  sourceId: string
) {
  const [id] = sourceId.split(":")
  if (kind === "BANKING_ADVANCE") {
    const a = await tx.bankingAdvance.findUniqueOrThrow({ where: { id } })
    const t = payoutTotals(await payablesOfSource(tx, ADVANCE_SOURCE, id))
    const status = disbursementStatus(
      dec(a.authorizedAmount),
      t.executed,
      a.status === "CLOSED"
    )
    if (status !== a.status)
      await tx.bankingAdvance.update({
        where: { id },
        data: { status, version: { increment: 1 } },
      })
    return { status, totals: t }
  }
  if (kind === "BANKING_RESERVE_WITHDRAWAL") {
    const w = await tx.bankingReserveWithdrawal.findUniqueOrThrow({
      where: { id },
    })
    const t = payoutTotals(await payablesOfSource(tx, WITHDRAWAL_SOURCE, id))
    const s = disbursementStatus(
      dec(w.approvedAmount),
      t.executed,
      w.status === "CLOSED"
    )
    const status = s === "AUTHORIZED" ? "APPROVED" : s
    if (status !== w.status)
      await tx.bankingReserveWithdrawal.update({
        where: { id },
        data: { status, version: { increment: 1 } },
      })
    return { status, totals: t }
  }
  return null
}

/** Crea la obligación del desembolso y lo paga (o lo deja en trámite). */
async function disburseInTx(
  tx: Tx,
  actor: SessionUser,
  input: DisburseInput,
  source: {
    kind: "BANKING_ADVANCE" | "BANKING_RESERVE_WITHDRAWAL"
    sourceType: string
    id: string
    playerId: string
    sequence: number
  },
  ctx: RequestContext
) {
  const amount = dec(input.amount)
  const payable = await createSpecialPayableInTx(tx, actor, {
    kind: source.kind,
    sourceType: source.sourceType,
    sourceId: `${source.id}:${source.sequence}`,
    playerId: source.playerId,
    beneficiaryName: await playerName(tx, source.playerId),
    sessionId: await openSessionId(tx),
    amount,
  })
  const locked = await lockPayableInTx(tx, payable.id)
  const r = await registerSpecialPayoutInTx(
    tx,
    actor,
    locked,
    {
      method: input.method,
      funding: input.funding,
      amount: input.amount,
      bankReference: input.bankReference,
      notes: input.notes,
      idempotencyKey: input.idempotencyKey,
    },
    ctx
  )
  return { payableId: payable.id, ...r }
}

async function replayOf(idempotencyKey: string) {
  return prisma.specialPayout.findUnique({
    where: { idempotencyKey },
    select: { id: true, payable: { select: { sourceId: true } } },
  })
}

// ── Anticipos ─────────────────────────────────────────────────────────

/**
 * Entrega REAL de (parte de) un anticipo. El límite conservador se vuelve a
 * calcular DENTRO de esta transacción (bloqueado el jugador): una
 * autorización previa nunca supera el disponible actualizado.
 */
export async function disburseAdvance(
  actor: SessionUser,
  advanceId: string,
  input: DisburseInput,
  ctx: RequestContext = {}
) {
  const prev = await replayOf(input.idempotencyKey)
  if (prev) {
    if (!prev.payable.sourceId.startsWith(`${advanceId}:`))
      throw new ConflictError("Clave de operación reutilizada")
    return { payoutId: prev.id, replayed: true }
  }
  const head = await prisma.bankingAdvance.findUnique({
    where: { id: advanceId },
    select: { playerId: true },
  })
  if (!head) throw new NotFoundError("Anticipo no encontrado")
  const amount = dec(input.amount)
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPlayerInTx(tx, head.playerId)
      await lockBankingRow(tx, "banking_advances", advanceId)
      const a = await tx.bankingAdvance.findUniqueOrThrow({
        where: { id: advanceId },
      })
      if (a.status !== "AUTHORIZED" && a.status !== "PARTIALLY_PAID")
        throw new BusinessRuleError("El anticipo ya no admite pagos.")
      const payables = await payablesOfSource(tx, ADVANCE_SOURCE, advanceId)
      const t = payoutTotals(payables)
      if (t.unpaid.greaterThan(0))
        throw new BusinessRuleError(
          "Hay un pago de este anticipo sin completar (transferencia en trámite o fallida): resuélvelo primero."
        )
      const remaining = dec(a.authorizedAmount).sub(t.obligations)
      if (amount.greaterThan(remaining))
        throw new BusinessRuleError(
          `El pago excede lo autorizado pendiente ($${fmt(remaining)}).`,
          { available: fmt(remaining) }
        )
      // Revalidación del límite con datos ACTUALES (pérdidas confirmadas,
      // otros anticipos, recuperaciones, cortes pendientes).
      const limit = await advanceLimitOf(tx, a.cycleId)
      if (limit.blockedReason)
        throw new BusinessRuleError(
          `No se puede pagar el anticipo: ${limit.blockedReason}`
        )
      const othersCommitted = limit.committed.sub(dec(a.authorizedAmount))
      const room = limit.guaranteedShare
        .sub(othersCommitted)
        .sub(limit.recovery.total)
        .sub(t.obligations)
      if (amount.greaterThan(room))
        throw new BusinessRuleError(
          `El pago supera la participación garantizada disponible ($${fmt(room.isNegative() ? ZERO : room)}).`,
          { available: fmt(room.isNegative() ? ZERO : room) }
        )
      const r = await disburseInTx(
        tx,
        actor,
        input,
        {
          kind: "BANKING_ADVANCE",
          sourceType: ADVANCE_SOURCE,
          id: advanceId,
          playerId: head.playerId,
          sequence: payables.length + 1,
        },
        ctx
      )
      const s = await refreshSourceStatusInTx(
        tx,
        "BANKING_ADVANCE",
        `${advanceId}:`
      )
      await supersedeOpenClosingsInTx(
        tx,
        actor,
        head.playerId,
        "Pago de anticipo",
        ctx
      )
      await audit(tx, actor, ctx, AUDIT_ACTIONS.BANKING_ADVANCE_DISBURSED, {
        entityType: "BankingAdvance",
        entityId: advanceId,
        playerId: head.playerId,
        amount: fmt(amount),
        idempotencyKey: input.idempotencyKey,
        metadata: {
          payoutId: r.payoutId,
          payableId: r.payableId,
          folio: r.folio,
          method: input.method,
          status: r.status,
          advanceStatus: s?.status,
          availableBefore: fmt(room),
        },
      })
      return { payoutId: r.payoutId, replayed: false, status: r.status }
    }, BANKING_TX)
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await replayOf(input.idempotencyKey)
      if (again) return { payoutId: again.id, replayed: true }
      throw new ConflictError("El anticipo cambió mientras se pagaba.")
    }
    await auditBankingFailure(actor, "BankingAdvance", advanceId, error, ctx)
    throw error
  }
}

// ── Retiros de reserva ────────────────────────────────────────────────

/** Pago REAL de (parte de) un retiro APROBADO; nunca más que lo aprobado. */
export async function disburseWithdrawal(
  actor: SessionUser,
  withdrawalId: string,
  input: DisburseInput,
  ctx: RequestContext = {}
) {
  const prev = await replayOf(input.idempotencyKey)
  if (prev) {
    if (!prev.payable.sourceId.startsWith(`${withdrawalId}:`))
      throw new ConflictError("Clave de operación reutilizada")
    return { payoutId: prev.id, replayed: true }
  }
  const head = await prisma.bankingReserveWithdrawal.findUnique({
    where: { id: withdrawalId },
    select: { playerId: true },
  })
  if (!head) throw new NotFoundError("Retiro no encontrado")
  const amount = dec(input.amount)
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPlayerInTx(tx, head.playerId)
      await lockBankingRow(tx, "banking_reserve_withdrawals", withdrawalId)
      const w = await tx.bankingReserveWithdrawal.findUniqueOrThrow({
        where: { id: withdrawalId },
      })
      if (w.status !== "APPROVED" && w.status !== "PARTIALLY_PAID")
        throw new BusinessRuleError(
          w.status === "REQUESTED"
            ? "El retiro requiere aprobación digital de un socio antes de pagarse."
            : "El retiro ya no admite pagos."
        )
      const payables = await payablesOfSource(
        tx,
        WITHDRAWAL_SOURCE,
        withdrawalId
      )
      const t = payoutTotals(payables)
      if (t.unpaid.greaterThan(0))
        throw new BusinessRuleError(
          "Hay un pago de este retiro sin completar (transferencia en trámite o fallida): resuélvelo primero."
        )
      const remaining = dec(w.approvedAmount).sub(t.obligations)
      if (amount.greaterThan(remaining))
        throw new BusinessRuleError(
          `El pago excede lo aprobado pendiente ($${fmt(remaining)}).`,
          { available: fmt(remaining) }
        )
      const r = await disburseInTx(
        tx,
        actor,
        input,
        {
          kind: "BANKING_RESERVE_WITHDRAWAL",
          sourceType: WITHDRAWAL_SOURCE,
          id: withdrawalId,
          playerId: head.playerId,
          sequence: payables.length + 1,
        },
        ctx
      )
      const s = await refreshSourceStatusInTx(
        tx,
        "BANKING_RESERVE_WITHDRAWAL",
        `${withdrawalId}:`
      )
      await audit(
        tx,
        actor,
        ctx,
        AUDIT_ACTIONS.BANKING_RESERVE_WITHDRAWAL_PAID,
        {
          entityType: "BankingReserveWithdrawal",
          entityId: withdrawalId,
          playerId: head.playerId,
          amount: fmt(amount),
          idempotencyKey: input.idempotencyKey,
          metadata: {
            payoutId: r.payoutId,
            payableId: r.payableId,
            folio: r.folio,
            method: input.method,
            status: r.status,
            withdrawalStatus: s?.status,
          },
        }
      )
      return { payoutId: r.payoutId, replayed: false, status: r.status }
    }, BANKING_TX)
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await replayOf(input.idempotencyKey)
      if (again) return { payoutId: again.id, replayed: true }
      throw new ConflictError("El retiro cambió mientras se pagaba.")
    }
    await auditBankingFailure(
      actor,
      "BankingReserveWithdrawal",
      withdrawalId,
      error,
      ctx
    )
    throw error
  }
}

// ── Obligaciones de bancaje (corte, reintentos) ───────────────────────

async function payableHead(payableId: string) {
  const p = await prisma.specialPayable.findUnique({
    where: { id: payableId },
    select: { kind: true, playerId: true, sourceId: true },
  })
  if (!p || !isBankingPayableKind(p.kind) || !p.playerId)
    throw new NotFoundError("Obligación no encontrada")
  return { ...p, playerId: p.playerId }
}

/**
 * Pago de una obligación de bancaje ya existente: el pago del corte
 * (parcial o total) o el reintento de un desembolso cuya transferencia falló.
 */
export async function payBankingPayable(
  actor: SessionUser,
  payableId: string,
  input: DisburseInput,
  ctx: RequestContext = {}
) {
  const prev = await prisma.specialPayout.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, payableId: true },
  })
  if (prev) {
    if (prev.payableId !== payableId)
      throw new ConflictError("Clave de operación reutilizada")
    return { payoutId: prev.id, replayed: true }
  }
  const head = await payableHead(payableId)
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPlayerInTx(tx, head.playerId)
      const payable = await lockPayableInTx(tx, payableId)
      const r = await registerSpecialPayoutInTx(
        tx,
        actor,
        payable,
        {
          method: input.method,
          funding: input.funding,
          amount: input.amount,
          bankReference: input.bankReference,
          notes: input.notes,
          idempotencyKey: input.idempotencyKey,
        },
        ctx
      )
      await refreshSourceStatusInTx(tx, head.kind, head.sourceId)
      await audit(tx, actor, ctx, AUDIT_ACTIONS.BANKING_PAYOUT_REGISTERED, {
        entityType: "SpecialPayable",
        entityId: payableId,
        playerId: head.playerId,
        amount: fmt(new Prisma.Decimal(input.amount)),
        idempotencyKey: input.idempotencyKey,
        metadata: {
          kind: head.kind,
          payoutId: r.payoutId,
          folio: r.folio,
          method: input.method,
          status: r.status,
          pending: fmt(r.state.pending),
        },
      })
      return { payoutId: r.payoutId, replayed: false, status: r.status }
    }, BANKING_TX)
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await prisma.specialPayout.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true },
      })
      if (again) return { payoutId: again.id, replayed: true }
      throw new ConflictError("La obligación cambió mientras se pagaba.")
    }
    await auditBankingFailure(actor, "SpecialPayable", payableId, error, ctx)
    throw error
  }
}

/** Confirma (EXECUTED con referencia), marca fallida o cancela una transferencia. */
export async function resolveBankingPayout(
  actor: SessionUser,
  payoutId: string,
  input: ResolvePayoutInput,
  ctx: RequestContext = {}
) {
  const prev = await prisma.specialPayout.findUnique({
    where: { resolveIdempotencyKey: input.idempotencyKey },
    select: { id: true },
  })
  if (prev) {
    if (prev.id !== payoutId)
      throw new ConflictError("Clave de operación reutilizada")
    return { replayed: true }
  }
  const x = await prisma.specialPayout.findUnique({
    where: { id: payoutId },
    select: { payableId: true },
  })
  if (!x) throw new NotFoundError("Pago no encontrado")
  const head = await payableHead(x.payableId)
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPlayerInTx(tx, head.playerId)
      const payable = await lockPayableInTx(tx, x.payableId)
      await resolveSpecialPayoutInTx(tx, actor, payable, payoutId, input, ctx)
      await refreshSourceStatusInTx(tx, head.kind, head.sourceId)
      if (input.outcome === "EXECUTED" && head.kind === "BANKING_ADVANCE")
        await supersedeOpenClosingsInTx(
          tx,
          actor,
          head.playerId,
          "Pago de anticipo confirmado",
          ctx
        )
      await audit(tx, actor, ctx, AUDIT_ACTIONS.BANKING_PAYOUT_RESOLVED, {
        entityType: "SpecialPayout",
        entityId: payoutId,
        playerId: head.playerId,
        reason: input.reason ?? null,
        metadata: { kind: head.kind, outcome: input.outcome },
      })
      return { replayed: false }
    }, BANKING_TX)
  } catch (error) {
    if (isUniqueViolation(error))
      throw new ConflictError("El pago ya fue resuelto por otra persona.")
    await auditBankingFailure(actor, "SpecialPayout", payoutId, error, ctx)
    throw error
  }
}
