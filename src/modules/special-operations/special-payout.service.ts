import "server-only"

import { Prisma } from "@/generated/prisma/client"
import {
  AppError,
  BusinessRuleError,
  ConflictError,
  NotFoundError,
} from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import { isUniqueViolation } from "@/lib/prisma-errors"
import {
  AUDIT_ACTIONS,
  recordAudit,
  type AuditAction,
} from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import {
  custodianScope,
  GLOBAL_SCOPE,
  postTransactionInTx,
  type LedgerEntry,
  type Tx,
} from "@/modules/cash/ledger"
import { issueFolio } from "@/modules/settings/folio.service"

import { createSpecialReceiptInTx } from "./special-evidence"

import {
  assertPayoutWithin,
  dec,
  fmt,
  payableState,
  PayoutExceedsError,
  redemptionStatusFor,
} from "./special.math"

/**
 * Obligaciones por pagar del Módulo 16 y sus desembolsos REALES.
 *
 * - La obligación nace de un hecho registrado (fichas recibidas, reverso
 *   ejecutado, corrección ejecutada, fondos reales no aplicados) y su saldo
 *   se DERIVA de los pagos EXECUTED.
 * - Efectivo: se contabiliza al entregarlo (custodia administrativa del
 *   pagador, o la caja de la sesión de origen SOLO si sigue OPEN). Nunca
 *   una caja cerrada; nunca saldo negativo (el libro lo rechaza).
 * - Transferencia: PENDING (compromete saldo, no es pago) → EXECUTED tras
 *   confirmación manual con referencia → asiento al banco. No hay
 *   integración bancaria: el sistema nunca afirma que un banco pagó.
 */

export const SPECIAL_TX = { maxWait: 15_000, timeout: 25_000 } as const

type PayableKind =
  | "REDEMPTION"
  | "PURCHASE_REFUND"
  | "SETTLEMENT_ADJUSTMENT"
  | "UNAPPLIED_REFUND"

/** Cuenta técnica que se descarga al pagar (la que registró la obligación). */
const DEBIT_ACCOUNT: Record<
  PayableKind,
  "PLAYER_SETTLEMENTS" | "PLAYER_PURCHASES" | "UNAPPLIED_PLAYER_FUNDS"
> = {
  REDEMPTION: "PLAYER_SETTLEMENTS",
  SETTLEMENT_ADJUSTMENT: "PLAYER_SETTLEMENTS",
  PURCHASE_REFUND: "PLAYER_PURCHASES",
  UNAPPLIED_REFUND: "UNAPPLIED_PLAYER_FUNDS",
}

const KIND_LABEL: Record<PayableKind, string> = {
  REDEMPTION: "canje posterior",
  PURCHASE_REFUND: "reembolso por reverso de compra",
  SETTLEMENT_ADJUSTMENT: "corrección de liquidación",
  UNAPPLIED_REFUND: "devolución de fondos no aplicados",
}

