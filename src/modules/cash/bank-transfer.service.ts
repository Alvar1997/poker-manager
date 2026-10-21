import "server-only"

import { Prisma } from "@/generated/prisma/client"
import { AppError, BusinessRuleError, NotFoundError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import { maskLast4 } from "@/lib/clabe"
import { formatMoney, money } from "@/modules/cash/cash.math"
import type { ConfirmBankTransferInput } from "@/modules/cash/cash.schemas"
import {
  cashTx,
  GLOBAL_SCOPE,
  postTransactionInTx,
  type Tx,
} from "@/modules/cash/ledger"
import {
  currentSessionGateway,
  requireSessionStatus,
  type SessionGateway,
} from "@/modules/cash/session-gateway"

/**
 * Transferencias bancarias con verificación MANUAL (BAN-01…18).
 *
 * - Una transferencia PENDIENTE no es un cobro: no genera asiento.
 * - Confirmar (CASHIER, PARTNER o SUPERADMIN, sin aprobación adicional)
 *   exige declarar que se verificó el ingreso en el banco, registra quién
 *   y cuándo, el importe realmente confirmado, y crea el asiento UNA vez
 *   (bloqueo del renglón + transición condicional + UNIQUE de transactionId
 *   + UNIQUE del asiento por transferencia de origen).
 * - Rechazar no genera entrada; un depósito rechazado devuelve el efectivo.
 * - Duplicados: una referencia bancaria no es única por sí sola; si ya hay
 *   otra confirmada con misma cuenta, referencia e importe, se exige
 *   reconocer el posible duplicado de forma explícita.
 * - Las transferencias de jugadores las CREAN los módulos de compras y
 *   abonos (registerPendingBankTransferInTx); este módulo no las inventa.
 */

type Deps = { sessions?: SessionGateway }

const transferSelect = {
  id: true,
  kind: true,
  status: true,
  declaredAmount: true,
  confirmedAmount: true,
  bankReference: true,
  senderName: true,
  creditAccountKind: true,
  sessionId: true,
  referenceType: true,
  referenceId: true,
  notes: true,
  rejectionReason: true,
  verificationNotes: true,
  createdAt: true,
  verifiedAt: true,
  transactionId: true,
  depositTransactionId: true,
  paymentAccount: {
    select: {
      name: true,
      bankName: true,
      clabeLast4: true,
      accountNumberLast4: true,
    },
  },
  table: { select: { id: true, name: true } },
  player: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  verifiedBy: { select: { id: true, name: true } },
  transaction: { select: { id: true, folio: true } },
} satisfies Prisma.BankTransferVerificationSelect

type TransferRecord = Prisma.BankTransferVerificationGetPayload<{
  select: typeof transferSelect
}>

function toView(t: TransferRecord) {
  return {
    ...t,
    declaredAmount: formatMoney(new Prisma.Decimal(t.declaredAmount)),
    confirmedAmount: t.confirmedAmount
      ? formatMoney(new Prisma.Decimal(t.confirmedAmount))
      : null,
    createdAt: t.createdAt.toISOString(),
    verifiedAt: t.verifiedAt?.toISOString() ?? null,
    paymentAccount: {
      name: t.paymentAccount.name,
      bankName: t.paymentAccount.bankName,
      masked: maskLast4(
        t.paymentAccount.clabeLast4 ?? t.paymentAccount.accountNumberLast4
      ),
    },
  }
}
export type BankTransferView = ReturnType<typeof toView>

export async function listBankTransfers(query: {
  status?: TransferRecord["status"]
  page: number
  pageSize: number
}) {
  const where: Prisma.BankTransferVerificationWhereInput = query.status
    ? { status: query.status }
    : {}
  const [total, rows] = await prisma.$transaction([
    prisma.bankTransferVerification.count({ where }),
    prisma.bankTransferVerification.findMany({
      where,
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: transferSelect,
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

export async function getBankTransfer(id: string) {
  const t = await prisma.bankTransferVerification.findUnique({
    where: { id },
    select: transferSelect,
  })
  if (!t) throw new NotFoundError("Transferencia no encontrada")
  return toView(t)
}

/**
 * CONTRATO (compras / abonos): registra un componente bancario PENDIENTE.
 * No genera asiento. Idempotente por clave; un solo componente vivo por
 * operación de origen (índice único parcial).
 */
export async function registerPendingBankTransferInTx(
  tx: Tx,
  actor: SessionUser,
  input: {
    declaredAmount: Prisma.Decimal
    creditAccountKind: "PLAYER_PURCHASES" | "PLAYER_DEBT_PAYMENTS"
    referenceType: string
    referenceId: string
    sessionId?: string | null
    tableId?: string | null
    playerId?: string | null
    bankReference?: string | null
    senderName?: string | null
    idempotencyKey: string
  },
  ctx: RequestContext = {}
): Promise<{ id: string; replayed: boolean }> {
  const existing = await tx.bankTransferVerification.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true },
  })
  if (existing) return { id: existing.id, replayed: true }
  const bank = await tx.paymentAccount.findFirst({
    where: { isPrimary: true, isActive: true },
    select: { id: true },
  })
  if (!bank)
    throw new BusinessRuleError("No hay cuenta bancaria principal configurada")
  const created = await tx.bankTransferVerification.create({
    data: {
      kind: "PLAYER_PAYMENT",
      paymentAccountId: bank.id,
      declaredAmount: money(input.declaredAmount),
      creditAccountKind: input.creditAccountKind,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      sessionId: input.sessionId ?? null,
      tableId: input.tableId ?? null,
      playerId: input.playerId ?? null,
      bankReference: input.bankReference ?? null,
      senderName: input.senderName ?? null,
      idempotencyKey: input.idempotencyKey,
      createdById: actor.id,
    },
    select: { id: true },
  })
  await recordAudit(
    {
      action: AUDIT_ACTIONS.BANK_TRANSFER_REGISTERED,
      entityType: "BankTransferVerification",
      entityId: created.id,
      actorUserId: actor.id,
      requestId: ctx.requestId,
      metadata: {
        declaredAmount: formatMoney(money(input.declaredAmount)),
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        status: "PENDING_VERIFICATION",
      },
    },
    tx
  )
  return { id: created.id, replayed: false }
}

/**
 * Integración con compras (Módulo 08) y abonos (Módulo 10): si la
 * transferencia paga un componente de compra o un abono, se bloquea
 * primero su dueño (compra → jugador, o jugador) y luego la transferencia.
 * Al confirmarla, `plan` calcula lo aplicable antes del asiento (el
 * excedente se acredita a «fondos no aplicados», nunca como saldo a favor)
 * y `finalize` aplica sobre la MISMA obligación (deuda de la compra) o por
 * FIFO (abono general). Import dinámico: evita ciclos caja ↔ compras/créditos.
 */
type TransferHook = {
  plan(
    tx: Tx,
    confirmed: Prisma.Decimal
  ): Promise<{ applicable: Prisma.Decimal; excess: Prisma.Decimal }>
  finalize(
    tx: Tx,
    actor: SessionUser,
    input: {
      confirmed: Prisma.Decimal
      applicable: Prisma.Decimal
      excess: Prisma.Decimal
      transactionId: string
      bankTransferId: string
    },
    ctx: RequestContext
  ): Promise<void>
  reject(tx: Tx, actor: SessionUser, ctx: RequestContext): Promise<void>
}

async function transferHookFor(
  tx: Tx,
  id: string
): Promise<TransferHook | null> {
  const ref = await tx.bankTransferVerification.findUnique({
    where: { id },
    select: { referenceType: true, referenceId: true },
  })
  if (ref?.referenceType === "PurchasePayment") {
    const hook = await import("@/modules/purchases/purchase-transfer-hook")
    await hook.lockPurchaseOfPaymentInTx(tx, ref.referenceId)
    return {
      plan: (tx2, confirmed) =>
        hook.planPurchaseTransferInTx(tx2, ref.referenceId, confirmed),
      finalize: (tx2, actor, input, ctx) =>
        hook.applyPurchaseTransferResolutionInTx(
          tx2,
          actor,
          {
            paymentId: ref.referenceId,
            outcome: "CONFIRMED",
            confirmedAmount: input.confirmed,
            applicable: input.applicable,
            excess: input.excess,
            bankTransferId: input.bankTransferId,
          },
          ctx
        ),
      reject: (tx2, actor, ctx) =>
        hook.applyPurchaseTransferResolutionInTx(
          tx2,
          actor,
          { paymentId: ref.referenceId, outcome: "REJECTED" },
          ctx
        ),
    }
  }
  if (ref?.referenceType === "ReceivablePayment") {
    const hook = await import("@/modules/credits/receivable-payment.service")
    await hook.lockReceivablePaymentForTransferInTx(tx, ref.referenceId)
    return {
      plan: (tx2, confirmed) =>
        hook.planReceivableTransferInTx(tx2, ref.referenceId, confirmed),
      finalize: (tx2, actor, input, ctx) =>
        hook.finalizeReceivableTransferInTx(
          tx2,
          actor.id,
          {
            paymentId: ref.referenceId,
            bankTransferId: input.bankTransferId,
            transactionId: input.transactionId,
            applicable: input.applicable,
            excess: input.excess,
          },
          ctx
        ),
      reject: (tx2, actor, ctx) =>
        hook.rejectReceivableTransferInTx(tx2, actor.id, ref.referenceId, ctx),
    }
  }
  return null
}

async function lockTransfer(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "bank_transfer_verifications" WHERE "id" = ${id} FOR UPDATE
  `
  if (rows.length === 0) throw new NotFoundError("Transferencia no encontrada")
  return tx.bankTransferVerification.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      kind: true,
      status: true,
      declaredAmount: true,
      bankReference: true,
      paymentAccountId: true,
      creditAccountKind: true,
      sessionId: true,
      tableId: true,
      playerId: true,
      referenceType: true,
      referenceId: true,
      depositTransactionId: true,
    },
  })
}

/** Confirmación manual. Idempotente: confirmar dos veces no contabiliza dos veces. */
export async function confirmBankTransfer(
  actor: SessionUser,
  id: string,
  input: ConfirmBankTransferInput,
  ctx: RequestContext = {}
) {
  await cashTx(async (tx) => {
    const hook = await transferHookFor(tx, id)
    const t = await lockTransfer(tx, id)
    if (t.status === "CONFIRMED") return // reintento: respuesta segura
    if (t.status !== "PENDING_VERIFICATION") {
      throw new BusinessRuleError(
        "Solo se confirman transferencias pendientes de verificación"
      )
    }
    const declared = new Prisma.Decimal(t.declaredAmount)
    const confirmed = input.confirmedAmount
      ? money(input.confirmedAmount)
      : declared
    if (!confirmed.equals(declared) && !input.notes) {
      throw new BusinessRuleError(
        "El importe confirmado difiere del declarado: explica la diferencia en las notas"
      )
    }
    if (t.kind === "CASH_DEPOSIT" && !confirmed.equals(declared)) {
      throw new BusinessRuleError(
        "Un depósito de efectivo se confirma por el importe trasladado; si el banco muestra otro importe, recházalo y registra el depósito real"
      )
    }
    const reference = input.bankReference ?? t.bankReference
    if (reference && !input.acknowledgePossibleDuplicate) {
      const duplicate = await tx.bankTransferVerification.findFirst({
        where: {
          id: { not: t.id },
          status: "CONFIRMED",
          paymentAccountId: t.paymentAccountId,
          bankReference: reference,
          confirmedAmount: confirmed,
        },
        select: { id: true },
      })
      if (duplicate) {
        throw new AppError(
          "CONFLICT",
          "Ya hay una transferencia confirmada con la misma referencia e importe en esta cuenta. Verifica que sean ingresos distintos y vuelve a confirmar reconociendo el posible duplicado.",
          { possibleDuplicateOf: duplicate.id }
        )
      }
    }
    // Compra o abono: cuánto se aplica; el excedente real no se oculta ni
    // se convierte en saldo a favor (va a «fondos no aplicados»).
    const plan = hook
      ? await hook.plan(tx, confirmed)
      : { applicable: confirmed, excess: new Prisma.Decimal(0) }

    const posted = await postTransactionInTx(
      tx,
      {
        type:
          t.kind === "CASH_DEPOSIT" ? "CASH_TRANSFER" : "BANK_TRANSFER_RECEIPT",
        sessionId: t.sessionId,
        tableId: t.tableId,
        playerId: t.playerId,
        referenceType: "BankTransferVerification",
        referenceId: t.id,
        reason:
          t.kind === "CASH_DEPOSIT"
            ? "Depósito de efectivo verificado en el banco"
            : "Transferencia verificada en el banco",
        notes: input.notes,
        idempotencyKey: `bank-confirm-${t.id}`,
        requestHash: `bank-confirm-${t.id}`,
        actorId: actor.id,
        audit: {
          action: AUDIT_ACTIONS.BANK_TRANSFER_CONFIRMED,
          metadata: {
            bankTransferId: t.id,
            declaredAmount: formatMoney(declared),
            confirmedAmount: formatMoney(confirmed),
            bankReference: reference ?? null,
            acknowledgedDuplicate: Boolean(input.acknowledgePossibleDuplicate),
          },
        },
      },
      [
        {
          account: "BANK",
          direction: "DEBIT",
          amount: confirmed,
          scopeKey: GLOBAL_SCOPE,
        },
        ...(plan.applicable.greaterThan(0)
          ? [
              {
                account: t.creditAccountKind as "PLAYER_PURCHASES",
                direction: "CREDIT" as const,
                amount: plan.applicable,
                scopeKey: GLOBAL_SCOPE,
              },
            ]
          : []),
        ...(plan.excess.greaterThan(0)
          ? [
              {
                account: "UNAPPLIED_PLAYER_FUNDS" as const,
                direction: "CREDIT" as const,
                amount: plan.excess,
                scopeKey: GLOBAL_SCOPE,
              },
            ]
          : []),
      ],
      ctx
    )
    if (hook)
      await hook.finalize(
        tx,
        actor,
        {
          confirmed,
          applicable: plan.applicable,
          excess: plan.excess,
          transactionId: posted.transactionId,
          bankTransferId: t.id,
        },
        ctx
      )
    const { count } = await tx.bankTransferVerification.updateMany({
      where: { id: t.id, status: "PENDING_VERIFICATION" },
      data: {
        status: "CONFIRMED",
        confirmedAmount: confirmed,
        bankReference: reference ?? null,
        verificationNotes: input.notes ?? null,
        verifiedById: actor.id,
        verifiedAt: new Date(),
        transactionId: posted.transactionId,
      },
    })
    if (count !== 1)
      throw new AppError("CONFLICT", "La transferencia cambió de estado")
  })
  return getBankTransfer(id)
}

/** Rechazo: no genera entrada. Un depósito rechazado devuelve el efectivo a la caja. */
export async function rejectBankTransfer(
  actor: SessionUser,
  id: string,
  input: { reason: string },
  ctx: RequestContext = {},
  deps: Deps = {}
) {
  await cashTx(async (tx) => {
    const hook = await transferHookFor(tx, id)
    const t = await lockTransfer(tx, id)
    if (t.status === "REJECTED") return
    if (hook && t.status === "PENDING_VERIFICATION")
      await hook.reject(tx, actor, ctx)
    if (t.status !== "PENDING_VERIFICATION") {
      throw new BusinessRuleError(
        "Solo se rechazan transferencias pendientes de verificación"
      )
    }
    if (t.kind === "CASH_DEPOSIT" && t.depositTransactionId) {
      if (!t.sessionId)
        throw new BusinessRuleError("Depósito sin sesión de origen")
      await requireSessionStatus(
        deps.sessions ?? currentSessionGateway(),
        t.sessionId,
        ["OPEN"]
      )
      const original = await tx.cashTransaction.findUniqueOrThrow({
        where: { id: t.depositTransactionId },
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
      })
      await postTransactionInTx(
        tx,
        {
          type: "REVERSAL",
          sessionId: t.sessionId,
          referenceType: "CashTransaction",
          referenceId: original.id,
          reason: `Depósito no acreditado: ${input.reason}`,
          reversesTransactionId: original.id,
          idempotencyKey: `deposit-reject-${t.id}`,
          requestHash: `deposit-reject-${t.id}`,
          actorId: actor.id,
          audit: {
            action: AUDIT_ACTIONS.CASH_MOVEMENT_REVERSED,
            metadata: { originalFolio: original.folio, bankTransferId: t.id },
          },
        },
        original.entries.map((e) => ({
          account: e.account.kind as "CASH_ON_HAND",
          direction:
            e.direction === "DEBIT" ? ("CREDIT" as const) : ("DEBIT" as const),
          amount: new Prisma.Decimal(e.amount),
          scopeKey: e.scopeKey,
        })),
        ctx
      )
    }
    const { count } = await tx.bankTransferVerification.updateMany({
      where: { id: t.id, status: "PENDING_VERIFICATION" },
      data: {
        status: "REJECTED",
        rejectionReason: input.reason,
        verifiedById: actor.id,
        verifiedAt: new Date(),
      },
    })
    if (count !== 1)
      throw new AppError("CONFLICT", "La transferencia cambió de estado")
    await recordAudit(
      {
        action: AUDIT_ACTIONS.BANK_TRANSFER_REJECTED,
        entityType: "BankTransferVerification",
        entityId: t.id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          reason: input.reason,
          declaredAmount: formatMoney(new Prisma.Decimal(t.declaredAmount)),
          kind: t.kind,
        },
      },
      tx
    )
  })
  return getBankTransfer(id)
}

/** CONTRATO: cancela un componente pendiente cuando su operación de origen se cancela. */
export async function cancelPendingBankTransferInTx(
  tx: Tx,
  actor: SessionUser,
  id: string,
  ctx: RequestContext = {}
) {
  const t = await lockTransfer(tx, id)
  if (t.status === "CANCELLED") return
  if (t.status !== "PENDING_VERIFICATION")
    throw new BusinessRuleError("Solo se cancelan transferencias pendientes")
  await tx.bankTransferVerification.update({
    where: { id },
    data: {
      status: "CANCELLED",
      verifiedById: actor.id,
      verifiedAt: new Date(),
    },
  })
  await recordAudit(
    {
      action: AUDIT_ACTIONS.BANK_TRANSFER_CANCELLED,
      entityType: "BankTransferVerification",
      entityId: id,
      actorUserId: actor.id,
      requestId: ctx.requestId,
    },
    tx
  )
}
