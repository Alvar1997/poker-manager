import "server-only"

import { randomUUID } from "node:crypto"

import { Prisma } from "@/generated/prisma/client"
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
import { registerPendingBankTransferInTx } from "@/modules/cash/bank-transfer.service"
import {
  custodianScope,
  GLOBAL_SCOPE,
  postTransactionInTx,
  type LedgerEntry,
} from "@/modules/cash/ledger"
import {
  allocateFifo,
  ExcessPaymentError,
  splitApplicable,
} from "@/modules/credits/credit.math"
import { createCreditReceiptInTx } from "@/modules/credits/credit-receipt.service"
import type {
  PaymentsQuery,
  RegisterPaymentInput,
} from "@/modules/credits/credit.schemas"
import {
  allocateFifoInTx,
  lockPlayerInTx,
  outstandingOf,
  receivablesOf,
  reversePaymentAllocationsInTx,
} from "@/modules/credits/receivable.service"
import { lockOpenSession } from "@/modules/session-tables/session-table.service"
import { issueFolio } from "@/modules/settings/folio.service"

/**
 * Abonos a deudas (Módulo 10). Un abono general se aplica por FIFO.
 *
 *  - SESSION: solo con una sesión OPEN (la elige el servidor, nunca el
 *    cliente). El efectivo entra a la caja central de ESA sesión.
 *  - ADMINISTRATIVE: fuera de sesión (o por decisión del operador). Nunca
 *    toca una caja de sesión: el efectivo queda en CUSTODIA ADMINISTRATIVA
 *    del usuario que lo recibió; transferencia y terminal van al banco/por
 *    liquidar como siempre.
 *  - Transferencia: PENDIENTE hasta que alguien la verifique en caja
 *    (Módulo 05); no reduce deuda mientras tanto. Al verificarse se aplica
 *    lo aplicable y el excedente queda como fondos NO aplicados (por
 *    devolver), nunca como saldo a favor.
 *  - Terminal: solo APROBADO reduce deuda; va a "por liquidar", no a efectivo.
 *  - No se aceptan abonos mayores a la deuda (DEC-07) ni saldos a favor.
 *  Orden de bloqueos: sesión (FOR SHARE) → jugador → saldos financieros.
 */

type Tx = Prisma.TransactionClient
const TX = { maxWait: 15_000, timeout: 30_000 } as const
const dec = (v: Prisma.Decimal | string) => new Prisma.Decimal(v)
const fmt = (v: Prisma.Decimal) => v.toFixed(2)
const user = { select: { id: true, name: true } } as const

const METHOD_LABEL = {
  CASH: "efectivo",
  BANK_TRANSFER: "transferencia",
  CARD_DEBIT: "tarjeta de débito",
  CARD_CREDIT: "tarjeta de crédito",
} as const

export async function openSessionForPayments() {
  return prisma.pokerSession.findFirst({
    where: { status: "OPEN" },
    select: { id: true, folio: true },
  })
}

/** Vista previa FIFO (informativa; el servidor recalcula al confirmar). */
export async function fifoPreview(playerId: string, amount: string) {
  const receivables = await receivablesOf(prisma, playerId)
  const outstanding = receivables.reduce(
    (acc, r) => acc.add(r.balance),
    new Prisma.Decimal(0)
  )
  try {
    const allocations = allocateFifo(receivables, dec(amount))
    const debts = await prisma.playerDebt.findMany({
      where: { id: { in: allocations.map((a) => a.receivableId) } },
      select: {
        id: true,
        createdAt: true,
        purchase: {
          select: { folio: true, table: { select: { name: true } } },
        },
        session: { select: { folio: true } },
      },
    })
    return {
      valid: true as const,
      outstanding: fmt(outstanding),
      remaining: fmt(outstanding.sub(dec(amount))),
      allocations: allocations.map((a) => {
        const d = debts.find((x) => x.id === a.receivableId)!
        return {
          receivableId: a.receivableId,
          order: a.order,
          purchaseFolio: d.purchase.folio,
          tableName: d.purchase.table.name,
          sessionFolio: d.session.folio,
          createdAt: d.createdAt.toISOString(),
          amount: fmt(a.amount),
          balanceBefore: fmt(a.balanceBefore),
          balanceAfter: fmt(a.balanceAfter),
        }
      }),
    }
  } catch (e) {
    return {
      valid: false as const,
      outstanding: fmt(outstanding),
      message: e instanceof Error ? e.message : "Importe inválido",
      allocations: [],
    }
  }
}