export async function lockPayableInTx(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "special_payables" WHERE "id" = ${id} FOR UPDATE`
  if (rows.length === 0) throw new NotFoundError("Obligación no encontrada")
  return tx.specialPayable.findUniqueOrThrow({
    where: { id },
    include: { payouts: { orderBy: { sequence: "asc" } } },
  })
}

/** Crea la obligación (una por origen; el índice único impide duplicarla). */
export async function createSpecialPayableInTx(
  tx: Tx,
  actor: SessionUser,
  input: {
    kind: PayableKind
    sourceType: string
    sourceId: string
    playerId: string | null
    beneficiaryName: string
    sessionId: string | null
    amount: Prisma.Decimal
  }
) {
  if (!input.amount.greaterThan(0))
    throw new BusinessRuleError("Una obligación debe ser mayor que cero.")
  return tx.specialPayable.create({
    data: {
      kind: input.kind,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      playerId: input.playerId,
      beneficiaryName: input.beneficiaryName,
      sessionId: input.sessionId,
      originalAmount: input.amount,
      createdById: actor.id,
    },
  })
}

/** Recalcula el estado derivado y propaga al expediente de origen. */
async function refreshPayableInTx(tx: Tx, payableId: string) {
  const p = await tx.specialPayable.findUniqueOrThrow({
    where: { id: payableId },
    include: { payouts: true },
  })
  const s = payableState(p.originalAmount, p.payouts)
  if (s.status !== p.status)
    await tx.specialPayable.update({
      where: { id: p.id },
      data: {
        status: s.status,
        paidAt: s.status === "PAID" ? new Date() : null,
      },
    })
  if (p.kind === "REDEMPTION") {
    await tx.lateChipRedemption.update({
      where: { id: p.sourceId },
      data: { status: redemptionStatusFor(s), version: { increment: 1 } },
    })
  }
  return { payable: p, state: s }
}

async function sessionStatus(tx: Tx, sessionId: string) {
  const s = await tx.pokerSession.findUnique({
    where: { id: sessionId },
    select: { status: true },
  })
  return s?.status ?? null
}

/** Contabiliza UN desembolso real (efectivo entregado o transferencia ejecutada). */
async function postPayoutInTx(
  tx: Tx,
  actor: SessionUser,
  payable: { id: string; kind: PayableKind; playerId: string | null },
  payout: {
    id: string
    folio: string
    amount: Prisma.Decimal
    funding: "SESSION_CASH" | "ADMIN_CUSTODY" | "BANK"
    sessionId: string | null
    custodianUserId: string | null
    bankReference: string | null
  },
  ctx: RequestContext
) {
  let source: LedgerEntry
  if (payout.funding === "SESSION_CASH") {
    // Revalidado DENTRO de la transacción: nunca una caja cerrada.
    if (
      !payout.sessionId ||
      (await sessionStatus(tx, payout.sessionId)) !== "OPEN"
    )
      throw new BusinessRuleError(
        "La caja de la sesión de origen ya no está abierta: paga desde custodia administrativa o por transferencia."
      )
    source = {
      account: "CASH_ON_HAND",
      direction: "CREDIT",
      amount: payout.amount,
      scopeKey: payout.sessionId,
    }
  } else if (payout.funding === "ADMIN_CUSTODY") {
    source = {
      account: "ADMIN_CASH_CUSTODY",
      direction: "CREDIT",
      amount: payout.amount,
      scopeKey: custodianScope(payout.custodianUserId!),
    }
  } else {
    source = {
      account: "BANK",
      direction: "CREDIT",
      amount: payout.amount,
      scopeKey: GLOBAL_SCOPE,
    }
  }
  const isBank = payout.funding === "BANK"
  return postTransactionInTx(
    tx,
    {
      type: isBank ? "BANK_TRANSFER_PAYOUT" : "PLAYER_SETTLEMENT",
      sessionId: payout.funding === "SESSION_CASH" ? payout.sessionId : null,
      playerId: payable.playerId,
      referenceType: "SpecialPayout",
      referenceId: payout.id,
      reason: `${isBank ? "Transferencia ejecutada" : "Pago en efectivo"} · ${KIND_LABEL[payable.kind]} (${payout.folio})`,
      notes: payout.bankReference
        ? `Ref. bancaria: ${payout.bankReference}`
        : null,
      idempotencyKey: `special-payout:${payout.id}`,
      requestHash: `SpecialPayout-${payout.id}-${fmt(payout.amount)}`,
      actorId: actor.id,
      audit: {
        action: AUDIT_ACTIONS.SPECIAL_PAYOUT_EXECUTED,
        metadata: {
          payableId: payable.id,
          payoutId: payout.id,
          kind: payable.kind,
          funding: payout.funding,
          amount: fmt(payout.amount),
        },
      },
    },
    [
      {
        account: DEBIT_ACCOUNT[payable.kind],
        direction: "DEBIT",
        amount: payout.amount,
        scopeKey: GLOBAL_SCOPE,
      },
      source,
    ],
    ctx
  )
}

export const PAYABLE_SLUG: Record<PayableKind, string> = {
  REDEMPTION: "redemption",
  PURCHASE_REFUND: "purchase-refund",
  SETTLEMENT_ADJUSTMENT: "settlement-adjustment",
  UNAPPLIED_REFUND: "unapplied-refund",
}

/** Anexo inmutable por cada pago EJECUTADO (lo pagado y lo pendiente reales). */
async function payoutReceiptInTx(
  tx: Tx,
  actor: SessionUser,
  payable: {
    kind: PayableKind
    sourceId: string
    beneficiaryName: string
    originalAmount: Prisma.Decimal
  },
  payout: { id: string; folio: string; amount: Prisma.Decimal; method: string },
  state: ReturnType<typeof payableState>
) {
  await createSpecialReceiptInTx(tx, actor, {
    kind: "SPECIAL_PAYOUT",
    sourceKey: `payout:${PAYABLE_SLUG[payable.kind]}:${payable.sourceId}:${payout.id}`,
    kicker: `Pago ${payout.folio}`,
    title: `Pago de ${KIND_LABEL[payable.kind]}`,
    lines: [
      { label: "Beneficiario", value: payable.beneficiaryName },
      {
        label: "Método",
        value:
          payout.method === "CASH" ? "Efectivo" : "Transferencia ejecutada",
      },
      {
        label: "Importe pagado",
        value: `$${fmt(payout.amount)}`,
        strong: true,
      },
      { label: "Obligación", value: `$${fmt(payable.originalAmount)}` },
      { label: "Pagado acumulado", value: `$${fmt(state.executed)}` },
      { label: "Pendiente", value: `$${fmt(state.pending)}`, strong: true },
    ],
    footer: state.pending.greaterThan(0)
      ? "Pago parcial: el saldo pendiente sigue vigente como obligación."
      : "Obligación liquidada en su totalidad.",
  })
}

/** Evento de auditoría por avance del ORIGEN (canje / fondos no aplicados). */
function progressAction(
  kind: PayableKind,
  status: "OPEN" | "PARTIALLY_PAID" | "PAID"
): AuditAction | null {
  if (status === "OPEN") return null
  if (kind === "REDEMPTION")
    return status === "PAID"
      ? AUDIT_ACTIONS.LATE_REDEMPTION_PAID
      : AUDIT_ACTIONS.LATE_REDEMPTION_PARTIALLY_PAID
  if (kind === "UNAPPLIED_REFUND")
    return status === "PAID"
      ? AUDIT_ACTIONS.UNAPPLIED_FUNDS_REFUNDED
      : AUDIT_ACTIONS.UNAPPLIED_FUNDS_PARTIALLY_REFUNDED
  return null
}

async function auditProgress(
  tx: Tx,
  actor: SessionUser,
  payable: {
    id: string
    kind: PayableKind
    sourceId: string
    playerId: string | null
  },
  state: ReturnType<typeof payableState>,
  ctx: RequestContext
) {
  const action = progressAction(payable.kind, state.status)
  if (!action) return
  await recordAudit(
    {
      action,
      entityType:
        payable.kind === "REDEMPTION"
          ? "LateChipRedemption"
          : "UnappliedPlayerFunds",
      entityId: payable.sourceId,
      actorUserId: actor.id,
      actorRole: actor.role,
      requestId: ctx.requestId,
      playerId: payable.playerId,
      amount: fmt(state.executed),
      metadata: {
        payableId: payable.id,
        paid: fmt(state.executed),
        pending: fmt(state.pending),
        inTransit: fmt(state.inTransit),
      },
    },
    tx
  )
}

export type RegisterPayoutInput = {
  method: "CASH" | "BANK_TRANSFER"
  /** Solo efectivo: custodia administrativa del pagador o caja de la sesión de origen. */
  funding?: "ADMIN_CUSTODY" | "SESSION_CASH"
  amount: string
  bankReference?: string
  notes?: string
  idempotencyKey: string
}

/**
 * Registra un desembolso. Efectivo → EXECUTED con su asiento en la misma
 * transacción. Transferencia → PENDING (no paga hasta confirmarla).
 */
export async function registerSpecialPayout(
  actor: SessionUser,
  payableId: string,
  input: RegisterPayoutInput,
  ctx: RequestContext = {}
) {
  const previous = await prisma.specialPayout.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, payableId: true },
  })
  if (previous) {
    if (previous.payableId !== payableId)
      throw new ConflictError("Clave de operación reutilizada")
    return { payoutId: previous.id, replayed: true }
  }
  const amount = dec(input.amount)
  try {
    return await prisma.$transaction(async (tx) => {
      const payable = await lockPayableInTx(tx, payableId)
      try {
        assertPayoutWithin(amount, payable.originalAmount, payable.payouts)
      } catch (e) {
        if (e instanceof PayoutExceedsError)
          throw new BusinessRuleError(e.message, {
            available: fmt(e.available),
          })
        throw new BusinessRuleError(
          e instanceof Error ? e.message : "Importe inválido"
        )
      }
      let funding: "SESSION_CASH" | "ADMIN_CUSTODY" | "BANK"
      if (input.method === "BANK_TRANSFER") {
        funding = "BANK"
      } else {
        funding = input.funding ?? "ADMIN_CUSTODY"
        if (funding === "SESSION_CASH") {
          if (
            !payable.sessionId ||
            (await sessionStatus(tx, payable.sessionId)) !== "OPEN"
          )
            throw new BusinessRuleError(
              "Solo se paga con la caja de la sesión de origen mientras esté ABIERTA. Usa custodia administrativa o transferencia."
            )
        }
      }
      const folio = await issueFolio(tx, "SPECIAL_PAYOUT")
      const payout = await tx.specialPayout.create({
        data: {
          folio,
          payableId,
          sequence: payable.payouts.length + 1,
          amount,
          method: input.method,
          funding,
          status: "PENDING",
          sessionId: funding === "SESSION_CASH" ? payable.sessionId : null,
          custodianUserId: funding === "ADMIN_CUSTODY" ? actor.id : null,
          bankReference: input.bankReference ?? null,
          notes: input.notes ?? null,
          requestedById: actor.id,
          idempotencyKey: input.idempotencyKey,
        },
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.SPECIAL_PAYOUT_REGISTERED,
          entityType: "SpecialPayout",
          entityId: payout.id,
          actorUserId: actor.id,
          actorRole: actor.role,
          requestId: ctx.requestId,
          playerId: payable.playerId,
          idempotencyKey: input.idempotencyKey,
          amount: fmt(amount),
          metadata: {
            folio,
            payableId,
            kind: payable.kind,
            method: input.method,
            funding,
            status: input.method === "CASH" ? "EXECUTED" : "PENDING",
          },
        },
        tx
      )
      if (input.method === "CASH") {
        const posted = await postPayoutInTx(
          tx,
          actor,
          payable,
          { ...payout, funding },
          ctx
        )
        await tx.specialPayout.update({
          where: { id: payout.id },
          data: {
            status: "EXECUTED",
            financialTransactionId: posted.transactionId,
            executedAt: new Date(),
            resolvedById: actor.id,
            resolvedAt: new Date(),
          },
        })
      }
      const { state } = await refreshPayableInTx(tx, payableId)
      if (input.method === "CASH") {
        await auditProgress(tx, actor, payable, state, ctx)
        await payoutReceiptInTx(tx, actor, payable, payout, state)
      }
      return { payoutId: payout.id, replayed: false }
    }, SPECIAL_TX)
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await prisma.specialPayout.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true },
      })
      if (again) return { payoutId: again.id, replayed: true }
      throw new ConflictError("El pago cambió mientras se registraba.")
    }
    await auditFailure(actor, "SpecialPayable", payableId, error, ctx)
    throw error
  }
}

/** Confirma (EXECUTED), marca fallida o cancela una transferencia PENDIENTE. */
export async function resolveSpecialPayout(
  actor: SessionUser,
  payoutId: string,
  input: {
    outcome: "EXECUTED" | "FAILED" | "CANCELLED"
    bankReference?: string
    reason?: string
    idempotencyKey: string
  },
  ctx: RequestContext = {}
) {
  const previous = await prisma.specialPayout.findUnique({
    where: { resolveIdempotencyKey: input.idempotencyKey },
    select: { id: true },
  })
  if (previous) {
    if (previous.id !== payoutId)
      throw new ConflictError("Clave de operación reutilizada")
    return { replayed: true }
  }
  if (input.outcome === "EXECUTED" && !input.bankReference?.trim())
    throw new BusinessRuleError(
      "Captura la referencia bancaria de la transferencia realizada."
    )
  if (input.outcome !== "EXECUTED" && !input.reason?.trim())
    throw new BusinessRuleError("Indica el motivo.")
  try {
    return await prisma.$transaction(async (tx) => {
      const head = await tx.specialPayout.findUnique({
        where: { id: payoutId },
        select: { payableId: true },
      })
      if (!head) throw new NotFoundError("Pago no encontrado")
      const payable = await lockPayableInTx(tx, head.payableId)
      const payout = payable.payouts.find((p) => p.id === payoutId)!
      if (payout.status !== "PENDING")
        throw new BusinessRuleError("Este pago ya fue resuelto.")
      if (payout.method !== "BANK_TRANSFER")
        throw new BusinessRuleError(
          "Solo las transferencias quedan pendientes de confirmar."
        )
      let financialTransactionId: string | null = null
      if (input.outcome === "EXECUTED") {
        const posted = await postPayoutInTx(
          tx,
          actor,
          payable,
          {
            ...payout,
            funding: "BANK",
            bankReference: input.bankReference!.trim(),
          },
          ctx
        )
        financialTransactionId = posted.transactionId
      }
      const now = new Date()
      await tx.specialPayout.update({
        where: { id: payoutId },
        data: {
          status: input.outcome,
          bankReference: input.bankReference?.trim() ?? payout.bankReference,
          failureReason: input.outcome === "EXECUTED" ? null : input.reason,
          financialTransactionId,
          executedAt: input.outcome === "EXECUTED" ? now : null,
          resolvedById: actor.id,
          resolvedAt: now,
          resolveIdempotencyKey: input.idempotencyKey,
        },
      })
      if (input.outcome !== "EXECUTED")
        await recordAudit(
          {
            action:
              input.outcome === "FAILED"
                ? AUDIT_ACTIONS.SPECIAL_PAYOUT_FAILED
                : AUDIT_ACTIONS.SPECIAL_PAYOUT_CANCELLED,
            entityType: "SpecialPayout",
            entityId: payoutId,
            actorUserId: actor.id,
            actorRole: actor.role,
            requestId: ctx.requestId,
            playerId: payable.playerId,
            reason: input.reason,
            amount: fmt(payout.amount),
            metadata: { folio: payout.folio, payableId: payable.id },
          },
          tx
        )
      const { state } = await refreshPayableInTx(tx, payable.id)
      if (input.outcome === "EXECUTED") {
        await auditProgress(tx, actor, payable, state, ctx)
        await payoutReceiptInTx(tx, actor, payable, payout, state)
      }
      return { replayed: false }
    }, SPECIAL_TX)
  } catch (error) {
    if (isUniqueViolation(error))
      throw new ConflictError("El pago ya fue resuelto por otra persona.")
    await auditFailure(actor, "SpecialPayout", payoutId, error, ctx)
    throw error
  }
}

/** Registra el rechazo REAL de una operación especial (fuera de la tx fallida). */
export async function auditFailure(
  actor: SessionUser,
  entityType: string,
  entityId: string,
  error: unknown,
  ctx: RequestContext,
  extra: Record<string, unknown> = {}
) {
  if (!(error instanceof AppError)) return
  try {
    await recordAudit({
      action: AUDIT_ACTIONS.SPECIAL_OPERATION_FAILED,
      entityType,
      entityId,
      actorUserId: actor.id,
      actorRole: actor.role,
      requestId: ctx.requestId,
      result: "FAILURE",
      reason: error.message.slice(0, 500),
      metadata: { code: error.code, ...extra },
    })
  } catch {
    // La auditoría del fallo nunca oculta el error original.
  }
}

/** Vista de una obligación con su saldo derivado. */
export function payableView(p: {
  id: string
  kind: string
  sourceType: string
  sourceId: string
  playerId: string | null
  beneficiaryName: string
  sessionId: string | null
  originalAmount: Prisma.Decimal
  createdAt: Date
  payouts: {
    id: string
    folio: string
    sequence: number
    amount: Prisma.Decimal
    method: string
    funding: string
    status: string
    bankReference: string | null
    failureReason: string | null
    createdAt: Date
    executedAt: Date | null
  }[]
}) {
  const s = payableState(p.originalAmount, p.payouts)
  return {
    id: p.id,
    kind: p.kind,
    sourceType: p.sourceType,
    sourceId: p.sourceId,
    playerId: p.playerId,
    beneficiaryName: p.beneficiaryName,
    sessionId: p.sessionId,
    createdAt: p.createdAt.toISOString(),
    original: fmt(p.originalAmount),
    paid: fmt(s.executed),
    inTransit: fmt(s.inTransit),
    pending: fmt(s.pending),
    available: fmt(s.available),
    status: s.status,
    payouts: p.payouts.map((x) => ({
      id: x.id,
      folio: x.folio,
      sequence: x.sequence,
      amount: fmt(x.amount),
      method: x.method,
      funding: x.funding,
      status: x.status,
      bankReference: x.bankReference,
      failureReason: x.failureReason,
      createdAt: x.createdAt.toISOString(),
      executedAt: x.executedAt?.toISOString() ?? null,
    })),
  }
}

export type PayableView = ReturnType<typeof payableView>
export const ZERO_DEC = new Prisma.Decimal(0)
