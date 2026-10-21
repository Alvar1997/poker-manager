import "server-only"

import { Prisma } from "@/generated/prisma/client"
import { canonicalHash } from "@/lib/canonical-json"
import { BusinessRuleError, NotFoundError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import type { CreditReceiptContent } from "@/modules/credits/credit-receipt.content"
import { creditReceiptLines } from "@/modules/credits/credit-receipt.content"
import { outstandingOf } from "@/modules/credits/receivable.service"
import { renderDocumentPng } from "@/modules/signatures/receipt-image"
import { receiptDate } from "@/modules/signatures/receipt.content"

type Tx = Prisma.TransactionClient
const dec = (v: Prisma.Decimal | string) => new Prisma.Decimal(v)

/**
 * Comprobante digital de cada abono CONFIRMED, creado en la misma
 * transacción que lo confirma (snapshot inmutable con huella). Reutiliza
 * el generador PNG del Módulo 09. Sin PDF ni envío automático.
 */
export async function createCreditReceiptInTx(
  tx: Tx,
  actor: { id: string },
  paymentId: string,
  ctx: RequestContext = {}
) {
  const existing = await tx.receivablePaymentReceipt.findUnique({
    where: { paymentId },
    select: { id: true },
  })
  if (existing) return existing
  const p = await tx.receivablePayment.findUniqueOrThrow({
    where: { id: paymentId },
    select: {
      id: true,
      folio: true,
      amount: true,
      method: true,
      origin: true,
      confirmedAt: true,
      player: { select: { id: true, name: true } },
      session: { select: { id: true, folio: true } },
      confirmedBy: { select: { name: true } },
      financialTransaction: { select: { folio: true } },
      unappliedFunds: { select: { amount: true } },
      allocations: {
        where: { kind: "APPLICATION" },
        orderBy: { allocationOrder: "asc" },
        select: {
          allocationOrder: true,
          amount: true,
          receivableId: true,
          receivable: {
            select: {
              originalAmount: true,
              session: { select: { folio: true } },
              purchase: {
                select: { folio: true, table: { select: { name: true } } },
              },
            },
          },
        },
      },
    },
  })
  // Saldo de cada deuda DESPUÉS de este abono (ya aplicado en esta transacción).
  const after = new Map<string, Prisma.Decimal>()
  for (const a of p.allocations) {
    const rows = await tx.paymentAllocation.findMany({
      where: { receivableId: a.receivableId },
      select: { kind: true, amount: true },
    })
    const applied = rows.reduce(
      (acc, r) =>
        r.kind === "APPLICATION" ? acc.add(r.amount) : acc.sub(r.amount),
      new Prisma.Decimal(0)
    )
    after.set(a.receivableId, dec(a.receivable.originalAmount).sub(applied))
  }
  const applied = p.allocations.reduce(
    (acc, a) => acc.add(a.amount),
    new Prisma.Decimal(0)
  )
  const unapplied = p.unappliedFunds.reduce(
    (acc, u) => acc.add(u.amount),
    new Prisma.Decimal(0)
  )
  const content: CreditReceiptContent = {
    receiptFormat: "1",
    paymentId: p.id,
    folio: p.folio,
    confirmedAt: (p.confirmedAt ?? new Date()).toISOString(),
    player: p.player,
    method: p.method,
    amount: dec(p.amount).toFixed(2),
    applied: applied.toFixed(2),
    unapplied: unapplied.toFixed(2),
    origin: p.origin,
    session: p.session,
    financialReference: p.financialTransaction?.folio ?? null,
    confirmedBy: p.confirmedBy?.name ?? "",
    allocations: p.allocations.map((a) => ({
      order: a.allocationOrder,
      purchaseFolio: a.receivable.purchase.folio,
      sessionFolio: a.receivable.session.folio,
      tableName: a.receivable.purchase.table.name,
      amount: dec(a.amount).toFixed(2),
      balanceAfter: (
        after.get(a.receivableId) ?? new Prisma.Decimal(0)
      ).toFixed(2),
    })),
    remainingOutstanding: (await outstandingOf(tx, p.player.id)).toFixed(2),
  }
  const contentHash = canonicalHash(content)
  const receipt = await tx.receivablePaymentReceipt.create({
    data: {
      paymentId,
      content: content as unknown as Prisma.InputJsonValue,
      contentHash,
      createdById: actor.id,
    },
    select: { id: true },
  })
  await recordAudit(
    {
      action: AUDIT_ACTIONS.RECEIPT_CREATED,
      entityType: "ReceivablePaymentReceipt",
      entityId: receipt.id,
      actorUserId: actor.id,
      requestId: ctx.requestId,
      metadata: {
        paymentId,
        folio: p.folio,
        playerId: p.player.id,
        contentDigest: contentHash,
      },
    },
    tx
  )
  return receipt
}

export async function getCreditReceipt(paymentId: string) {
  const r = await prisma.receivablePaymentReceipt.findUnique({
    where: { paymentId },
    select: {
      id: true,
      status: true,
      content: true,
      contentHash: true,
      createdAt: true,
      voidedAt: true,
      voidReason: true,
    },
  })
  if (!r) {
    const p = await prisma.receivablePayment.findUnique({
      where: { id: paymentId },
      select: { status: true },
    })
    if (!p) throw new NotFoundError("Abono no encontrado")
    throw new BusinessRuleError(
      p.status === "PENDING"
        ? "El comprobante estará disponible cuando se verifique la transferencia."
        : "Este abono no tiene comprobante (no fue confirmado)."
    )
  }
  const content = r.content as unknown as CreditReceiptContent
  return {
    id: r.id,
    status: r.status,
    content,
    contentHash: r.contentHash,
    intact: canonicalHash(content) === r.contentHash,
    createdAt: r.createdAt.toISOString(),
    voidedAt: r.voidedAt?.toISOString() ?? null,
    voidReason: r.voidReason,
  }
}

export async function renderCreditReceiptPng(paymentId: string) {
  const r = await getCreditReceipt(paymentId)
  const png = await renderDocumentPng({
    kicker: "Poker Manager · Comprobante de abono",
    title: r.content.folio,
    date: receiptDate(r.content.confirmedAt),
    voided: r.status === "VOIDED",
    okLabel: "Abono confirmado",
    lines: creditReceiptLines(r.content),
    footer:
      "Aplicado por FIFO (deudas más antiguas primero). Sin saldos a favor.",
  })
  return { png, folio: r.content.folio, status: r.status }
}

export async function recordCreditReceiptEvent(
  actor: SessionUser,
  paymentId: string,
  event: "DOWNLOADED" | "SHARE_REQUESTED",
  metadata: Record<string, unknown>,
  ctx: RequestContext = {}
) {
  const r = await prisma.receivablePaymentReceipt.findUnique({
    where: { paymentId },
    select: { id: true },
  })
  if (!r) throw new NotFoundError("Comprobante no encontrado")
  await recordAudit({
    action:
      event === "DOWNLOADED"
        ? AUDIT_ACTIONS.RECEIPT_DOWNLOADED
        : AUDIT_ACTIONS.RECEIPT_SHARED_MANUALLY_REQUESTED,
    entityType: "ReceivablePaymentReceipt",
    entityId: r.id,
    actorUserId: actor.id,
    requestId: ctx.requestId,
    metadata: { paymentId, ...metadata },
  })
}
