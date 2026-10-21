import "server-only"

import { Prisma } from "@/generated/prisma/client"
import { canonicalHash } from "@/lib/canonical-json"
import { BusinessRuleError, NotFoundError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import { receivableBalance } from "@/modules/credits/receivable.service"
import { readEvidence } from "@/modules/signatures/evidence-storage"
import { renderDocumentPng } from "@/modules/signatures/receipt-image"
import { receiptDate } from "@/modules/signatures/receipt.content"
import { dec, fmt, type Tx } from "@/modules/settlements/settlement-core"
import {
  settlementReceiptLines,
  settlementReceiptTitle,
  type SettlementReceiptContent,
} from "@/modules/settlements/settlement-receipt.content"

/**
 * Comprobantes DIGITALES de liquidación (no PDF), con el generador PNG del
 * Módulo 09. Se crean en la MISMA transacción que la operación que
 * documentan:
 *
 *  - RECEPTION: al confirmar la recepción de fichas (uno por liquidación).
 *  - PAYOUT: anexo por cada desembolso ejecutado DESPUÉS de la recepción.
 *
 * Contenido = snapshot inmutable con huella (trigger): un pago posterior
 * nunca altera el comprobante de recepción. Solo pasan a VOIDED por reverso.
 */

async function buildContentInTx(
  tx: Tx,
  settlementId: string,
  kind: "RECEPTION" | "PAYOUT",
  payoutId: string | null,
  issuedBy: { id: string; name: string }
): Promise<SettlementReceiptContent> {
  const s = await tx.playerSettlement.findUniqueOrThrow({
    where: { id: settlementId },
    select: {
      id: true,
      folio: true,
      status: true,
      returnedNominalAmount: true,
      offsetDecision: true,
      offsetAmount: true,
      netPayoutAmount: true,
      debtBalanceSnapshot: true,
      chipReturnOperationId: true,
      receivedAt: true,
      player: { select: { id: true, name: true } },
      session: { select: { id: true, folio: true } },
      table: { select: { id: true, name: true } },
      receivedBy: { select: { name: true } },
      signature: {
        select: {
          id: true,
          signedAt: true,
          snapshot: { select: { payloadHash: true } },
        },
      },
      allocations: {
        where: { kind: "APPLICATION" },
        orderBy: { allocationOrder: "asc" },
        select: {
          allocationOrder: true,
          amount: true,
          receivableId: true,
          receivable: {
            select: {
              purchase: {
                select: { folio: true, table: { select: { name: true } } },
              },
            },
          },
        },
      },
      payouts: {
        orderBy: { sequence: "asc" },
        select: {
          id: true,
          sequence: true,
          method: true,
          funding: true,
          amount: true,
          status: true,
          bankReference: true,
          executedAt: true,
          financialTransaction: { select: { folio: true } },
        },
      },
    },
  })
  if (
    (s.status !== "PENDING_PAYOUT" && s.status !== "COMPLETED") ||
    !s.receivedAt ||
    !s.signature ||
    s.offsetAmount === null ||
    s.netPayoutAmount === null ||
    s.debtBalanceSnapshot === null
  )
    throw new BusinessRuleError(
      "El comprobante existe solo con la recepción de fichas confirmada."
    )
  const toPayout = (p: (typeof s.payouts)[number]) => ({
    sequence: p.sequence,
    method: p.method,
    funding: p.funding,
    amount: fmt(dec(p.amount)),
    reference: p.bankReference ?? p.financialTransaction?.folio ?? null,
    executedAt: (p.executedAt ?? new Date()).toISOString(),
  })
  const executed = s.payouts.filter((p) => p.status === "EXECUTED")
  const paid = executed.reduce((acc, p) => acc.add(p.amount), dec(0))
  const inTransit = s.payouts
    .filter((p) => p.status === "PENDING")
    .reduce((acc, p) => acc.add(p.amount), dec(0))
  const net = dec(s.netPayoutAmount)
  const allocations = []
  for (const a of s.allocations) {
    const { balance } = await receivableBalance(tx, a.receivableId)
    allocations.push({
      order: a.allocationOrder,
      purchaseFolio: a.receivable.purchase.folio,
      tableName: a.receivable.purchase.table.name,
      amount: fmt(dec(a.amount)),
      balanceAfter: fmt(balance),
    })
  }
  const payout = payoutId ? s.payouts.find((p) => p.id === payoutId) : null
  if (payoutId && (!payout || payout.status !== "EXECUTED"))
    throw new BusinessRuleError("El anexo solo documenta un pago ejecutado.")
  return {
    receiptFormat: "1",
    kind,
    settlementId: s.id,
    folio: s.folio,
    issuedAt: new Date().toISOString(),
    player: s.player,
    session: s.session,
    table: s.table,
    returnedNominalAmount: fmt(dec(s.returnedNominalAmount)),
    offsetDecision: s.offsetDecision,
    offsetAmount: fmt(dec(s.offsetAmount)),
    allocations,
    remainingDebt: fmt(dec(s.debtBalanceSnapshot).sub(dec(s.offsetAmount))),
    netPayoutAmount: fmt(net),
    paidAtIssue: fmt(paid),
    inTransitAtIssue: fmt(inTransit),
    pendingAtIssue: fmt(net.sub(paid)),
    payouts: executed.map(toPayout),
    payout: payout ? toPayout(payout) : null,
    settlementStatus: s.status,
    receivedBy: s.receivedBy?.name ?? "",
    receivedAt: s.receivedAt.toISOString(),
    issuedBy: issuedBy.name,
    signature: {
      signatureId: s.signature.id,
      signedAt: s.signature.signedAt.toISOString(),
      snapshotDigest: s.signature.snapshot.payloadHash,
    },
    chipReturnOperationId: s.chipReturnOperationId,
  }
}

/** Crea el comprobante (idempotente por liquidación o por desembolso). */
export async function createSettlementReceiptInTx(
  tx: Tx,
  actor: SessionUser,
  settlementId: string,
  target: { kind: "RECEPTION" } | { kind: "PAYOUT"; payoutId: string },
  ctx: RequestContext = {}
) {
  const existing =
    target.kind === "RECEPTION"
      ? await tx.settlementReceipt.findFirst({
          where: { settlementId, kind: "RECEPTION" },
          select: { id: true },
        })
      : await tx.settlementReceipt.findUnique({
          where: { payoutId: target.payoutId },
          select: { id: true },
        })
  if (existing) return existing
  const content = await buildContentInTx(
    tx,
    settlementId,
    target.kind,
    target.kind === "PAYOUT" ? target.payoutId : null,
    { id: actor.id, name: actor.name }
  )
  const contentHash = canonicalHash(content)
  const receipt = await tx.settlementReceipt.create({
    data: {
      settlementId,
      kind: target.kind,
      payoutId: target.kind === "PAYOUT" ? target.payoutId : null,
      content: content as unknown as Prisma.InputJsonValue,
      contentHash,
      createdById: actor.id,
    },
    select: { id: true },
  })
  await recordAudit(
    {
      action: AUDIT_ACTIONS.SETTLEMENT_RECEIPT_CREATED,
      entityType: "SettlementReceipt",
      entityId: receipt.id,
      actorUserId: actor.id,
      requestId: ctx.requestId,
      metadata: {
        settlementId,
        folio: content.folio,
        kind: target.kind,
        payoutId: target.kind === "PAYOUT" ? target.payoutId : null,
        playerId: content.player.id,
        sessionId: content.session.id,
        contentDigest: contentHash,
        paidAtIssue: content.paidAtIssue,
        pendingAtIssue: content.pendingAtIssue,
      },
    },
    tx
  )
  return receipt
}

/** Anula los comprobantes de una liquidación revertida (se conservan). */
export async function voidSettlementReceiptsInTx(
  tx: Tx,
  settlementId: string,
  reason: string
) {
  await tx.settlementReceipt.updateMany({
    where: { settlementId, status: "AVAILABLE" },
    data: { status: "VOIDED", voidedAt: new Date(), voidReason: reason },
  })
}

function receiptView(r: {
  id: string
  kind: "RECEPTION" | "PAYOUT"
  status: "AVAILABLE" | "VOIDED"
  content: Prisma.JsonValue
  contentHash: string
  createdAt: Date
  voidedAt: Date | null
  voidReason: string | null
}) {
  const content = r.content as unknown as SettlementReceiptContent
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    content,
    contentHash: r.contentHash,
    /** Integridad: el contenido coincide con la huella guardada. */
    intact: canonicalHash(content) === r.contentHash,
    createdAt: r.createdAt.toISOString(),
    voidedAt: r.voidedAt?.toISOString() ?? null,
    voidReason: r.voidReason,
  }
}
export type SettlementReceiptView = ReturnType<typeof receiptView>

