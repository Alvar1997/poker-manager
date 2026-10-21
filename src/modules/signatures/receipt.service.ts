import "server-only"

import { Prisma } from "@/generated/prisma/client"
import { canonicalHash } from "@/lib/canonical-json"
import { BusinessRuleError, NotFoundError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import {
  effectiveAmount,
  paymentEffect,
  purchaseTypeLabel,
} from "@/modules/purchases/purchase.math"
import type { ReceiptContent } from "@/modules/signatures/receipt.content"

/**
 * Comprobantes DIGITALES (no PDF) de compras confirmadas.
 *
 * - Se crean en la MISMA transacción que confirma la entrega (Módulo 08),
 *   uno por compra (índice único), solo para compras CONFIRMED (trigger).
 * - El contenido es un snapshot inmutable de lo entregado: importe, pagos
 *   confirmados AL MOMENTO de la entrega (una transferencia verificada
 *   después no lo cambia), crédito inicial, socio, firma y responsable. Sin
 *   denominaciones, teléfonos ni datos de tarjeta.
 * - Solo puede anularse (VOIDED) por un reverso (contrato para el Módulo
 *   11); el original se conserva.
 */

type Tx = Prisma.TransactionClient

const dec = (v: Prisma.Decimal | string) => new Prisma.Decimal(v)

async function buildReceiptContentInTx(
  tx: Tx,
  purchaseId: string
): Promise<{
  content: ReceiptContent
  deliveryId: string
  signatureId: string | null
  createdById: string
}> {
  const p = await tx.chipPurchase.findUnique({
    where: { id: purchaseId },
    select: {
      id: true,
      folio: true,
      status: true,
      purchaseType: true,
      rebuyNumber: true,
      nominalAmount: true,
      confirmedAt: true,
      player: { select: { id: true, name: true } },
      session: { select: { id: true, folio: true } },
      table: { select: { id: true, name: true } },
      confirmedBy: { select: { id: true, name: true } },
      delivery: {
        select: {
          id: true,
          nominalAmount: true,
          confirmedPayments: true,
          pendingTransfers: true,
          outstandingAmount: true,
          inventoryOperationId: true,
          signatureId: true,
          deliveredAt: true,
          deliveredById: true,
          deliveredBy: { select: { name: true } },
          signature: {
            select: {
              id: true,
              signedAt: true,
              snapshot: { select: { payloadHash: true } },
            },
          },
        },
      },
      authorizations: {
        where: { status: "USED" },
        select: { partnerNameSnapshot: true, authorizationChannel: true },
      },
      payments: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          method: true,
          amount: true,
          status: true,
          terminalReference: true,
          financialTransaction: { select: { folio: true } },
          bankTransfer: {
            select: { status: true, confirmedAmount: true, verifiedAt: true },
          },
        },
      },
    },
  })
  if (!p) throw new NotFoundError("Compra no encontrada")
  if (p.status !== "CONFIRMED" && p.status !== "REVERSED")
    throw new BusinessRuleError(
      "El comprobante solo existe para compras con entrega confirmada."
    )
  const d = p.delivery
  if (!d || !p.purchaseType)
    throw new BusinessRuleError("La compra no tiene entrega registrada.")
  const deliveredAt = d.deliveredAt
  // Pagos que contaban AL ENTREGAR (una verificación posterior no altera el comprobante).
  const payments = p.payments
    .filter((x) => {
      const effect = paymentEffect({
        id: x.id,
        method: x.method,
        amount: dec(x.amount),
        status: x.status,
        transferStatus: x.bankTransfer?.status ?? null,
        transferConfirmedAmount: x.bankTransfer?.confirmedAmount
          ? dec(x.bankTransfer.confirmedAmount)
          : null,
      })
      if (effect !== "CONFIRMED") return false
      if (x.method === "BANK_TRANSFER")
        return Boolean(
          x.bankTransfer?.verifiedAt && x.bankTransfer.verifiedAt <= deliveredAt
        )
      return true
    })
    .map((x) => ({
      method: x.method,
      amount: effectiveAmount({
        id: x.id,
        method: x.method,
        amount: dec(x.amount),
        status: x.status,
        transferStatus: x.bankTransfer?.status ?? null,
        transferConfirmedAmount: x.bankTransfer?.confirmedAmount
          ? dec(x.bankTransfer.confirmedAmount)
          : null,
      }).toFixed(2),
      reference: x.financialTransaction?.folio ?? null,
    }))
  const partner = p.authorizations[0] ?? null
  const content: ReceiptContent = {
    receiptFormat: "1",
    purchaseId: p.id,
    folio: p.folio,
    confirmedAt: (p.confirmedAt ?? deliveredAt).toISOString(),
    player: { id: p.player.id, name: p.player.name },
    session: { id: p.session.id, folio: p.session.folio },
    table: { id: p.table.id, name: p.table.name },
    purchaseType: p.purchaseType,
    rebuyNumber: p.rebuyNumber,
    purchaseLabel: purchaseTypeLabel(p.purchaseType, p.rebuyNumber),
    nominalAmount: dec(d.nominalAmount).toFixed(2),
    payments,
    confirmedPayments: dec(d.confirmedPayments).toFixed(2),
    pendingTransfers: dec(d.pendingTransfers).toFixed(2),
    initialCredit: dec(d.outstandingAmount).toFixed(2),
    partner: partner
      ? {
          name: partner.partnerNameSnapshot,
          channel: partner.authorizationChannel,
        }
      : null,
    deliveryStatus: "DELIVERED",
    deliveredBy: d.deliveredBy.name,
    deliveredAt: deliveredAt.toISOString(),
    signature: d.signature
      ? {
          signatureId: d.signature.id,
          signedAt: d.signature.signedAt.toISOString(),
          snapshotHash: d.signature.snapshot.payloadHash,
        }
      : null,
    operationReference: {
      deliveryId: d.id,
      inventoryOperationId: d.inventoryOperationId,
    },
  }
  return {
    content,
    deliveryId: d.id,
    signatureId: d.signatureId,
    createdById: d.deliveredById,
  }
}

