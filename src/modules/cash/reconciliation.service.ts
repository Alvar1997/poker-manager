import "server-only"

import { Prisma } from "@/generated/prisma/client"
import { AppError, BusinessRuleError, NotFoundError } from "@/lib/errors"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import { requestHash } from "@/modules/inventory/inventory.math"
import { assertPreparationAccess } from "@/modules/sessions/session-access"
import { formatMoney, money, ZERO } from "@/modules/cash/cash.math"
import type { CreateReconciliationInput } from "@/modules/cash/cash.schemas"
import {
  cashTx,
  GLOBAL_SCOPE,
  lockCashBalance,
  postTransactionInTx,
  type Tx,
} from "@/modules/cash/ledger"
import {
  currentSessionGateway,
  requireSessionStatus,
  type SessionGateway,
  type SessionStatus,
} from "@/modules/cash/session-gateway"

/**
 * Arqueo de EFECTIVO (proceso financiero distinto del arqueo de fichas).
 *
 * - OPENING (sesión PREPARATION): el esperado es SIEMPRE $0.00. Si aparece
 *   dinero, NO se convierte en fondo: se retira físicamente y se vuelve a
 *   contar (no hay ajuste de apertura).
 * - CONTROL (sesión OPEN) y CLOSING (OPEN o CLOSING): esperado = efectivo
 *   del libro para la sesión.
 * - Contar no modifica saldos (CONC-01). Una diferencia exige explicación
 *   (CONC-02); el ajuste es explícito, auditado y único (CONC-03/04/05).
 * - Confirmar con el efectivo cambiado desde el conteo → 409 (CONC-09).
 * - Confirmados inmutables (trigger, CONC-10).
 */

type Deps = { sessions?: SessionGateway }
const gw = (d: Deps) => d.sessions ?? currentSessionGateway()

const ALLOWED: Record<"OPENING" | "CONTROL" | "CLOSING", SessionStatus[]> = {
  OPENING: ["PREPARATION"],
  CONTROL: ["OPEN"],
  CLOSING: ["OPEN", "CLOSING"],
}

const reconciliationSelect = {
  id: true,
  sessionId: true,
  reconciliationType: true,
  status: true,
  differenceStatus: true,
  expectedAmount: true,
  countedAmount: true,
  differenceAmount: true,
  balanceVersion: true,
  notes: true,
  explanation: true,
  createdAt: true,
  confirmedAt: true,
  adjustedAt: true,
  createdBy: { select: { id: true, name: true } },
  confirmedBy: { select: { id: true, name: true } },
  adjustedBy: { select: { id: true, name: true } },
  adjustmentTransaction: { select: { id: true, folio: true } },
  details: {
    orderBy: { unitValue: "desc" },
    select: { unitValue: true, quantity: true },
  },
} satisfies Prisma.CashReconciliationSelect

type Rec = Prisma.CashReconciliationGetPayload<{
  select: typeof reconciliationSelect
}>

function toView(r: Rec) {
  const d = (v: Prisma.Decimal) => formatMoney(new Prisma.Decimal(v))
  return {
    ...r,
    expectedAmount: d(r.expectedAmount),
    countedAmount: d(r.countedAmount),
    differenceAmount: d(r.differenceAmount),
    createdAt: r.createdAt.toISOString(),
    confirmedAt: r.confirmedAt?.toISOString() ?? null,
    adjustedAt: r.adjustedAt?.toISOString() ?? null,
    details: r.details.map((x) => ({
      unitValue: d(x.unitValue),
      quantity: x.quantity,
    })),
  }
}
export type CashReconciliationView = ReturnType<typeof toView>

export async function getCashReconciliation(id: string) {
  const r = await prisma.cashReconciliation.findUnique({
    where: { id },
    select: reconciliationSelect,
  })
  if (!r) throw new NotFoundError("Arqueo de efectivo no encontrado")
  return toView(r)
}

