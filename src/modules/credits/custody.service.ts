import "server-only"

import { randomUUID } from "node:crypto"

import { Prisma } from "@/generated/prisma/client"
import { AppError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import {
  cashTx,
  custodianScope,
  GLOBAL_SCOPE,
  postTransactionInTx,
} from "@/modules/cash/ledger"
import type {
  CustodyContributionInput,
  CustodyDepositInput,
} from "@/modules/credits/credit.schemas"

/**
 * Custodia de EFECTIVO ADMINISTRATIVO (Módulo 10, extensión del Módulo 05).
 *
 * El efectivo de abonos recibidos fuera de sesión queda en la cuenta
 * `ADMIN_CASH_CUSTODY` con alcance por custodio ("custodian:<userId>"):
 * es un libro de entradas y salidas (los asientos del Módulo 05), no un
 * saldo editable. NO es una caja de juego, no pertenece a ninguna mesa, no
 * modifica cajas de sesiones cerradas y nunca se suma a la apertura (que
 * sigue en $0). Si está físicamente donde se hace el arqueo de apertura,
 * debe segregarse antes de contar.
 *
 * Depósito al banco: traslado custodia − / banco + (`CASH_TRANSFER`). No
 * es un abono nuevo ni un ingreso adicional. El libro impide que la
 * custodia quede negativa, así que el mismo efectivo no se deposita dos veces.
 *
 * Módulo 11: la custodia también financia los pagos ADMINISTRATIVOS de
 * liquidaciones cuya sesión ya cerró (nunca la caja de una sesión). Si no
 * alcanza, un socio puede entregar efectivo real al custodio: aportación
 * documentada (`contributeToCustody`, OWNER_CONTRIBUTIONS → custodia).
 */

const dec = (v: Prisma.Decimal | string | number) => new Prisma.Decimal(v)

export async function getCustodySummary() {
  const rows = await prisma.financialAccountBalance.findMany({
    where: { account: { kind: "ADMIN_CASH_CUSTODY" } },
    select: { scopeKey: true, balance: true },
  })
  const ids = rows.map((r) => r.scopeKey.replace("custodian:", ""))
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, isActive: true },
  })
  const custodians = rows
    .map((r) => {
      const id = r.scopeKey.replace("custodian:", "")
      return {
        custodian: users.find((u) => u.id === id) ?? {
          id,
          name: "—",
          isActive: false,
        },
        balance: dec(r.balance).toFixed(2),
      }
    })
    .sort((a, b) => dec(b.balance).comparedTo(dec(a.balance)))
  const total = custodians.reduce((acc, c) => acc.add(c.balance), dec(0))
  return { total: total.toFixed(2), custodians }
}

/** Libro de la custodia: entradas (abonos) y salidas (depósitos, reversos). */
export async function listCustodyMovements(limit = 100) {
  const entries = await prisma.cashTransactionEntry.findMany({
    where: { account: { kind: "ADMIN_CASH_CUSTODY" } },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      direction: true,
      amount: true,
      scopeKey: true,
      createdAt: true,
      transaction: {
        select: {
          id: true,
          folio: true,
          transactionType: true,
          reason: true,
          referenceType: true,
          referenceId: true,
          createdBy: { select: { id: true, name: true } },
          player: { select: { id: true, name: true } },
        },
      },
    },
  })
  const ids = [
    ...new Set(entries.map((e) => e.scopeKey.replace("custodian:", ""))),
  ]
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  })
  return entries.map((e) => ({
    id: e.id,
    direction: e.direction === "DEBIT" ? ("IN" as const) : ("OUT" as const),
    amount: dec(e.amount).toFixed(2),
    custodian: users.find((u) => `custodian:${u.id}` === e.scopeKey) ?? null,
    createdAt: e.createdAt.toISOString(),
    transaction: e.transaction,
  }))
}

export async function listCustodyDeposits() {
  const rows = await prisma.administrativeCashDeposit.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      amount: true,
      bankReference: true,
      notes: true,
      createdAt: true,
      custodian: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
      transaction: { select: { id: true, folio: true } },
    },
  })
  return rows.map((r) => ({
    ...r,
    amount: dec(r.amount).toFixed(2),
    createdAt: r.createdAt.toISOString(),
  }))
}