// ── Registrar ─────────────────────────────────────────────────────────

export async function registerPayment(
  actor: SessionUser,
  input: RegisterPaymentInput,
  ctx: RequestContext = {}
) {
  const amount = dec(input.amount)
  const replay = async () => {
    const r = await prisma.receivablePayment.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true, playerId: true, amount: true, method: true },
    })
    if (
      r &&
      (r.playerId !== input.playerId ||
        !dec(r.amount).equals(amount) ||
        r.method !== input.method)
    )
      throw new AppError(
        "CONFLICT",
        "Esta clave de operación ya se usó para otro abono"
      )
    return r
  }
  const previous = await replay()
  if (previous) return { paymentId: previous.id, replayed: true }

  let session: { id: string; folio: string } | null = null
  if (input.origin === "SESSION") {
    session = await openSessionForPayments()
    if (!session)
      throw new BusinessRuleError(
        "No hay una sesión abierta: registra el abono como administrativo."
      )
  }
  try {
    return await prisma.$transaction(async (tx) => {
      if (session)
        await lockOpenSession(
          tx,
          session.id,
          "La sesión se cerró: registra el abono como administrativo."
        )
      const player = await lockPlayerInTx(tx, input.playerId)
      const again = await tx.receivablePayment.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true },
      })
      if (again) return { paymentId: again.id, replayed: true }
      const outstanding = await outstandingOf(tx, input.playerId)
      if (amount.greaterThan(outstanding))
        throw new BusinessRuleError(new ExcessPaymentError(outstanding).message)
      const method = await tx.paymentMethod.findUnique({
        where: { code: input.method },
        select: { isActive: true },
      })
      if (!method?.isActive)
        throw new BusinessRuleError(
          "Ese método de pago no está activo en la configuración."
        )

      const id = randomUUID()
      const folio = await issueFolio(tx, "DEBT_PAYMENT")
      const now = new Date()
      const common = {
        id,
        folio,
        playerId: input.playerId,
        amount,
        method: input.method,
        origin: input.origin,
        sessionId: session?.id ?? null,
        notes: input.notes ?? null,
        createdById: actor.id,
        createdAt: now,
        idempotencyKey: input.idempotencyKey,
      }
      const auditBase = {
        folio,
        playerId: input.playerId,
        amount: fmt(amount),
        method: input.method,
        origin: input.origin,
        sessionId: session?.id ?? null,
      }

      // Transferencia: pendiente (no reduce deuda ni aumenta banco).
      if (input.method === "BANK_TRANSFER") {
        const pending = await registerPendingBankTransferInTx(
          tx,
          actor,
          {
            declaredAmount: amount,
            creditAccountKind: "PLAYER_DEBT_PAYMENTS",
            referenceType: "ReceivablePayment",
            referenceId: id,
            sessionId: session?.id ?? null,
            playerId: input.playerId,
            bankReference: input.bankReference ?? null,
            senderName: input.senderName ?? null,
            idempotencyKey: `credit-transfer-${input.idempotencyKey}`,
          },
          ctx
        )
        await tx.receivablePayment.create({
          data: {
            ...common,
            status: "PENDING",
            bankTransferId: pending.id,
            externalReference: input.bankReference ?? null,
          },
        })
        await recordAudit(
          {
            action: AUDIT_ACTIONS.PAYMENT_REGISTERED,
            entityType: "ReceivablePayment",
            entityId: id,
            actorUserId: actor.id,
            requestId: ctx.requestId,
            metadata: {
              ...auditBase,
              status: "PENDING",
              bankTransferId: pending.id,
            },
          },
          tx
        )
        return { paymentId: id, replayed: false }
      }

      // Terminal rechazada: queda registrada, sin efecto.
      if (input.method !== "CASH" && input.result === "DECLINED") {
        await tx.receivablePayment.create({
          data: {
            ...common,
            status: "REJECTED",
            rejectedAt: now,
            terminalReference: input.terminalReference ?? null,
            terminalIdentifier: input.terminalIdentifier ?? null,
          },
        })
        await recordAudit(
          {
            action: AUDIT_ACTIONS.PAYMENT_REJECTED,
            entityType: "ReceivablePayment",
            entityId: id,
            actorUserId: actor.id,
            requestId: ctx.requestId,
            result: "FAILURE",
            metadata: { ...auditBase, reason: "Terminal: rechazado" },
          },
          tx
        )
        return { paymentId: id, replayed: false }
      }

      // Efectivo o terminal aprobada: dinero real ahora.
      const custodian =
        input.method === "CASH" && input.origin === "ADMINISTRATIVE"
      const debit: LedgerEntry =
        input.method === "CASH"
          ? custodian
            ? {
                account: "ADMIN_CASH_CUSTODY",
                direction: "DEBIT",
                amount,
                scopeKey: custodianScope(actor.id),
              }
            : {
                account: "CASH_ON_HAND",
                direction: "DEBIT",
                amount,
                scopeKey: session!.id,
              }
          : {
              account: "CARD_TERMINAL_CLEARING",
              direction: "DEBIT",
              amount,
              scopeKey: GLOBAL_SCOPE,
            }
      const posted = await postTransactionInTx(
        tx,
        {
          type: "DEBT_PAYMENT",
          sessionId: session?.id ?? null,
          playerId: input.playerId,
          referenceType: "ReceivablePayment",
          referenceId: id,
          reason: `Abono ${folio} en ${METHOD_LABEL[input.method]}${custodian ? " (custodia administrativa)" : ""} de ${player.name}`,
          notes:
            input.method === "CASH"
              ? null
              : `Ref. terminal: ${input.terminalReference}`,
          idempotencyKey: `credit-payment-${id}`,
          requestHash: `credit-payment-${id}-${fmt(amount)}`,
          actorId: actor.id,
          audit: {
            action: AUDIT_ACTIONS.CASH_PLAYER_PAYMENT_RECORDED,
            metadata: { receivablePaymentId: id, folio },
          },
        },
        [
          debit,
          {
            account: "PLAYER_DEBT_PAYMENTS",
            direction: "CREDIT",
            amount,
            scopeKey: GLOBAL_SCOPE,
          },
        ],
        ctx
      )
      await tx.receivablePayment.create({
        data: {
          ...common,
          status: "CONFIRMED",
          financialTransactionId: posted.transactionId,
          confirmedById: actor.id,
          confirmedAt: now,
          custodianUserId: custodian ? actor.id : null,
          terminalReference:
            input.method === "CASH" ? null : (input.terminalReference ?? null),
          terminalIdentifier:
            input.method === "CASH" ? null : (input.terminalIdentifier ?? null),
        },
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.PAYMENT_REGISTERED,
          entityType: "ReceivablePayment",
          entityId: id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: { ...auditBase, status: "CONFIRMED" },
        },
        tx
      )
      if (custodian)
        await recordAudit(
          {
            action: AUDIT_ACTIONS.ADMINISTRATIVE_CASH_RECEIVED,
            entityType: "ReceivablePayment",
            entityId: id,
            actorUserId: actor.id,
            requestId: ctx.requestId,
            metadata: { ...auditBase, custodianUserId: actor.id },
          },
          tx
        )
      if (input.method !== "CASH")
        await recordAudit(
          {
            action: AUDIT_ACTIONS.TERMINAL_PAYMENT_APPROVED,
            entityType: "ReceivablePayment",
            entityId: id,
            actorUserId: actor.id,
            requestId: ctx.requestId,
            metadata: {
              ...auditBase,
              terminalReference: input.terminalReference,
            },
          },
          tx
        )
      await allocateFifoInTx(
        tx,
        actor.id,
        {
          playerId: input.playerId,
          amount,
          source: "RECEIVABLE_PAYMENT",
          receivablePaymentId: id,
        },
        ctx
      )
      await confirmAudit(tx, actor.id, id, auditBase, ctx)
      await createCreditReceiptInTx(tx, actor, id, ctx)
      return { paymentId: id, replayed: false }
    }, TX)
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await replay()
      if (again) return { paymentId: again.id, replayed: true }
    }
    throw error
  }
}