export async function listCashReconciliations(query: {
  sessionId?: string
  page: number
  pageSize: number
}) {
  const where: Prisma.CashReconciliationWhereInput = query.sessionId
    ? { sessionId: query.sessionId }
    : {}
  const [total, rows] = await prisma.$transaction([
    prisma.cashReconciliation.count({ where }),
    prisma.cashReconciliation.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: reconciliationSelect,
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

export async function createCashReconciliation(
  actor: SessionUser,
  input: CreateReconciliationInput,
  ctx: RequestContext = {},
  deps: Deps = {}
) {
  await requireSessionStatus(
    gw(deps),
    input.sessionId,
    ALLOWED[input.reconciliationType]
  )
  // La caja inicial en $0 es parte de la PREPARACIÓN: solo el creador o SUPERADMIN.
  if (input.reconciliationType === "OPENING") {
    await assertPreparationAccess(prisma, actor, input.sessionId)
  }
  const fromDetails = input.details
    ? input.details.reduce(
        (acc, x) => acc.add(new Prisma.Decimal(x.unitValue).mul(x.quantity)),
        ZERO
      )
    : null
  const counted =
    input.countedAmount !== undefined
      ? money(input.countedAmount)
      : fromDetails!
  if (fromDetails && !fromDetails.equals(counted)) {
    throw new BusinessRuleError(
      `El desglose suma $${formatMoney(fromDetails)} y no coincide con el importe contado`
    )
  }

  try {
    const id = await cashTx(async (tx) => {
      const cash = await lockCashBalance(tx, input.sessionId)
      const expected =
        input.reconciliationType === "OPENING" ? ZERO : cash.balance
      if (input.reconciliationType === "OPENING" && !cash.balance.isZero()) {
        throw new BusinessRuleError(
          "La sesión ya registra movimientos de efectivo: el arqueo de apertura debe hacerse antes"
        )
      }
      const box = await tx.cashBox.findUniqueOrThrow({
        where: { code: "MAIN" },
        select: { id: true },
      })
      const created = await tx.cashReconciliation.create({
        data: {
          cashBoxId: box.id,
          sessionId: input.sessionId,
          reconciliationType: input.reconciliationType,
          expectedAmount: expected,
          countedAmount: counted,
          balanceVersion: cash.version,
          notes: input.notes ?? null,
          createdById: actor.id,
        },
        select: { id: true },
      })
      if (input.details?.length) {
        await tx.cashReconciliationDetail.createMany({
          data: input.details.map((x) => ({
            reconciliationId: created.id,
            unitValue: x.unitValue,
            quantity: x.quantity,
          })),
        })
      }
      await recordAudit(
        {
          action: AUDIT_ACTIONS.CASH_RECONCILIATION_CREATED,
          entityType: "CashReconciliation",
          entityId: created.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            sessionId: input.sessionId,
            type: input.reconciliationType,
            expected: formatMoney(expected),
            counted: formatMoney(counted),
          },
        },
        tx
      )
      return created.id
    })
    return getCashReconciliation(id)
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError(
        "CONFLICT",
        "Ya hay un arqueo de efectivo en borrador para esta sesión: confírmalo o cancélalo"
      )
    }
    throw error
  }
}

export async function confirmCashReconciliation(
  actor: SessionUser,
  id: string,
  input: { explanation?: string },
  ctx: RequestContext = {},
  deps: Deps = {}
) {
  const head = await prisma.cashReconciliation.findUnique({
    where: { id },
    select: { sessionId: true, reconciliationType: true, status: true },
  })
  if (!head) throw new NotFoundError("Arqueo de efectivo no encontrado")
  if (head.status === "CONFIRMED") return getCashReconciliation(id)
  await requireSessionStatus(
    gw(deps),
    head.sessionId,
    ALLOWED[head.reconciliationType]
  )
  if (head.reconciliationType === "OPENING") {
    await assertPreparationAccess(prisma, actor, head.sessionId)
  }

  await cashTx(async (tx) => {
    const cash = await lockCashBalance(tx, head.sessionId)
    const r = await tx.cashReconciliation.findUniqueOrThrow({
      where: { id },
      select: {
        status: true,
        expectedAmount: true,
        countedAmount: true,
        balanceVersion: true,
        reconciliationType: true,
      },
    })
    if (r.status === "CONFIRMED") return
    if (r.status !== "DRAFT")
      throw new BusinessRuleError("El arqueo fue cancelado")
    if (cash.version !== r.balanceVersion) {
      throw new AppError(
        "CONFLICT",
        "El efectivo cambió desde que se calculó el esperado. Cancela este arqueo y vuelve a contar.",
        { stale: true }
      )
    }
    const diff = new Prisma.Decimal(r.countedAmount).sub(
      new Prisma.Decimal(r.expectedAmount)
    )
    if (!diff.isZero() && !input.explanation?.trim()) {
      throw new BusinessRuleError(
        "Hay una diferencia: explica su causa antes de confirmar"
      )
    }
    await tx.cashReconciliation.update({
      where: { id },
      data: {
        status: "CONFIRMED",
        differenceAmount: diff,
        differenceStatus: diff.isZero() ? "NOT_REQUIRED" : "PENDING",
        explanation: input.explanation?.trim() || null,
        confirmedById: actor.id,
        confirmedAt: new Date(),
      },
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.CASH_RECONCILIATION_CONFIRMED,
        entityType: "CashReconciliation",
        entityId: id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          sessionId: head.sessionId,
          type: r.reconciliationType,
          difference: formatMoney(diff),
          explanation: input.explanation ?? null,
        },
      },
      tx
    )
  })
  return getCashReconciliation(id)
}

