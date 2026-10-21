import "server-only"

import { Prisma } from "@/generated/prisma/client"
import { AppError, BusinessRuleError, NotFoundError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import { recordAudit, type AuditAction } from "@/modules/audit/audit.service"
import type { RequestContext } from "@/modules/auth/auth.service"
import {
  formatMoney,
  isBalanced,
  shortfall,
  signedAmount,
  ZERO,
} from "@/modules/cash/cash.math"
import type { FinancialAccountKindValue } from "@/modules/cash/cash.seed"
import { issueFolio } from "@/modules/settings/folio.service"

/**
 * Núcleo del libro financiero. NADA fuera de src/modules/cash/* escribe en
 * cash_transactions / cash_transaction_entries / financial_account_balances.
 *
 * `postTransactionInTx` (atómico, dentro de la transacción de quien llama):
 *  1. Verifica que las partidas cuadren (y la base lo vuelve a exigir con
 *     un trigger diferido al COMMIT).
 *  2. Bloquea con FOR UPDATE las proyecciones de saldo afectadas, en orden
 *     determinista (sin interbloqueos). Dos retiros simultáneos del mismo
 *     efectivo se serializan: el segundo ve el saldo ya descontado.
 *  3. Detecta reintentos por `idempotencyKey` DESPUÉS del bloqueo.
 *  4. Rechaza saldos negativos en cuentas `nonNegative` (efectivo, en
 *     tránsito) indicando el faltante; la base lo respalda con un CHECK.
 *  5. Emite folio CASH_MOVEMENT, inserta transacción y partidas, actualiza
 *     saldos y registra auditoría, todo en la misma transacción.
 */

export type Tx = Prisma.TransactionClient
export type Db = Tx | typeof prisma

export const CASH_TX = { maxWait: 15_000, timeout: 20_000 } as const

export function cashTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn, CASH_TX)
}

export const GLOBAL_SCOPE = "GLOBAL"

/** Alcance de la custodia administrativa de un usuario. */
export function custodianScope(userId: string) {
  return `custodian:${userId}`
}

export type LedgerEntry = {
  account: FinancialAccountKindValue
  direction: "DEBIT" | "CREDIT"
  amount: Prisma.Decimal
  /** Obligatorio para CASH_ON_HAND (id de sesión); "GLOBAL" para el resto. */
  scopeKey: string
}

export type LedgerTransactionInput = {
  type:
    | "CASH_CONTRIBUTION"
    | "CASH_WITHDRAWAL"
    | "CASH_TRANSFER"
    | "BANK_TRANSFER_RECEIPT"
    | "BANK_TRANSFER_PAYOUT"
    | "PURCHASE_PAYMENT"
    | "DEBT_PAYMENT"
    | "PLAYER_SETTLEMENT"
    | "REVERSAL"
    | "CASH_RECONCILIATION_ADJUSTMENT"
    | "CARD_TERMINAL_SETTLEMENT"
  sessionId?: string | null
  tableId?: string | null
  playerId?: string | null
  referenceType?: string | null
  referenceId?: string | null
  reason: string
  notes?: string | null
  counterpartyName?: string | null
  withdrawalDestination?:
    | "OWNER_CUSTODY"
    | "SAFEKEEPING"
    | "CONTRIBUTION_RETURN"
    | "SESSION_CLOSING"
    | null
  idempotencyKey: string
  requestHash: string
  reversesTransactionId?: string | null
  actorId: string | null
  audit: { action: AuditAction; metadata?: Record<string, unknown> }
}

export class InsufficientFundsError extends AppError {
  constructor(
    accountName: string,
    available: Prisma.Decimal,
    requested: Prisma.Decimal
  ) {
    const missing = shortfall(available, requested)
    super(
      "BUSINESS_RULE_ERROR",
      `Fondos insuficientes en ${accountName}: hay $${formatMoney(available)} y se requieren $${formatMoney(requested)}. Faltan $${formatMoney(missing)}. Primero debe entrar dinero real (cobro, aportación o traslado confirmado).`,
      {
        available: formatMoney(available),
        requested: formatMoney(requested),
        shortfall: formatMoney(missing),
      }
    )
  }
}

type AccountRow = {
  id: string
  kind: string
  name: string
  nonNegative: boolean
  scope: string
  cashBoxId: string
}