/** Crea el comprobante de una compra recién confirmada (idempotente). */
export async function createReceiptInTx(
  tx: Tx,
  actor: SessionUser | { id: string },
  purchaseId: string,
  ctx: RequestContext = {}
) {
  const existing = await tx.purchaseReceipt.findUnique({
    where: { purchaseId },
    select: { id: true },
  })
  if (existing) return existing
  const built = await buildReceiptContentInTx(tx, purchaseId)
  const contentHash = canonicalHash(built.content)
  const receipt = await tx.purchaseReceipt.create({
    data: {
      purchaseId,
      deliveryId: built.deliveryId,
      signatureId: built.signatureId,
      content: built.content as unknown as Prisma.InputJsonValue,
      contentHash,
      createdById: built.createdById,
    },
    select: { id: true },
  })
  await recordAudit(
    {
      action: AUDIT_ACTIONS.RECEIPT_CREATED,
      entityType: "PurchaseReceipt",
      entityId: receipt.id,
      actorUserId: actor.id,
      requestId: ctx.requestId,
      metadata: {
        purchaseId,
        folio: built.content.folio,
        playerId: built.content.player.id,
        sessionId: built.content.session.id,
        contentDigest: contentHash,
        signatureId: built.signatureId,
      },
    },
    tx
  )
  return receipt
}

/**
 * Comprobante de una compra. Si la compra se confirmó antes de existir el
 * Módulo 09 (sin comprobante), se genera a partir de la entrega registrada
 * (datos inmutables), nunca para compras no entregadas.
 */