async function confirmAudit(
  tx: Tx,
  actorId: string,
  id: string,
  meta: Record<string, unknown>,
  ctx: RequestContext
) {
  await recordAudit(
    {
      action: AUDIT_ACTIONS.PAYMENT_CONFIRMED,
      entityType: "ReceivablePayment",
      entityId: id,
      actorUserId: actorId,
      requestId: ctx.requestId,
      metadata: { ...meta, from: "PENDING", to: "CONFIRMED" },
    },
    tx
  )
}

// ── Integración con la verificación de transferencias (Módulo 05) ────

/** Bloquea al jugador del abono ANTES que la transferencia. */
export async function lockReceivablePaymentForTransferInTx(
  tx: Tx,
  paymentId: string
) {
  const p = await tx.receivablePayment.findUnique({
    where: { id: paymentId },
    select: { playerId: true },
  })
  if (p) await lockPlayerInTx(tx, p.playerId)
}

/** Antes de contabilizar: cuánto del importe confirmado NO puede aplicarse. */
export async function planReceivableTransferInTx(
  tx: Tx,
  paymentId: string,
  confirmedAmount: Prisma.Decimal
) {
  const p = await tx.receivablePayment.findUniqueOrThrow({
    where: { id: paymentId },
    select: { playerId: true, status: true },
  })
  if (p.status !== "PENDING")
    throw new ConflictError("El abono ya no está pendiente")
  const outstanding = await outstandingOf(tx, p.playerId)
  return splitApplicable(confirmedAmount, outstanding)
}

