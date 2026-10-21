import "server-only"

import { Prisma } from "@/generated/prisma/client"
import { AppError, BusinessRuleError, NotFoundError } from "@/lib/errors"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import { requestHash } from "@/modules/inventory/inventory.math"
import {
  formatMoney,
  looksLikeOperatingExpense,
  money,
  signedAmount,
  ZERO,
} from "@/modules/cash/cash.math"
import type {
  CashDepositInput,
  CashMovementsQuery,
  ContributionInput,
  ReverseInput,
  WithdrawalInput,
} from "@/modules/cash/cash.schemas"
import {
  cashBalanceOf,
  cashTx,
  GLOBAL_SCOPE,
  lockCashBalance,
  postTransactionInTx,
  replayByKey,
  type LedgerEntry,
  type Tx,
} from "@/modules/cash/ledger"
import {
  currentSessionGateway,
  requireSessionStatus,
  type SessionGateway,
} from "@/modules/cash/session-gateway"

/**
 * Operaciones administrativas de la caja (aportaciones, retiros, depósito
 * al banco, reversos) y consultas. Todas las de efectivo exigen una sesión
 * en el estado correcto vía SessionGateway: sin sesión (Módulo 06 aún no
 * existe) NO se registra dinero. No existe ninguna operación de gasto.
 */

export type Deps = { sessions?: SessionGateway }
const gateway = (deps: Deps) => deps.sessions ?? currentSessionGateway()

export type MovementResult = { id: string; folio: string; replayed: boolean }

async function run(
  key: string,
  hash: string,
  work: (tx: Tx) => Promise<{ transactionId: string; replayed: boolean }>
): Promise<MovementResult> {
  try {
    const result = await cashTx(work)
    const t = await prisma.cashTransaction.findUniqueOrThrow({
      where: { id: result.transactionId },
      select: { id: true, folio: true },
    })
    return { ...t, replayed: result.replayed }
  } catch (error) {
    if (isUniqueViolation(error)) {
      const replay = await replayByKey(key, hash)
      if (replay) {
        const t = await prisma.cashTransaction.findUniqueOrThrow({
          where: { id: replay },
          select: { id: true, folio: true },
        })
        return { ...t, replayed: true }
      }
    }
    throw error
  }
}

function assertNoExpense(...texts: (string | null | undefined)[]) {
  for (const text of texts) {
    if (text && looksLikeOperatingExpense(text)) {
      throw new BusinessRuleError(
        "La caja no registra gastos operativos (comida, bebidas, insumos, servicios, transporte…). Solo se permiten retiros, traslados y pagos financieros legítimos."
      )
    }
  }
}

// ── Aportaciones (APO) ────────────────────────────────────────────────

/** Dinero real entregado a la caja. No es compra, ingreso, ganancia ni deuda. */
export async function registerContribution(
  actor: SessionUser,
  input: ContributionInput,
  ctx: RequestContext = {},
  deps: Deps = {}
): Promise<MovementResult> {
  await requireSessionStatus(gateway(deps), input.sessionId, ["OPEN"])
  const amount = money(input.amount)
  const hash = requestHash(input)
  return run(input.idempotencyKey, hash, (tx) =>
    postTransactionInTx(
      tx,
      {
        type: "CASH_CONTRIBUTION",
        sessionId: input.sessionId,
        reason: input.reason,
        notes: input.notes,
        counterpartyName: input.contributorName,
        referenceType: input.reference ? "EXTERNAL_REFERENCE" : null,
        referenceId: input.reference ?? null,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
        actorId: actor.id,
        audit: {
          action: AUDIT_ACTIONS.CASH_CONTRIBUTION_CREATED,
          metadata: {
            amount: formatMoney(amount),
            contributor: input.contributorName,
          },
        },
      },
      [
        {
          account: "CASH_ON_HAND",
          direction: "DEBIT",
          amount,
          scopeKey: input.sessionId,
        },
        {
          account: "OWNER_CONTRIBUTIONS",
          direction: "CREDIT",
          amount,
          scopeKey: GLOBAL_SCOPE,
        },
      ],
      ctx
    )
  )
}