/** Depósito verificado de efectivo en custodia al banco (sin doble ingreso). */
export async function depositCustody(
  actor: SessionUser,
  input: CustodyDepositInput,
  ctx: RequestContext = {}
) {
  const previous = await prisma.administrativeCashDeposit.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, custodianUserId: true },
  })
  if (previous) {
    if (previous.custodianUserId !== input.custodianUserId)
      throw new AppError("CONFLICT", "Clave de operación reutilizada")
    return { id: previous.id, replayed: true }
  }
  const amount = dec(input.amount)
  const depositId = randomUUID()
  return cashTx(async (tx) => {
    const posted = await postTransactionInTx(
      tx,
      {
        type: "CASH_TRANSFER",
        referenceType: "AdministrativeCashDeposit",
        referenceId: depositId,
        reason: "Depósito al banco de efectivo administrativo en custodia",
        notes: input.notes ?? null,
        idempotencyKey: `custody-deposit-${input.idempotencyKey}`,
        requestHash: `custody-deposit-${input.custodianUserId}-${amount.toFixed(2)}`,
        actorId: actor.id,
        audit: {
          action: AUDIT_ACTIONS.ADMINISTRATIVE_CASH_DEPOSITED,
          metadata: {
            custodianUserId: input.custodianUserId,
            amount: amount.toFixed(2),
            bankReference: input.bankReference ?? null,
          },
        },
      },
      [
        { account: "BANK", direction: "DEBIT", amount, scopeKey: GLOBAL_SCOPE },
        {
          account: "ADMIN_CASH_CUSTODY",
          direction: "CREDIT",
          amount,
          scopeKey: custodianScope(input.custodianUserId),
        },
      ],
      ctx
    )
    if (posted.replayed) {
      const d = await tx.administrativeCashDeposit.findUniqueOrThrow({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true },
      })
      return { id: d.id, replayed: true }
    }
    const deposit = await tx.administrativeCashDeposit.create({
      data: {
        id: depositId,
        custodianUserId: input.custodianUserId,
        amount,
        bankReference: input.bankReference ?? null,
        notes: input.notes ?? null,
        transactionId: posted.transactionId,
        createdById: actor.id,
        idempotencyKey: input.idempotencyKey,
      },
      select: { id: true },
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.ADMINISTRATIVE_CASH_DEPOSITED,
        entityType: "AdministrativeCashDeposit",
        entityId: deposit.id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          custodianUserId: input.custodianUserId,
          amount: amount.toFixed(2),
          note: "Traslado de custodia al banco: no es un abono ni un ingreso adicional.",
        },
      },
      tx
    )
    return { id: deposit.id, replayed: false }
  })
}

/**
 * Aportación REAL de efectivo a la custodia administrativa del usuario que
 * lo recibe (Módulo 11): permite pagar liquidaciones pendientes después del
 * cierre sin reabrir ni debitar cajas de sesión. Documentada (quién entregó
 * y para qué) y auditada; nunca se suma a la apertura de una sesión.
 */
export async function contributeToCustody(
  actor: SessionUser,
  input: CustodyContributionInput,
  ctx: RequestContext = {}
) {
  const previous = await prisma.administrativeCashContribution.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, custodianUserId: true, amount: true },
  })
  const amount = dec(input.amount)
  if (previous) {
    if (
      previous.custodianUserId !== actor.id ||
      !dec(previous.amount).equals(amount)
    )
      throw new AppError("CONFLICT", "Clave de operación reutilizada")
    return { id: previous.id, replayed: true }
  }
  const contributionId = randomUUID()
  return cashTx(async (tx) => {
    const posted = await postTransactionInTx(
      tx,
      {
        type: "CASH_CONTRIBUTION",
        referenceType: "AdministrativeCashContribution",
        referenceId: contributionId,
        reason: `Aportación a custodia administrativa: ${input.reason}`,
        counterpartyName: input.counterpartyName,
        idempotencyKey: `custody-contribution-${input.idempotencyKey}`,
        requestHash: `custody-contribution-${actor.id}-${amount.toFixed(2)}`,
        actorId: actor.id,
        audit: {
          action: AUDIT_ACTIONS.ADMINISTRATIVE_CASH_CONTRIBUTED,
          metadata: {
            custodianUserId: actor.id,
            amount: amount.toFixed(2),
            counterpartyName: input.counterpartyName,
          },
        },
      },
      [
        {
          account: "ADMIN_CASH_CUSTODY",
          direction: "DEBIT",
          amount,
          scopeKey: custodianScope(actor.id),
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
    if (posted.replayed) {
      const c = await tx.administrativeCashContribution.findUniqueOrThrow({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true },
      })
      return { id: c.id, replayed: true }
    }
    const created = await tx.administrativeCashContribution.create({
      data: {
        id: contributionId,
        custodianUserId: actor.id,
        amount,
        counterpartyName: input.counterpartyName,
        reason: input.reason,
        transactionId: posted.transactionId,
        createdById: actor.id,
        idempotencyKey: input.idempotencyKey,
      },
      select: { id: true },
    })
    return { id: created.id, replayed: false }
  })
}

/** Saldo de custodia de un usuario (sin bloquear; el libro decide al pagar). */
export async function custodyBalanceOf(userId: string) {
  const row = await prisma.financialAccountBalance.findFirst({
    where: {
      scopeKey: custodianScope(userId),
      account: { kind: "ADMIN_CASH_CUSTODY" },
    },
    select: { balance: true },
  })
  return (row ? dec(row.balance) : dec(0)).toFixed(2)
}