/** Después de contabilizar: FIFO, excedente sin aplicar, CONFIRMED y comprobante. */
export async function finalizeReceivableTransferInTx(
  tx: Tx,
  actorId: string,
  input: {
    paymentId: string
    bankTransferId: string
    transactionId: string
    applicable: Prisma.Decimal
    excess: Prisma.Decimal
  },
  ctx: RequestContext = {}
) {
  const p = await tx.receivablePayment.findUniqueOrThrow({
    where: { id: input.paymentId },
    select: {
      id: true,
      folio: true,
      playerId: true,
      amount: true,
      method: true,
      origin: true,
      sessionId: true,
    },
  })
  const now = new Date()
  const { count } = await tx.receivablePayment.updateMany({
    where: { id: p.id, status: "PENDING" },
    data: {
      status: "CONFIRMED",
      confirmedAt: now,
      confirmedById: actorId,
      financialTransactionId: input.transactionId,
    },
  })
  if (count !== 1) throw new ConflictError("El abono cambió de estado")
  if (input.applicable.greaterThan(0))
    await allocateFifoInTx(
      tx,
      actorId,
      {
        playerId: p.playerId,
        amount: input.applicable,
        source: "RECEIVABLE_PAYMENT",
        receivablePaymentId: p.id,
      },
      ctx
    )
  if (input.excess.greaterThan(0)) {
    await tx.unappliedPlayerFunds.create({
      data: {
        playerId: p.playerId,
        amount: input.excess,
        reason:
          "Transferencia verificada que excede la deuda pendiente al confirmarse",
        bankTransferId: input.bankTransferId,
        receivablePaymentId: p.id,
        createdById: actorId,
      },
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.UNAPPLIED_FUNDS_RECORDED,
        entityType: "ReceivablePayment",
        entityId: p.id,
        actorUserId: actorId,
        requestId: ctx.requestId,
        metadata: {
          playerId: p.playerId,
          excess: fmt(input.excess),
          bankTransferId: input.bankTransferId,
        },
      },
      tx
    )
  }
  await confirmAudit(
    tx,
    actorId,
    p.id,
    {
      folio: p.folio,
      playerId: p.playerId,
      amount: fmt(dec(p.amount)),
      applied: fmt(input.applicable),
      excess: fmt(input.excess),
      method: p.method,
      origin: p.origin,
    },
    ctx
  )
  await createCreditReceiptInTx(tx, { id: actorId }, p.id, ctx)
}

export async function rejectReceivableTransferInTx(
  tx: Tx,
  actorId: string,
  paymentId: string,
  ctx: RequestContext = {}
) {
  const { count } = await tx.receivablePayment.updateMany({
    where: { id: paymentId, status: "PENDING" },
    data: { status: "REJECTED", rejectedAt: new Date() },
  })
  if (count === 1)
    await recordAudit(
      {
        action: AUDIT_ACTIONS.PAYMENT_REJECTED,
        entityType: "ReceivablePayment",
        entityId: paymentId,
        actorUserId: actorId,
        requestId: ctx.requestId,
        metadata: {
          from: "PENDING",
          to: "REJECTED",
          reason: "Transferencia rechazada en el banco",
        },
      },
      tx
    )
}

// ── Reverso ───────────────────────────────────────────────────────────

/**
 * Reverso auditado de un abono confirmado: contraasiento del dinero real
 * (el operador declara que lo devolvió) y contraasientos de TODAS sus
 * aplicaciones. Las aplicaciones posteriores de otros abonos no se tocan
 * (política determinista: no se re-ejecuta FIFO). El abono, sus
 * aplicaciones y su comprobante se conservan (el comprobante queda ANULADO).
 *
 * Restricciones: efectivo de sesión solo con ESA sesión aún abierta;
 * efectivo administrativo solo si el custodio lo conserva; terminal solo
 * si aún no se liquidó; transferencia: requiere una devolución bancaria
 * real (no disponible en este módulo).
 */
