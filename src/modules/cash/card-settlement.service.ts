import "server-only"

import { randomUUID } from "node:crypto"

import { Prisma } from "@/generated/prisma/client"
import { AppError, BusinessRuleError, ConflictError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import { formatMoney, money, ZERO } from "@/modules/cash/cash.math"
import type { CardSettlementInput } from "@/modules/cash/cash.schemas"
import {
  cashTx,
  GLOBAL_SCOPE,
  postTransactionInTx,
} from "@/modules/cash/ledger"

/**
 * Cobros con terminal (Módulo 08) y su depósito bancario.
 *
 * - Un cobro APROBADO de compra se contabiliza al entregar las fichas:
 *   "Cobros con terminal por liquidar" + / "Cobros por compras" −. NO es
 *   efectivo y NO es banco todavía.
 * - Cuando el adquirente deposita, se registra una liquidación que liga los
 *   cobros originales: Banco + / Por liquidar −. No reconoce la venta otra
 *   vez y cada cobro se liquida UNA sola vez (FK única + guard en la base).
 * - Comisiones: no hay porcentajes configurados, así que no se descuenta
 *   nada automáticamente. Si el depósito es menor que el bruto, la
 *   diferencia se queda en "por liquidar" como pendiente de conciliación
 *   (con nota obligatoria); no se inventa ningún movimiento de comisión ni
 *   se registra como gasto.
 */

/**
 * Cobros con terminal aprobados aún no depositados: de compras (Módulo 08)
 * y de abonos a deuda (Módulo 10). Mismo flujo de liquidación para ambos.
 */
export async function listUnsettledCardPayments() {
  const [purchases, credits] = await Promise.all([
    prisma.purchasePayment.findMany({
      where: {
        method: { in: ["CARD_DEBIT", "CARD_CREDIT"] },
        status: "APPROVED",
        financialTransactionId: { not: null },
        cardSettlementId: null,
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        method: true,
        amount: true,
        terminalReference: true,
        createdAt: true,
        purchase: {
          select: {
            folio: true,
            player: { select: { name: true } },
            table: { select: { name: true } },
          },
        },
      },
    }),
    prisma.receivablePayment.findMany({
      where: {
        method: { in: ["CARD_DEBIT", "CARD_CREDIT"] },
        status: "CONFIRMED",
        cardSettlementId: null,
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        method: true,
        amount: true,
        terminalReference: true,
        createdAt: true,
        folio: true,
        player: { select: { name: true } },
      },
    }),
  ])
  return [
    ...purchases.map((r) => ({
      id: r.id,
      kind: "PURCHASE" as const,
      method: r.method,
      amount: formatMoney(new Prisma.Decimal(r.amount)),
      terminalReference: r.terminalReference,
      createdAt: r.createdAt.toISOString(),
      reference: {
        folio: r.purchase.folio,
        playerName: r.purchase.player.name,
        context: r.purchase.table.name,
      },
    })),
    ...credits.map((r) => ({
      id: r.id,
      kind: "CREDIT_PAYMENT" as const,
      method: r.method,
      amount: formatMoney(new Prisma.Decimal(r.amount)),
      terminalReference: r.terminalReference,
      createdAt: r.createdAt.toISOString(),
      reference: {
        folio: r.folio,
        playerName: r.player.name,
        context: "Abono a deuda",
      },
    })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export async function listCardSettlements() {
  const rows = await prisma.cardTerminalSettlement.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      grossAmount: true,
      depositedAmount: true,
      pendingDifference: true,
      status: true,
      bankReference: true,
      notes: true,
      createdAt: true,
      createdBy: { select: { id: true, name: true } },
      transaction: { select: { id: true, folio: true } },
      _count: { select: { payments: true, receivablePayments: true } },
    },
  })
  return rows.map((r) => ({
    ...r,
    grossAmount: formatMoney(new Prisma.Decimal(r.grossAmount)),
    depositedAmount: formatMoney(new Prisma.Decimal(r.depositedAmount)),
    pendingDifference: formatMoney(new Prisma.Decimal(r.pendingDifference)),
    createdAt: r.createdAt.toISOString(),
  }))
}

export async function registerCardSettlement(
  actor: SessionUser,
  input: CardSettlementInput,
  ctx: RequestContext = {}
) {
  const previous = await prisma.cardTerminalSettlement.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true },
  })
  if (previous) return { id: previous.id, replayed: true }
  const deposited = money(input.depositedAmount)
  const ids = [...new Set(input.paymentIds)].sort()
  return cashTx(async (tx) => {
    // Bloqueo de los cobros en orden fijo: dos registros del mismo depósito
    // se serializan y el segundo los ve ya liquidados.
    await tx.$queryRaw`SELECT "id" FROM "purchase_payments" WHERE "id" = ANY(${ids}::text[]) ORDER BY "id" FOR UPDATE`
    await tx.$queryRaw`SELECT "id" FROM "receivable_payments" WHERE "id" = ANY(${ids}::text[]) ORDER BY "id" FOR UPDATE`
    const again = await tx.cardTerminalSettlement.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true },
    })
    if (again) return { id: again.id, replayed: true }
    // Cobros de compras (Módulo 08) y de abonos a deuda (Módulo 10).
    const purchasePayments = await tx.purchasePayment.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        method: true,
        status: true,
        amount: true,
        financialTransactionId: true,
        cardSettlementId: true,
      },
    })
    const creditPayments = await tx.receivablePayment.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        method: true,
        status: true,
        amount: true,
        financialTransactionId: true,
        cardSettlementId: true,
      },
    })
    const payments = [
      ...purchasePayments.map((p) => ({ ...p, ok: p.status === "APPROVED" })),
      ...creditPayments.map((p) => ({ ...p, ok: p.status === "CONFIRMED" })),
    ]
    if (payments.length !== ids.length)
      throw new BusinessRuleError("Algún cobro seleccionado no existe")
    for (const p of payments) {
      if (p.method !== "CARD_DEBIT" && p.method !== "CARD_CREDIT")
        throw new BusinessRuleError("Solo se liquidan cobros con terminal")
      if (!p.ok || !p.financialTransactionId)
        throw new BusinessRuleError(
          "Solo se liquidan cobros aprobados ya contabilizados (compras entregadas o abonos confirmados)"
        )
      if (p.cardSettlementId)
        throw new ConflictError(
          "Algún cobro ya fue liquidado por otro depósito (no se reconoce dos veces)."
        )
    }
    const gross = payments.reduce(
      (acc, p) => acc.add(new Prisma.Decimal(p.amount)),
      ZERO
    )
    if (deposited.greaterThan(gross))
      throw new BusinessRuleError(
        `El depósito ($${formatMoney(deposited)}) excede el bruto de los cobros seleccionados ($${formatMoney(gross)}). Revisa la selección.`
      )
    const difference = gross.sub(deposited)
    if (difference.greaterThan(0) && !input.notes)
      throw new BusinessRuleError(
        "El depósito es menor que el bruto: explica la diferencia (p. ej. comisión). Quedará pendiente de conciliación."
      )
    const settlementId = randomUUID()
    const posted = await postTransactionInTx(
      tx,
      {
        type: "CARD_TERMINAL_SETTLEMENT",
        referenceType: "CardTerminalSettlement",
        referenceId: settlementId,
        reason:
          "Depósito de la terminal al banco (liquidación de cobros con tarjeta)",
        notes: input.notes ?? null,
        idempotencyKey: `card-settlement-${input.idempotencyKey}`,
        requestHash: `card-settlement-${ids.join(",")}-${formatMoney(deposited)}`,
        actorId: actor.id,
        audit: {
          action: AUDIT_ACTIONS.CARD_TERMINAL_SETTLED,
          metadata: {
            settlementId,
            payments: ids.length,
            gross: formatMoney(gross),
            deposited: formatMoney(deposited),
            pendingDifference: formatMoney(difference),
            bankReference: input.bankReference ?? null,
          },
        },
      },
      [
        {
          account: "BANK",
          direction: "DEBIT",
          amount: deposited,
          scopeKey: GLOBAL_SCOPE,
        },
        {
          account: "CARD_TERMINAL_CLEARING",
          direction: "CREDIT",
          amount: deposited,
          scopeKey: GLOBAL_SCOPE,
        },
      ],
      ctx
    )
    await tx.cardTerminalSettlement.create({
      data: {
        id: settlementId,
        grossAmount: gross,
        depositedAmount: deposited,
        pendingDifference: difference,
        status: difference.isZero() ? "RECONCILED" : "DIFFERENCE_PENDING",
        bankReference: input.bankReference ?? null,
        notes: input.notes ?? null,
        transactionId: posted.transactionId,
        createdById: actor.id,
        idempotencyKey: input.idempotencyKey,
      },
    })
    const a = await tx.purchasePayment.updateMany({
      where: { id: { in: ids }, cardSettlementId: null },
      data: { cardSettlementId: settlementId },
    })
    const b = await tx.receivablePayment.updateMany({
      where: { id: { in: ids }, cardSettlementId: null },
      data: { cardSettlementId: settlementId },
    })
    if (a.count + b.count !== ids.length)
      throw new AppError("CONFLICT", "Algún cobro cambió mientras se liquidaba")
    await recordAudit(
      {
        action: AUDIT_ACTIONS.TERMINAL_PAYMENT_SETTLED,
        entityType: "CardTerminalSettlement",
        entityId: settlementId,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          paymentIds: ids,
          gross: formatMoney(gross),
          deposited: formatMoney(deposited),
          pendingDifference: formatMoney(difference),
        },
      },
      tx
    )
    return { id: settlementId, replayed: false }
  })
}