// ── Retiros (RET) ─────────────────────────────────────────────────────

/** Retiro ordinario: nunca mayor al efectivo disponible; no es gasto ni ganancia. */
export async function registerWithdrawal(
  actor: SessionUser,
  input: WithdrawalInput,
  ctx: RequestContext = {},
  deps: Deps = {}
): Promise<MovementResult> {
  await requireSessionStatus(gateway(deps), input.sessionId, ["OPEN"])
  assertNoExpense(input.reason, input.notes)
  const amount = money(input.amount)
  const hash = requestHash(input)
  return run(input.idempotencyKey, hash, (tx) =>
    postTransactionInTx(
      tx,
      {
        type: "CASH_WITHDRAWAL",
        sessionId: input.sessionId,
        reason: input.reason,
        notes: input.notes,
        counterpartyName: input.recipientName,
        withdrawalDestination: input.destination,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
        actorId: actor.id,
        audit: {
          action: AUDIT_ACTIONS.CASH_WITHDRAWAL_CREATED,
          metadata: {
            amount: formatMoney(amount),
            destination: input.destination,
            recipient: input.recipientName,
          },
        },
      },
      [
        {
          account: "CASH_WITHDRAWALS",
          direction: "DEBIT",
          amount,
          scopeKey: GLOBAL_SCOPE,
        },
        {
          account: "CASH_ON_HAND",
          direction: "CREDIT",
          amount,
          scopeKey: input.sessionId,
        },
      ],
      ctx
    )
  )
}

/**
 * CONTRATO para el cierre (Módulo 12): retira TODO el efectivo de la sesión
 * dejando la caja en $0. Exige un arqueo de cierre confirmado sin
 * diferencias pendientes, y que nada haya cambiado desde ese arqueo. Si se
 * indica `expectedAmount`, debe coincidir exactamente con el disponible
 * (nunca se retira más ni menos de lo que hay).
 */
export async function withdrawAllCashForClosingInTx(
  tx: Tx,
  actor: SessionUser,
  input: {
    sessionId: string
    recipientName: string
    idempotencyKey: string
    expectedAmount?: string
    notes?: string | null
    closureId?: string
  },
  ctx: RequestContext = {},
  deps: Deps = {}
): Promise<{
  transactionId: string | null
  amount: string
  replayed: boolean
  reconciliationId: string
}> {
  await requireSessionStatus(gateway(deps), input.sessionId, ["CLOSING"])
  const cash = await lockCashBalance(tx, input.sessionId)
  const closing = await tx.cashReconciliation.findFirst({
    where: {
      sessionId: input.sessionId,
      reconciliationType: "CLOSING",
      status: "CONFIRMED",
    },
    orderBy: { confirmedAt: "desc" },
    select: {
      id: true,
      differenceStatus: true,
      balanceVersion: true,
      adjustmentTransactionId: true,
    },
  })
  if (!closing)
    throw new BusinessRuleError(
      "Antes del retiro total se requiere el arqueo de cierre confirmado"
    )
  // Reintento con la misma clave: el retiro ya ocurrió (la caja ya está en
  // $0 y su versión avanzó): se devuelve el mismo asiento.
  const previous = await tx.cashTransaction.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, requestHash: true },
  })
  const hash = requestHash(input)
  if (previous) {
    if (previous.requestHash !== hash)
      throw new AppError(
        "CONFLICT",
        "Esta clave de operación ya se usó con datos distintos. Recarga e intenta de nuevo."
      )
    const entry = await tx.cashTransactionEntry.findFirstOrThrow({
      where: { transactionId: previous.id, scopeKey: input.sessionId },
      select: { amount: true },
    })
    return {
      transactionId: previous.id,
      amount: formatMoney(entry.amount),
      replayed: true,
      reconciliationId: closing.id,
    }
  }
  if (
    closing.differenceStatus === "PENDING" ||
    closing.differenceStatus === "SUPERSEDED"
  )
    throw new BusinessRuleError(
      "El arqueo de cierre tiene diferencias sin resolver"
    )
  const expectedVersion =
    closing.balanceVersion + (closing.adjustmentTransactionId ? 1 : 0)
  if (cash.version !== expectedVersion) {
    throw new BusinessRuleError(
      "El efectivo cambió después del arqueo de cierre: vuelve a contar"
    )
  }
  if (
    input.expectedAmount !== undefined &&
    !money(input.expectedAmount).equals(cash.balance)
  ) {
    throw new BusinessRuleError(
      `El importe a retirar ($${formatMoney(money(input.expectedAmount))}) no coincide con el efectivo disponible en la caja ($${formatMoney(cash.balance)}). El retiro final debe dejar la caja exactamente en $0.00.`,
      { available: formatMoney(cash.balance) }
    )
  }
  if (cash.balance.isZero())
    return {
      transactionId: null,
      amount: "0.00",
      replayed: false,
      reconciliationId: closing.id,
    }
  const result = await postTransactionInTx(
    tx,
    {
      type: "CASH_WITHDRAWAL",
      sessionId: input.sessionId,
      reason: "Retiro total del cierre de sesión",
      notes: input.notes ?? null,
      counterpartyName: input.recipientName,
      withdrawalDestination: "SESSION_CLOSING",
      referenceType: input.closureId ? "SessionClosure" : null,
      referenceId: input.closureId ?? null,
      idempotencyKey: input.idempotencyKey,
      requestHash: hash,
      actorId: actor.id,
      audit: {
        action: AUDIT_ACTIONS.CASH_WITHDRAWAL_CREATED,
        metadata: {
          amount: formatMoney(cash.balance),
          destination: "SESSION_CLOSING",
          recipient: input.recipientName,
        },
      },
    },
    [
      {
        account: "CASH_WITHDRAWALS",
        direction: "DEBIT",
        amount: cash.balance,
        scopeKey: GLOBAL_SCOPE,
      },
      {
        account: "CASH_ON_HAND",
        direction: "CREDIT",
        amount: cash.balance,
        scopeKey: input.sessionId,
      },
    ],
    ctx
  )
  return {
    transactionId: result.transactionId,
    amount: formatMoney(cash.balance),
    replayed: result.replayed,
    reconciliationId: closing.id,
  }
}