export async function getReceipt(purchaseId: string, viewer: SessionUser) {
  let receipt = await prisma.purchaseReceipt.findUnique({
    where: { purchaseId },
    select: receiptSelect,
  })
  if (!receipt) {
    const purchase = await prisma.chipPurchase.findUnique({
      where: { id: purchaseId },
      select: { status: true },
    })
    if (!purchase) throw new NotFoundError("Compra no encontrada")
    if (purchase.status !== "CONFIRMED")
      throw new BusinessRuleError(
        "El comprobante estará disponible cuando el cajero confirme la entrega."
      )
    await prisma.$transaction((tx) => createReceiptInTx(tx, viewer, purchaseId))
    receipt = await prisma.purchaseReceipt.findUniqueOrThrow({
      where: { purchaseId },
      select: receiptSelect,
    })
  }
  const content = receipt.content as unknown as ReceiptContent
  return {
    id: receipt.id,
    status: receipt.status,
    content,
    contentHash: receipt.contentHash,
    /** Integridad: el contenido coincide con la huella guardada. */
    intact: canonicalHash(content) === receipt.contentHash,
    hasSignature: Boolean(receipt.signatureId),
    createdAt: receipt.createdAt.toISOString(),
    voidedAt: receipt.voidedAt?.toISOString() ?? null,
    voidReason: receipt.voidReason,
    voidReference: receipt.voidReference,
  }
}
export type ReceiptView = Awaited<ReturnType<typeof getReceipt>>

const receiptSelect = {
  id: true,
  status: true,
  content: true,
  contentHash: true,
  signatureId: true,
  createdAt: true,
  voidedAt: true,
  voidReason: true,
  voidReference: true,
} satisfies Prisma.PurchaseReceiptSelect

/**
 * CONTRATO (Módulo 11 — reversos): anula el comprobante conservando el
 * original, la firma y la referencia del reverso. Nunca lo borra.
 */
export async function voidReceiptInTx(
  tx: Tx,
  actor: { id: string },
  purchaseId: string,
  input: { reason: string; reference: string },
  ctx: RequestContext = {}
) {
  const receipt = await tx.purchaseReceipt.findUnique({
    where: { purchaseId },
    select: { id: true, status: true },
  })
  if (!receipt) throw new NotFoundError("Comprobante no encontrado")
  if (receipt.status === "VOIDED") return receipt
  await tx.purchaseReceipt.update({
    where: { id: receipt.id },
    data: {
      status: "VOIDED",
      voidedAt: new Date(),
      voidedById: actor.id,
      voidReason: input.reason,
      voidReference: input.reference,
    },
  })
  await recordAudit(
    {
      action: AUDIT_ACTIONS.RECEIPT_VOIDED,
      entityType: "PurchaseReceipt",
      entityId: receipt.id,
      actorUserId: actor.id,
      requestId: ctx.requestId,
      metadata: {
        purchaseId,
        reason: input.reason,
        reference: input.reference,
      },
    },
    tx
  )
  return { id: receipt.id, status: "VOIDED" as const }
}

export async function recordReceiptEvent(
  actor: SessionUser,
  purchaseId: string,
  event: "DOWNLOADED" | "SHARE_REQUESTED",
  metadata: Record<string, unknown>,
  ctx: RequestContext = {}
) {
  const receipt = await prisma.purchaseReceipt.findUnique({
    where: { purchaseId },
    select: { id: true, status: true },
  })
  if (!receipt) throw new NotFoundError("Comprobante no encontrado")
  await recordAudit({
    action:
      event === "DOWNLOADED"
        ? AUDIT_ACTIONS.RECEIPT_DOWNLOADED
        : AUDIT_ACTIONS.RECEIPT_SHARED_MANUALLY_REQUESTED,
    entityType: "PurchaseReceipt",
    entityId: receipt.id,
    actorUserId: actor.id,
    requestId: ctx.requestId,
    metadata: { purchaseId, receiptStatus: receipt.status, ...metadata },
  })
}