async function accountsByKind(
  tx: Db,
  kinds: string[]
): Promise<Map<string, AccountRow>> {
  const rows = await tx.financialAccount.findMany({
    where: {
      kind: { in: kinds as FinancialAccountKindValue[] },
      isActive: true,
    },
    select: {
      id: true,
      kind: true,
      name: true,
      nonNegative: true,
      scope: true,
      cashBoxId: true,
    },
  })
  const map = new Map<string, AccountRow>(rows.map((r) => [r.kind, r]))
  for (const kind of kinds) {
    if (!map.has(kind)) {
      throw new NotFoundError(
        `Falta la cuenta financiera ${kind}. Ejecuta \`npm run db:seed\`.`
      )
    }
  }
  return map
}

/**
 * Bloquea (FOR UPDATE) la proyección de saldo, creándola en 0 si no existe.
 * `ON CONFLICT DO NOTHING` sin destino: con dos creaciones simultáneas el
 * choque puede detectarse primero en la llave primaria (derivada de los
 * mismos valores) y no en (accountId, scopeKey); ambos deben ignorarse.
 */
export async function lockBalance(
  tx: Tx,
  account: AccountRow,
  scopeKey: string
): Promise<{ balance: Prisma.Decimal; version: number }> {
  await tx.$executeRaw`
    INSERT INTO "financial_account_balances" ("id", "accountId", "scopeKey", "balance", "nonNegative", "version", "updatedAt")
    VALUES (${`bal_${account.id}_${scopeKey}`.slice(0, 120)}, ${account.id}, ${scopeKey}, 0, ${account.nonNegative}, 0, NOW())
    ON CONFLICT DO NOTHING
  `
  const rows = await tx.$queryRaw<
    { balance: Prisma.Decimal; version: number }[]
  >`
    SELECT "balance", "version" FROM "financial_account_balances"
    WHERE "accountId" = ${account.id} AND "scopeKey" = ${scopeKey}
    FOR UPDATE
  `
  return {
    balance: new Prisma.Decimal(rows[0].balance),
    version: rows[0].version,
  }
}

/** Saldo de efectivo de una sesión (sin bloquear). Sesión nueva = $0.00. */
export async function cashBalanceOf(db: Db, sessionId: string) {
  const row = await db.financialAccountBalance.findFirst({
    where: { scopeKey: sessionId, account: { kind: "CASH_ON_HAND" } },
    select: { balance: true, version: true },
  })
  return {
    balance: row ? new Prisma.Decimal(row.balance) : ZERO,
    version: row?.version ?? 0,
  }
}

/** Bloquea el efectivo de una sesión (para arqueos/retiros totales). */
export async function lockCashBalance(tx: Tx, sessionId: string) {
  const accounts = await accountsByKind(tx, ["CASH_ON_HAND"])
  return lockBalance(tx, accounts.get("CASH_ON_HAND")!, sessionId)
}

/**
 * Bloquea VARIAS proyecciones en orden determinista antes de una serie de
 * asientos en la misma transacción (p. ej. efectivo + terminal de una
 * compra): evita interbloqueos con otras transacciones que toman las mismas
 * cuentas en otro orden.
 */
export async function lockAccountsInTx(
  tx: Tx,
  keys: { account: FinancialAccountKindValue; scopeKey: string }[]
) {
  if (keys.length === 0) return
  const accounts = await accountsByKind(tx, [
    ...new Set(keys.map((k) => k.account)),
  ])
  const unique = [
    ...new Map(keys.map((k) => [`${k.account}|${k.scopeKey}`, k])).values(),
  ]
    .map((k) => ({ account: accounts.get(k.account)!, scopeKey: k.scopeKey }))
    .sort((a, b) =>
      `${a.account.id}|${a.scopeKey}`.localeCompare(
        `${b.account.id}|${b.scopeKey}`
      )
    )
  for (const k of unique) await lockBalance(tx, k.account, k.scopeKey)
}

export type PostResult = { transactionId: string; replayed: boolean }