/**
 * Ajuste explícito de la diferencia (CONTROL/CLOSING). Único: transición
 * PENDING → ADJUSTED + UNIQUE de adjustmentTransactionId. Nunca negativo.
 * OPENING no admite ajuste: el efectivo encontrado se retira y se recuenta.
 */
export async function adjustCashReconciliation(
  actor: SessionUser,
  id: string,
  input: { reason: string; idempotencyKey: string },
  ctx: RequestContext = {},
  deps: Deps = {}
) {
  const head = await prisma.cashReconciliation.findUnique({
    where: { id },
    select: { sessionId: true, reconciliationType: true },
  })
  if (!head) throw new NotFoundError("Arqueo de efectivo no encontrado")
  if (head.reconciliationType === "OPENING") {
    throw new BusinessRuleError(
      "La apertura no se ajusta: si hay dinero, retíralo físicamente y vuelve a contar ($0.00). Nunca se convierte en fondo inicial."
    )
  }
  // Ajuste excepcional del cierre: solo con autorización de PARTNER o
  // SUPERADMIN registrada por el cierre de sesión (Módulo 12).
  if (head.reconciliationType === "CLOSING") {
    throw new BusinessRuleError(CLOSING_CASH_VIA_CLOSURE_MESSAGE)
  }
  await requireSessionStatus(
    gw(deps),
    head.sessionId,
    ALLOWED[head.reconciliationType]
  )
  await cashTx((tx) => adjustInTx(tx, actor, id, head.sessionId, input, ctx))
  return getCashReconciliation(id)
}

export const CLOSING_CASH_VIA_CLOSURE_MESSAGE =
  "La diferencia del arqueo de cierre se resuelve desde el cierre de sesión: recuento o ajuste excepcional autorizado por un socio o superadministrador."

/**
 * Ajuste dentro de una transacción ajena: el cierre (Módulo 12) lo usa para
 * el AJUSTE EXCEPCIONAL autorizado de su arqueo de efectivo. Devuelve el
 * asiento del ajuste.
 */
export function adjustCashReconciliationInTx(
  tx: Tx,
  actor: SessionUser,
  id: string,
  sessionId: string,
  input: { reason: string; idempotencyKey: string },
  ctx: RequestContext = {}
) {
  return adjustInTx(tx, actor, id, sessionId, input, ctx)
}

async function adjustInTx(
  tx: Tx,
  actor: SessionUser,
  id: string,
  sessionId: string,
  input: { reason: string; idempotencyKey: string },
  ctx: RequestContext
): Promise<string> {
  const head = { sessionId }
  const hash = requestHash({ id, ...input })
  {
    await lockCashBalance(tx, head.sessionId)
    const r = await tx.cashReconciliation.findUniqueOrThrow({
      where: { id },
      select: {
        status: true,
        differenceStatus: true,
        differenceAmount: true,
        adjustmentTransactionId: true,
      },
    })
    if (r.differenceStatus === "ADJUSTED") return r.adjustmentTransactionId!
    if (r.status !== "CONFIRMED" || r.differenceStatus !== "PENDING") {
      throw new BusinessRuleError(
        "Solo se ajustan arqueos confirmados con diferencia pendiente"
      )
    }
    const diff = new Prisma.Decimal(r.differenceAmount)
    const amount = diff.abs()
    const posted = await postTransactionInTx(
      tx,
      {
        type: "CASH_RECONCILIATION_ADJUSTMENT",
        sessionId: head.sessionId,
        referenceType: "CashReconciliation",
        referenceId: id,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
        actorId: actor.id,
        audit: {
          action: AUDIT_ACTIONS.CASH_RECONCILIATION_ADJUSTED,
          metadata: { reconciliationId: id, difference: formatMoney(diff) },
        },
      },
      diff.isNegative()
        ? [
            {
              account: "RECONCILIATION_DIFFERENCES",
              direction: "DEBIT",
              amount,
              scopeKey: GLOBAL_SCOPE,
            },
            {
              account: "CASH_ON_HAND",
              direction: "CREDIT",
              amount,
              scopeKey: head.sessionId,
            },
          ]
        : [
            {
              account: "CASH_ON_HAND",
              direction: "DEBIT",
              amount,
              scopeKey: head.sessionId,
            },
            {
              account: "RECONCILIATION_DIFFERENCES",
              direction: "CREDIT",
              amount,
              scopeKey: GLOBAL_SCOPE,
            },
          ],
      ctx
    )
    const { count } = await tx.cashReconciliation.updateMany({
      where: { id, differenceStatus: "PENDING" },
      data: {
        differenceStatus: "ADJUSTED",
        adjustmentTransactionId: posted.transactionId,
        adjustedById: actor.id,
        adjustedAt: new Date(),
      },
    })
    if (count !== 1) throw new AppError("CONFLICT", "El arqueo ya fue ajustado")
    return posted.transactionId
  }
}