const receiptSelect = {
  id: true,
  kind: true,
  status: true,
  content: true,
  contentHash: true,
  createdAt: true,
  voidedAt: true,
  voidReason: true,
} satisfies Prisma.SettlementReceiptSelect

/** Comprobante de recepción y anexos de pago de una liquidación. */
export async function getSettlementReceipts(settlementId: string) {
  const s = await prisma.playerSettlement.findUnique({
    where: { id: settlementId },
    select: {
      status: true,
      receipts: { orderBy: { createdAt: "asc" }, select: receiptSelect },
    },
  })
  if (!s) throw new NotFoundError("Liquidación no encontrada")
  const reception = s.receipts.find((r) => r.kind === "RECEPTION")
  if (!reception)
    throw new BusinessRuleError(
      "El comprobante estará disponible cuando el cajero confirme la recepción de las fichas."
    )
  return {
    reception: receiptView(reception),
    annexes: s.receipts.filter((r) => r.kind === "PAYOUT").map(receiptView),
  }
}

async function signaturePngOf(settlementId: string) {
  const s = await prisma.playerSettlement.findUnique({
    where: { id: settlementId },
    select: { signature: { select: { fileId: true, imageHash: true } } },
  })
  if (!s?.signature) return null
  const evidence = await readEvidence(s.signature.fileId)
  return evidence && evidence.sha256 === s.signature.imageHash
    ? evidence.bytes
    : null
}