export async function postTransactionInTx(
  tx: Tx,
  input: LedgerTransactionInput,
  entries: LedgerEntry[],
  ctx: RequestContext = {}
): Promise<PostResult> {
  if (!isBalanced(entries)) {
    throw new Error(
      "Transacción financiera descuadrada (error de programación)"
    )
  }
  for (const e of entries) {
    if (!e.amount.greaterThan(0))
      throw new BusinessRuleError("Los importes deben ser mayores que cero")
    if (
      e.account === "CASH_ON_HAND" &&
      (!e.scopeKey || e.scopeKey === GLOBAL_SCOPE)
    ) {
      throw new Error("El efectivo siempre pertenece a una sesión")
    }
    // La custodia administrativa siempre es de un custodio identificado.
    if (
      (e.account === "ADMIN_CASH_CUSTODY") !==
      e.scopeKey.startsWith("custodian:")
    )
      throw new Error("La custodia administrativa pertenece a un custodio")
  }

  const accounts = await accountsByKind(tx, [
    ...new Set(entries.map((e) => e.account)),
  ])

  // Bloqueos en orden determinista: (cuenta, alcance).
  const keys = [
    ...new Map(entries.map((e) => [`${e.account}|${e.scopeKey}`, e])).values(),
  ]
    .map((e) => ({ account: accounts.get(e.account)!, scopeKey: e.scopeKey }))
    .sort((a, b) =>
      `${a.account.id}|${a.scopeKey}`.localeCompare(
        `${b.account.id}|${b.scopeKey}`
      )
    )
  const current = new Map<string, Prisma.Decimal>()
  for (const k of keys) {
    const locked = await lockBalance(tx, k.account, k.scopeKey)
    current.set(`${k.account.kind}|${k.scopeKey}`, locked.balance)
  }

  // Reintento: misma clave → misma transacción (o 409 si cambió el contenido).
  const existing = await tx.cashTransaction.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, requestHash: true },
  })
  if (existing) {
    if (existing.requestHash !== input.requestHash) {
      throw new AppError(
        "CONFLICT",
        "Esta clave de operación ya se usó con datos distintos. Recarga e intenta de nuevo."
      )
    }
    return { transactionId: existing.id, replayed: true }
  }

  // Saldos resultantes y regla de no negativos.
  const after = new Map(current)
  for (const e of entries) {
    const key = `${e.account}|${e.scopeKey}`
    after.set(key, after.get(key)!.add(signedAmount(e.direction, e.amount)))
  }
  for (const [key, balance] of after) {
    const [kind] = key.split("|")
    const account = accounts.get(kind)!
    if (account.nonNegative && balance.isNegative()) {
      const before = current.get(key)!
      throw new InsufficientFundsError(
        account.name,
        before,
        before.sub(balance)
      )
    }
  }

  const cashBoxId = [...accounts.values()][0].cashBoxId
  const folio = await issueFolio(tx, "CASH_MOVEMENT")
  const created = await tx.cashTransaction.create({
    data: {
      folio,
      transactionType: input.type,
      cashBoxId,
      sessionId: input.sessionId ?? null,
      tableId: input.tableId ?? null,
      playerId: input.playerId ?? null,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      reason: input.reason,
      notes: input.notes ?? null,
      counterpartyName: input.counterpartyName ?? null,
      withdrawalDestination: input.withdrawalDestination ?? null,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      reversesTransactionId: input.reversesTransactionId ?? null,
      createdById: input.actorId,
      confirmedById: input.actorId,
    },
    select: { id: true },
  })
  await tx.cashTransactionEntry.createMany({
    data: entries.map((e) => ({
      transactionId: created.id,
      accountId: accounts.get(e.account)!.id,
      direction: e.direction,
      amount: e.amount,
      scopeKey: e.scopeKey,
    })),
  })
  for (const k of keys) {
    const key = `${k.account.kind}|${k.scopeKey}`
    await tx.financialAccountBalance.update({
      where: {
        accountId_scopeKey: { accountId: k.account.id, scopeKey: k.scopeKey },
      },
      data: { balance: after.get(key)!, version: { increment: 1 } },
    })
  }
  await recordAudit(
    {
      action: input.audit.action,
      entityType: "CashTransaction",
      entityId: created.id,
      actorUserId: input.actorId,
      requestId: ctx.requestId,
      metadata: {
        folio,
        type: input.type,
        sessionId: input.sessionId ?? null,
        tableId: input.tableId ?? null,
        playerId: input.playerId ?? null,
        reason: input.reason,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        entries: entries.map((e) => ({
          account: e.account,
          direction: e.direction,
          amount: formatMoney(e.amount),
        })),
        ...input.audit.metadata,
      },
    },
    tx
  )
  return { transactionId: created.id, replayed: false }
}

/** Reintento de una operación (UNIQUE de la clave), fuera de la transacción. */
export async function replayByKey(
  idempotencyKey: string,
  requestHash: string
): Promise<string | null> {
  const existing = await prisma.cashTransaction.findUnique({
    where: { idempotencyKey },
    select: { id: true, requestHash: true },
  })
  return existing && existing.requestHash === requestHash ? existing.id : null
}