/**
 * Arqueo de efectivo de CIERRE contado y confirmado en la misma transacción
 * del cierre (Módulo 12): esperado = efectivo del libro para la sesión, bajo
 * bloqueo. Una diferencia exige explicación y queda PENDIENTE (nunca se
 * ajusta sola). Contar no modifica saldos.
 */
export async function recordClosingCashCountInTx(
  tx: Tx,
  actor: SessionUser,
  input: {
    sessionId: string
    countedAmount: string
    details?: { unitValue: string; quantity: number }[]
    notes?: string | null
    explanation?: string | null
  },
  ctx: RequestContext = {}
) {
  const counted = money(input.countedAmount)
  if (input.details?.length) {
    const fromDetails = input.details.reduce(
      (acc, x) => acc.add(new Prisma.Decimal(x.unitValue).mul(x.quantity)),
      ZERO
    )
    if (!fromDetails.equals(counted)) {
      throw new BusinessRuleError(
        `El desglose suma $${formatMoney(fromDetails)} y no coincide con el importe contado`
      )
    }
  }
  const cash = await lockCashBalance(tx, input.sessionId)
  const diff = counted.sub(cash.balance)
  const explanation = input.explanation?.trim() || null
  if (!diff.isZero() && !explanation) {
    throw new BusinessRuleError(
      "Hay una diferencia: explica su causa antes de confirmar el arqueo"
    )
  }
  const box = await tx.cashBox.findUniqueOrThrow({
    where: { code: "MAIN" },
    select: { id: true },
  })
  const now = new Date()
  const created = await tx.cashReconciliation.create({
    data: {
      cashBoxId: box.id,
      sessionId: input.sessionId,
      reconciliationType: "CLOSING",
      expectedAmount: cash.balance,
      countedAmount: counted,
      balanceVersion: cash.version,
      notes: input.notes ?? null,
      createdById: actor.id,
    },
    select: { id: true },
  })
  if (input.details?.length) {
    await tx.cashReconciliationDetail.createMany({
      data: input.details.map((x) => ({
        reconciliationId: created.id,
        unitValue: x.unitValue,
        quantity: x.quantity,
      })),
    })
  }
  await tx.cashReconciliation.update({
    where: { id: created.id },
    data: {
      status: "CONFIRMED",
      differenceAmount: diff,
      differenceStatus: diff.isZero() ? "NOT_REQUIRED" : "PENDING",
      explanation,
      confirmedById: actor.id,
      confirmedAt: now,
    },
  })
  await recordAudit(
    {
      action: AUDIT_ACTIONS.CASH_RECONCILIATION_CONFIRMED,
      entityType: "CashReconciliation",
      entityId: created.id,
      actorUserId: actor.id,
      requestId: ctx.requestId,
      metadata: {
        sessionId: input.sessionId,
        type: "CLOSING",
        expected: formatMoney(cash.balance),
        counted: formatMoney(counted),
        difference: formatMoney(diff),
        explanation,
      },
    },
    tx
  )
  return {
    id: created.id,
    expected: cash.balance,
    counted,
    difference: diff,
    balanceVersion: cash.version,
  }
}

/** Sustituye la diferencia PENDIENTE de un arqueo de efectivo de CIERRE (sin ajuste). */
export async function supersedeClosingCashCountInTx(tx: Tx, id: string) {
  const { count } = await tx.cashReconciliation.updateMany({
    where: {
      id,
      reconciliationType: "CLOSING",
      status: "CONFIRMED",
      differenceStatus: "PENDING",
    },
    data: { differenceStatus: "SUPERSEDED" },
  })
  return count === 1
}

export async function cancelCashReconciliation(
  actor: SessionUser,
  id: string,
  ctx: RequestContext = {}
) {
  await cashTx(async (tx) => {
    const r = await tx.cashReconciliation.findUnique({
      where: { id },
      select: { status: true, sessionId: true, reconciliationType: true },
    })
    if (!r) throw new NotFoundError("Arqueo de efectivo no encontrado")
    if (r.status === "CANCELLED") return
    if (r.reconciliationType === "OPENING") {
      await assertPreparationAccess(tx, actor, r.sessionId, [
        "PREPARATION",
        "DRAFT",
      ])
    }
    if (r.status !== "DRAFT")
      throw new BusinessRuleError("Un arqueo confirmado no se cancela")
    await tx.cashReconciliation.update({
      where: { id },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.CASH_RECONCILIATION_CANCELLED,
        entityType: "CashReconciliation",
        entityId: id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: { sessionId: r.sessionId },
      },
      tx
    )
  })
  return getCashReconciliation(id)
}