export async function reversePayment(
  actor: SessionUser,
  paymentId: string,
  input: { reason: string; idempotencyKey: string },
  ctx: RequestContext = {}
) {
  const head = await prisma.receivablePayment.findUnique({
    where: { id: paymentId },
    select: { sessionId: true },
  })
  if (!head) throw new NotFoundError("Abono no encontrado")
  const previous = await prisma.receivablePaymentReversal.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { paymentId: true },
  })
  if (previous) {
    if (previous.paymentId !== paymentId)
      throw new AppError("CONFLICT", "Clave de operación reutilizada")
    return { replayed: true }
  }
  try {
    await prisma.$transaction(async (tx) => {
      if (head.sessionId)
        await lockOpenSession(
          tx,
          head.sessionId,
          "La sesión de este abono ya cerró: su caja no se modifica. Registra la devolución por otro medio auditado."
        )
      const p0 = await tx.receivablePayment.findUniqueOrThrow({
        where: { id: paymentId },
        select: { playerId: true },
      })
      await lockPlayerInTx(tx, p0.playerId)
      const p = await tx.receivablePayment.findUniqueOrThrow({
        where: { id: paymentId },
        select: {
          id: true,
          folio: true,
          status: true,
          method: true,
          origin: true,
          amount: true,
          playerId: true,
          sessionId: true,
          custodianUserId: true,
          cardSettlementId: true,
          financialTransaction: {
            select: {
              id: true,
              folio: true,
              entries: {
                select: {
                  direction: true,
                  amount: true,
                  scopeKey: true,
                  account: { select: { kind: true } },
                },
              },
            },
          },
          unappliedFunds: { select: { id: true } },
        },
      })
      if (p.status === "REVERSED")
        throw new ConflictError("Este abono ya fue revertido.")
      if (p.status !== "CONFIRMED")
        throw new BusinessRuleError("Solo se revierten abonos confirmados.")
      if (p.method === "BANK_TRANSFER" || p.unappliedFunds.length)
        throw new BusinessRuleError(
          "Un abono por transferencia requiere una devolución bancaria real; no se revierte desde aquí."
        )
      if (p.cardSettlementId)
        throw new BusinessRuleError(
          "El cobro con terminal ya se liquidó en el banco: requiere un contracargo o devolución real."
        )
      const original = p.financialTransaction!
      const posted = await postTransactionInTx(
        tx,
        {
          type: "REVERSAL",
          sessionId: p.sessionId,
          playerId: p.playerId,
          referenceType: "CashTransaction",
          referenceId: original.id,
          reason: `Reverso del abono ${p.folio}: ${input.reason}`,
          reversesTransactionId: original.id,
          idempotencyKey: `credit-reversal-${p.id}`,
          requestHash: `credit-reversal-${p.id}`,
          actorId: actor.id,
          audit: {
            action: AUDIT_ACTIONS.CASH_MOVEMENT_REVERSED,
            metadata: {
              originalFolio: original.folio,
              receivablePaymentId: p.id,
            },
          },
        },
        original.entries.map((e) => ({
          account: e.account.kind as LedgerEntry["account"],
          direction:
            e.direction === "DEBIT" ? ("CREDIT" as const) : ("DEBIT" as const),
          amount: dec(e.amount),
          scopeKey: e.scopeKey,
        })),
        ctx
      )
      const reversed = await reversePaymentAllocationsInTx(tx, actor.id, p.id)
      const { count } = await tx.receivablePayment.updateMany({
        where: { id: p.id, status: "CONFIRMED" },
        data: { status: "REVERSED", reversedAt: new Date() },
      })
      if (count !== 1) throw new ConflictError("El abono cambió de estado")
      await tx.receivablePaymentReversal.create({
        data: {
          paymentId: p.id,
          reason: input.reason,
          transactionId: posted.transactionId,
          createdById: actor.id,
          idempotencyKey: input.idempotencyKey,
        },
      })
      await tx.receivablePaymentReceipt.updateMany({
        where: { paymentId: p.id, status: "AVAILABLE" },
        data: {
          status: "VOIDED",
          voidedAt: new Date(),
          voidReason: `Abono revertido: ${input.reason}`,
        },
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.PAYMENT_REVERSED,
          entityType: "ReceivablePayment",
          entityId: p.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            folio: p.folio,
            playerId: p.playerId,
            amount: fmt(dec(p.amount)),
            method: p.method,
            origin: p.origin,
            reason: input.reason,
            from: "CONFIRMED",
            to: "REVERSED",
            restored: reversed.map((r) => ({
              receivableId: r.receivableId,
              amount: fmt(r.amount),
            })),
          },
        },
        tx
      )
    }, TX)
  } catch (error) {
    if (isUniqueViolation(error))
      throw new ConflictError("Este abono ya fue revertido.")
    throw error
  }
  return { replayed: false }
}