// ── Traslado efectivo → banco (depósito) ──────────────────────────────

/**
 * El efectivo sale de la caja hacia "en tránsito" (no es venta, ganancia
 * ni gasto). Al verificarse en el banco pasa a BANCO; si se rechaza, el
 * efectivo regresa a la caja (reverso). Nunca se suma dos veces.
 */
export async function registerCashDeposit(
  actor: SessionUser,
  input: CashDepositInput,
  ctx: RequestContext = {},
  deps: Deps = {}
): Promise<MovementResult & { bankTransferId: string }> {
  await requireSessionStatus(gateway(deps), input.sessionId, ["OPEN"])
  assertNoExpense(input.reason, input.notes)
  const amount = money(input.amount)
  const hash = requestHash(input)
  const bank = await prisma.paymentAccount.findFirst({
    where: { isPrimary: true, isActive: true },
    select: { id: true },
  })
  if (!bank)
    throw new BusinessRuleError("No hay cuenta bancaria principal configurada")

  const result = await run(input.idempotencyKey, hash, async (tx) => {
    const posted = await postTransactionInTx(
      tx,
      {
        type: "CASH_TRANSFER",
        sessionId: input.sessionId,
        reason: input.reason,
        notes: input.notes,
        counterpartyName: input.depositedBy,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
        actorId: actor.id,
        audit: {
          action: AUDIT_ACTIONS.CASH_TRANSFER_CREATED,
          metadata: { amount: formatMoney(amount), to: "CASH_IN_TRANSIT" },
        },
      },
      [
        {
          account: "CASH_IN_TRANSIT",
          direction: "DEBIT",
          amount,
          scopeKey: GLOBAL_SCOPE,
        },
        {
          account: "CASH_ON_HAND",
          direction: "CREDIT",
          amount,
          scopeKey: input.sessionId,
        },
      ],
      ctx
    )
    if (!posted.replayed) {
      await tx.bankTransferVerification.create({
        data: {
          kind: "CASH_DEPOSIT",
          paymentAccountId: bank.id,
          declaredAmount: amount,
          bankReference: input.bankReference ?? null,
          senderName: input.depositedBy,
          creditAccountKind: "CASH_IN_TRANSIT",
          sessionId: input.sessionId,
          referenceType: "CashTransaction",
          referenceId: posted.transactionId,
          idempotencyKey: `deposit-${input.idempotencyKey}`,
          depositTransactionId: posted.transactionId,
          createdById: actor.id,
        },
      })
    }
    return posted
  })
  const transfer = await prisma.bankTransferVerification.findUniqueOrThrow({
    where: { depositTransactionId: result.id },
    select: { id: true },
  })
  return { ...result, bankTransferId: transfer.id }
}