/** PNG determinista desde el snapshot (recepción por defecto o un anexo). */
export async function renderSettlementReceiptPng(
  settlementId: string,
  receiptId: string | null
) {
  const { reception, annexes } = await getSettlementReceipts(settlementId)
  const r = receiptId
    ? [reception, ...annexes].find((x) => x.id === receiptId)
    : reception
  if (!r) throw new NotFoundError("Comprobante no encontrado")
  const c = r.content
  const png = await renderDocumentPng({
    kicker:
      c.kind === "PAYOUT"
        ? "Poker Manager · Anexo de pago de liquidación"
        : "Poker Manager · Comprobante de liquidación",
    title: settlementReceiptTitle(c),
    date: receiptDate(c.issuedAt),
    voided: r.status === "VOIDED",
    okLabel:
      c.kind === "PAYOUT"
        ? "Pago ejecutado"
        : c.settlementStatus === "COMPLETED"
          ? "Pagada"
          : "Pendiente de pago",
    lines: settlementReceiptLines(c),
    signaturePng:
      c.kind === "RECEPTION" ? await signaturePngOf(settlementId) : null,
    signatureLabel: "Firma del jugador (liquidación)",
    footer:
      "Fichas por valor nominal, sin denominaciones. Los pagos posteriores generan anexos.",
  })
  const name =
    c.kind === "PAYOUT" && c.payout
      ? `liquidacion-${c.folio}-pago-${c.payout.sequence}.png`
      : `liquidacion-${c.folio}.png`
  return { png, filename: name, receiptId: r.id }
}

export async function recordSettlementReceiptEvent(
  actor: SessionUser,
  settlementId: string,
  receiptId: string | null,
  event: "DOWNLOADED" | "SHARE_REQUESTED",
  metadata: Record<string, unknown>,
  ctx: RequestContext = {}
) {
  const r = await prisma.settlementReceipt.findFirst({
    where: receiptId
      ? { id: receiptId, settlementId }
      : { settlementId, kind: "RECEPTION" },
    select: { id: true, kind: true, status: true },
  })
  if (!r) throw new NotFoundError("Comprobante no encontrado")
  await recordAudit({
    action:
      event === "DOWNLOADED"
        ? AUDIT_ACTIONS.RECEIPT_DOWNLOADED
        : AUDIT_ACTIONS.RECEIPT_SHARED_MANUALLY_REQUESTED,
    entityType: "SettlementReceipt",
    entityId: r.id,
    actorUserId: actor.id,
    requestId: ctx.requestId,
    metadata: {
      settlementId,
      kind: r.kind,
      receiptStatus: r.status,
      ...metadata,
    },
  })
}