// ── Consultas ─────────────────────────────────────────────────────────

const paymentSelect = {
  id: true,
  folio: true,
  amount: true,
  method: true,
  origin: true,
  status: true,
  createdAt: true,
  confirmedAt: true,
  rejectedAt: true,
  reversedAt: true,
  externalReference: true,
  terminalReference: true,
  notes: true,
  cardSettlementId: true,
  player: { select: { id: true, name: true, nickname: true } },
  session: { select: { id: true, folio: true, status: true } },
  createdBy: user,
  confirmedBy: user,
  custodian: user,
  financialTransaction: { select: { id: true, folio: true } },
  bankTransfer: {
    select: {
      id: true,
      status: true,
      confirmedAmount: true,
      bankReference: true,
    },
  },
  unappliedFunds: { select: { amount: true } },
  reversal: { select: { reason: true, createdAt: true, createdBy: user } },
  receipt: { select: { id: true, status: true } },
  allocations: {
    orderBy: [{ allocatedAt: "asc" }, { allocationOrder: "asc" }],
    select: {
      id: true,
      kind: true,
      amount: true,
      allocationOrder: true,
      allocatedAt: true,
      receivable: {
        select: {
          id: true,
          createdAt: true,
          purchase: {
            select: { folio: true, table: { select: { name: true } } },
          },
          session: { select: { folio: true } },
        },
      },
    },
  },
} satisfies Prisma.ReceivablePaymentSelect

type PaymentRecord = Prisma.ReceivablePaymentGetPayload<{
  select: typeof paymentSelect
}>

function paymentView(p: PaymentRecord) {
  return {
    ...p,
    amount: fmt(dec(p.amount)),
    applied: fmt(
      p.allocations.reduce(
        (acc, a) =>
          a.kind === "APPLICATION" ? acc.add(a.amount) : acc.sub(a.amount),
        new Prisma.Decimal(0)
      )
    ),
    unapplied: fmt(
      p.unappliedFunds.reduce(
        (acc, u) => acc.add(u.amount),
        new Prisma.Decimal(0)
      )
    ),
    createdAt: p.createdAt.toISOString(),
    confirmedAt: p.confirmedAt?.toISOString() ?? null,
    rejectedAt: p.rejectedAt?.toISOString() ?? null,
    reversedAt: p.reversedAt?.toISOString() ?? null,
    bankTransfer: p.bankTransfer
      ? {
          ...p.bankTransfer,
          confirmedAmount: p.bankTransfer.confirmedAmount
            ? fmt(dec(p.bankTransfer.confirmedAmount))
            : null,
        }
      : null,
    reversal: p.reversal
      ? { ...p.reversal, createdAt: p.reversal.createdAt.toISOString() }
      : null,
    allocations: p.allocations.map((a) => ({
      ...a,
      amount: fmt(dec(a.amount)),
      allocatedAt: a.allocatedAt.toISOString(),
      receivable: {
        ...a.receivable,
        createdAt: a.receivable.createdAt.toISOString(),
      },
    })),
    unappliedFunds: undefined,
  }
}
export type ReceivablePaymentView = ReturnType<typeof paymentView>

export async function getPayment(id: string) {
  const p = await prisma.receivablePayment.findUnique({
    where: { id },
    select: paymentSelect,
  })
  if (!p) throw new NotFoundError("Abono no encontrado")
  return paymentView(p)
}

export async function listPayments(query: PaymentsQuery) {
  const where: Prisma.ReceivablePaymentWhereInput = {
    ...(query.playerId ? { playerId: query.playerId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.origin ? { origin: query.origin } : {}),
    ...(query.method ? { method: query.method } : {}),
  }
  const [total, rows] = await prisma.$transaction([
    prisma.receivablePayment.count({ where }),
    prisma.receivablePayment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: paymentSelect,
    }),
  ])
  return {
    items: rows.map(paymentView),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  }
}