// ── Reversos ──────────────────────────────────────────────────────────

const REVERSIBLE = new Set([
  "CASH_CONTRIBUTION",
  "CASH_WITHDRAWAL",
  "BANK_TRANSFER_RECEIPT",
  "CASH_RECONCILIATION_ADJUSTMENT",
])

/**
 * Contraasiento de un movimiento confirmado (el original se conserva).
 * Un solo reverso por movimiento (UNIQUE). Si toca efectivo, la sesión
 * debe estar abierta y el resultado no puede quedar negativo.
 */
export async function reverseTransaction(
  actor: SessionUser,
  transactionId: string,
  input: ReverseInput,
  ctx: RequestContext = {},
  deps: Deps = {}
): Promise<MovementResult> {
  const original = await prisma.cashTransaction.findUnique({
    where: { id: transactionId },
    select: {
      id: true,
      folio: true,
      transactionType: true,
      sessionId: true,
      tableId: true,
      playerId: true,
      withdrawalDestination: true,
      reversedBy: { select: { id: true, folio: true } },
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
  if (!original) throw new NotFoundError("Movimiento no encontrado")
  const hash = requestHash({ transactionId, ...input })
  if (original.reversedBy) {
    const replay = await replayByKey(input.idempotencyKey, hash)
    if (replay) return { ...original.reversedBy, replayed: true }
    throw new BusinessRuleError(
      `Este movimiento ya fue revertido (folio ${original.reversedBy.folio})`
    )
  }
  if (
    !REVERSIBLE.has(original.transactionType) ||
    original.withdrawalDestination === "SESSION_CLOSING"
  ) {
    throw new BusinessRuleError(
      "Este tipo de movimiento no se revierte desde la caja: se corrige en su módulo de origen (compras, abonos, liquidaciones, cierre) o, si es un depósito, rechazándolo."
    )
  }
  const touchesCash = original.entries.some(
    (e) => e.account.kind === "CASH_ON_HAND"
  )
  if (touchesCash) {
    if (!original.sessionId)
      throw new BusinessRuleError("Movimiento de efectivo sin sesión")
    await requireSessionStatus(gateway(deps), original.sessionId, ["OPEN"])
  }

  return run(input.idempotencyKey, hash, (tx) =>
    postTransactionInTx(
      tx,
      {
        type: "REVERSAL",
        sessionId: original.sessionId,
        tableId: original.tableId,
        playerId: original.playerId,
        referenceType: "CashTransaction",
        referenceId: original.id,
        reason: input.reason,
        reversesTransactionId: original.id,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
        actorId: actor.id,
        audit: {
          action: AUDIT_ACTIONS.CASH_MOVEMENT_REVERSED,
          metadata: {
            originalFolio: original.folio,
            originalType: original.transactionType,
          },
        },
      },
      original.entries.map((e) => ({
        account: e.account.kind as LedgerEntry["account"],
        direction: e.direction === "DEBIT" ? "CREDIT" : "DEBIT",
        amount: new Prisma.Decimal(e.amount),
        scopeKey: e.scopeKey,
      })),
      ctx
    )
  )
}

// ── Consultas ─────────────────────────────────────────────────────────

const actorSel = { select: { id: true, name: true } } as const

export async function listFinancialAccounts() {
  const accounts = await prisma.financialAccount.findMany({
    orderBy: [{ isMoney: "desc" }, { code: "asc" }],
    select: {
      id: true,
      kind: true,
      code: true,
      name: true,
      isMoney: true,
      scope: true,
      nonNegative: true,
      isActive: true,
    },
  })
  return accounts
}

/**
 * Saldos conocidos. Efectivo: solo el de la sesión abierta (cada sesión
 * empieza en $0; no hay "saldo de caja" global). Banco: SOLO el neto de
 * movimientos registrados por Poker Manager, no el saldo real del banco.
 */
export async function getBalances(deps: Deps = {}) {
  const open = await gateway(deps).getOpenSession()
  const rows = await prisma.financialAccountBalance.findMany({
    where: { scopeKey: GLOBAL_SCOPE },
    select: {
      balance: true,
      account: { select: { kind: true, name: true, isMoney: true } },
    },
  })
  const global = Object.fromEntries(
    rows.map((r) => [
      r.account.kind,
      formatMoney(new Prisma.Decimal(r.balance)),
    ])
  )
  const cash = open ? await cashBalanceOf(prisma, open.id) : null
  return {
    session: open,
    cashOnHand: cash ? formatMoney(cash.balance) : null,
    bankKnownNet: global.BANK ?? "0.00",
    cashInTransit: global.CASH_IN_TRANSIT ?? "0.00",
    /** Cobros con terminal aprobados aún no depositados (no es efectivo). */
    cardPendingSettlement: global.CARD_TERMINAL_CLEARING ?? "0.00",
    bankNote:
      "Neto de movimientos registrados en Poker Manager; no es el saldo real de la cuenta bancaria.",
  }
}

/** Flujos históricos por tipo (entradas y salidas separadas, sin “ganancia”). */
export async function getFlowTotals() {
  const sumBy = async (where: Prisma.CashTransactionEntryWhereInput) => {
    const r = await prisma.cashTransactionEntry.aggregate({
      where,
      _sum: { amount: true },
    })
    return formatMoney(new Prisma.Decimal(r._sum.amount ?? 0))
  }
  const notReversed = { reversedBy: null }
  const [
    cashCollections,
    bankCollections,
    payouts,
    contributions,
    withdrawals,
    pending,
  ] = await Promise.all([
    sumBy({
      direction: "DEBIT",
      account: { kind: "CASH_ON_HAND" },
      transaction: {
        transactionType: { in: ["PURCHASE_PAYMENT", "DEBT_PAYMENT"] },
        ...notReversed,
      },
    }),
    sumBy({
      direction: "DEBIT",
      account: { kind: "BANK" },
      transaction: { transactionType: "BANK_TRANSFER_RECEIPT", ...notReversed },
    }),
    sumBy({
      direction: "CREDIT",
      account: { kind: "CASH_ON_HAND" },
      transaction: { transactionType: "PLAYER_SETTLEMENT", ...notReversed },
    }),
    sumBy({
      direction: "DEBIT",
      account: { kind: "CASH_ON_HAND" },
      transaction: { transactionType: "CASH_CONTRIBUTION", ...notReversed },
    }),
    sumBy({
      direction: "CREDIT",
      account: { kind: "CASH_ON_HAND" },
      transaction: { transactionType: "CASH_WITHDRAWAL", ...notReversed },
    }),
    prisma.bankTransferVerification.aggregate({
      where: { status: "PENDING_VERIFICATION" },
      _sum: { declaredAmount: true },
      _count: true,
    }),
  ])
  return {
    cashCollections,
    bankCollectionsConfirmed: bankCollections,
    settlementPayouts: payouts,
    contributions,
    withdrawals,
    pendingTransfers: {
      count: pending._count,
      amount: formatMoney(new Prisma.Decimal(pending._sum.declaredAmount ?? 0)),
    },
  }
}

const movementSelect = {
  id: true,
  folio: true,
  transactionType: true,
  sessionId: true,
  reason: true,
  notes: true,
  counterpartyName: true,
  withdrawalDestination: true,
  referenceType: true,
  referenceId: true,
  createdAt: true,
  reversesTransactionId: true,
  reverses: { select: { id: true, folio: true } },
  reversedBy: { select: { id: true, folio: true } },
  table: { select: { id: true, name: true } },
  player: { select: { id: true, name: true } },
  createdBy: actorSel,
  entries: {
    select: {
      direction: true,
      amount: true,
      scopeKey: true,
      account: { select: { kind: true, name: true, isMoney: true } },
    },
  },
} satisfies Prisma.CashTransactionSelect

type MovementRecord = Prisma.CashTransactionGetPayload<{
  select: typeof movementSelect
}>

function toMovementView(m: MovementRecord) {
  const money = m.entries.filter((e) => e.account.isMoney)
  const amount = m.entries
    .filter((e) => e.direction === "DEBIT")
    .reduce((acc, e) => acc.add(new Prisma.Decimal(e.amount)), ZERO)
  return {
    id: m.id,
    folio: m.folio,
    type: m.transactionType,
    status: m.reversesTransactionId
      ? "REVERSAL"
      : m.reversedBy
        ? "REVERSED"
        : "ACTIVE",
    sessionId: m.sessionId,
    reason: m.reason,
    notes: m.notes,
    counterpartyName: m.counterpartyName,
    withdrawalDestination: m.withdrawalDestination,
    referenceType: m.referenceType,
    referenceId: m.referenceId,
    createdAt: m.createdAt.toISOString(),
    amount: formatMoney(amount),
    /** Efecto neto en cuentas de dinero (+ entra, − sale). */
    moneyEffects: money.map((e) => ({
      account: e.account.kind,
      accountName: e.account.name,
      scopeKey: e.scopeKey,
      amount: formatMoney(
        signedAmount(e.direction, new Prisma.Decimal(e.amount))
      ),
    })),
    entries: m.entries.map((e) => ({
      account: e.account.kind,
      accountName: e.account.name,
      direction: e.direction,
      amount: formatMoney(new Prisma.Decimal(e.amount)),
      scopeKey: e.scopeKey,
    })),
    reverses: m.reverses,
    reversedBy: m.reversedBy,
    table: m.table,
    player: m.player,
    createdBy: m.createdBy,
  }
}
export type CashMovementView = ReturnType<typeof toMovementView>

export async function listMovements(query: CashMovementsQuery) {
  const where: Prisma.CashTransactionWhereInput = {}
  if (query.type) where.transactionType = query.type
  if (query.status === "REVERSED") where.reversedBy = { isNot: null }
  if (query.status === "REVERSAL") where.reversesTransactionId = { not: null }
  if (query.status === "ACTIVE")
    Object.assign(where, { reversedBy: null, reversesTransactionId: null })
  if (query.method)
    where.entries = {
      some: {
        account: { kind: query.method === "CASH" ? "CASH_ON_HAND" : "BANK" },
      },
    }
  if (query.account)
    where.entries = { some: { account: { kind: query.account as never } } }
  if (query.userId) where.createdById = query.userId
  if (query.sessionId) where.sessionId = query.sessionId
  if (query.tableId) where.tableId = query.tableId
  if (query.playerId) where.playerId = query.playerId
  if (query.folio) where.folio = { contains: query.folio.toUpperCase() }
  if (query.reference)
    where.OR = [
      { referenceId: { contains: query.reference } },
      { referenceType: { contains: query.reference } },
    ]
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
    prisma.cashTransaction.count({ where }),
    prisma.cashTransaction.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: movementSelect,
    }),
  ])
  return {
    items: rows.map(toMovementView),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  }
}

export async function getMovement(id: string) {
  const m = await prisma.cashTransaction.findUnique({
    where: { id },
    select: movementSelect,
  })
  if (!m) throw new NotFoundError("Movimiento no encontrado")
  return toMovementView(m)
}

export async function getCashBoxOverview(deps: Deps = {}) {
  const [cashBox, balances, flows, recent] = await Promise.all([
    prisma.cashBox.findUnique({
      where: { code: "MAIN" },
      select: { id: true, code: true, name: true, currency: true },
    }),
    getBalances(deps),
    getFlowTotals(),
    listMovements({ page: 1, pageSize: 8 }),
  ])
  return { cashBox, ...balances, flows, recentMovements: recent.items }
}
