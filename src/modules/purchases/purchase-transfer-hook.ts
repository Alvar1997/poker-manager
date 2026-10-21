import "server-only"

import { Prisma } from "@/generated/prisma/client"
import { AppError } from "@/lib/errors"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import { invalidatePurchaseSignaturesInTx } from "@/modules/signatures/signature-invalidation"
import {
  summarizePayments,
  type PaymentLike,
} from "@/modules/purchases/purchase.math"

type Tx = Prisma.TransactionClient

/**
 * Integración Módulo 05 ↔ Módulo 08: cuando el cajero, un socio o
 * SUPERADMIN verifica (o rechaza) una transferencia ligada a un pago de
 * compra, se aplica sobre la MISMA obligación (no se crea otra deuda ni
 * otro ingreso):
 *
 * - La compra se bloquea ANTES que la transferencia (mismo orden que la
 *   cancelación de pagos: sin interbloqueos).
 * - Borrador: si con ese importe los pagos superan la compra se rechaza
 *   (sobreaplicación). Compra entregada: se aplica a su deuda (Módulo 10)
 *   y el excedente queda como fondos no aplicados por devolver.
 * - En un borrador, el cambio es material: nueva versión (la autorización
 *   y cualquier firma anteriores dejan de corresponder).
 * - En una compra confirmada la compra no se modifica: la aplicación vive
 *   en el libro de aplicaciones del Módulo 10.
 */

export async function paymentPurchaseId(tx: Tx, paymentId: string) {
  const payment = await tx.purchasePayment.findUnique({
    where: { id: paymentId },
    select: { purchaseId: true },
  })
  return payment?.purchaseId ?? null
}

/**
 * Bloquea la compra dueña del pago y a su jugador (antes de bloquear la
 * transferencia): orden compra → jugador → transferencia → saldos.
 */
export async function lockPurchaseOfPaymentInTx(tx: Tx, paymentId: string) {
  const purchaseId = await paymentPurchaseId(tx, paymentId)
  if (!purchaseId) return null
  const rows = await tx.$queryRaw<
    { playerId: string }[]
  >`SELECT "playerId" FROM "chip_purchases" WHERE "id" = ${purchaseId} FOR UPDATE`
  if (rows[0])
    await tx.$queryRaw`SELECT "id" FROM "players" WHERE "id" = ${rows[0].playerId} FOR UPDATE`
  return purchaseId
}

/**
 * Antes de contabilizar la verificación: cuánto del importe confirmado se
 * puede aplicar. Borrador: se rechaza la sobreaplicación (409). Compra
 * entregada: lo aplicable es el saldo VIGENTE de su deuda (pudo pagarse
 * con abonos); el resto es excedente real (fondos no aplicados), nunca
 * saldo a favor ni una segunda aplicación.
 */
export async function planPurchaseTransferInTx(
  tx: Tx,
  paymentId: string,
  confirmedAmount: Prisma.Decimal
) {
  const payment = await tx.purchasePayment.findUnique({
    where: { id: paymentId },
    select: {
      id: true,
      purchase: {
        select: {
          id: true,
          folio: true,
          status: true,
          nominalAmount: true,
          debt: { select: { id: true } },
          payments: {
            select: {
              id: true,
              method: true,
              amount: true,
              status: true,
              bankTransfer: { select: { status: true, confirmedAmount: true } },
            },
          },
        },
      },
    },
  })
  if (!payment)
    return { applicable: confirmedAmount, excess: new Prisma.Decimal(0) }
  const p = payment.purchase
  if (p.status === "CANCELLED")
    throw new AppError(
      "CONFLICT",
      "La compra de esta transferencia fue cancelada: requiere resolución financiera explícita."
    )
  if (p.status === "CONFIRMED" && p.debt) {
    const { receivableBalance } =
      await import("@/modules/credits/receivable.service")
    const { balance } = await receivableBalance(tx, p.debt.id)
    const { splitApplicable } = await import("@/modules/credits/credit.math")
    return splitApplicable(confirmedAmount, balance)
  }
  const others: PaymentLike[] = p.payments
    .filter((x) => x.id !== payment.id)
    .map((x) => ({
      id: x.id,
      method: x.method,
      amount: new Prisma.Decimal(x.amount),
      status: x.status,
      transferStatus: x.bankTransfer?.status ?? null,
      transferConfirmedAmount: x.bankTransfer?.confirmedAmount
        ? new Prisma.Decimal(x.bankTransfer.confirmedAmount)
        : null,
    }))
  const f = summarizePayments(new Prisma.Decimal(p.nominalAmount), others)
  if (f.confirmedPayments.add(confirmedAmount).greaterThan(f.nominalAmount)) {
    const excess = f.confirmedPayments.add(confirmedAmount).sub(f.nominalAmount)
    throw new AppError(
      "CONFLICT",
      `Sobreaplicación: con esta transferencia la compra ${p.folio} quedaría pagada de más por $${excess.toFixed(2)}. El excedente requiere un tratamiento explícito (devolución) antes de verificarla.`,
      { excess: excess.toFixed(2) }
    )
  }
  return { applicable: confirmedAmount, excess: new Prisma.Decimal(0) }
}

/**
 * Después de contabilizar (o al rechazar). Borrador: cambio material
 * (firma invalidada, autorización reemplazada, nueva versión). Compra
 * entregada y confirmada: se aplica a SU deuda (sin FIFO) y el excedente
 * queda como fondos no aplicados por devolver.
 */
export async function applyPurchaseTransferResolutionInTx(
  tx: Tx,
  actor: SessionUser | { id: string },
  input: {
    paymentId: string
    outcome: "CONFIRMED" | "REJECTED"
    confirmedAmount?: Prisma.Decimal
    applicable?: Prisma.Decimal
    excess?: Prisma.Decimal
    bankTransferId?: string
  },
  ctx: RequestContext = {}
) {
  const payment = await tx.purchasePayment.findUnique({
    where: { id: input.paymentId },
    select: {
      id: true,
      purchase: {
        select: {
          id: true,
          folio: true,
          status: true,
          playerId: true,
          debt: { select: { id: true } },
        },
      },
    },
  })
  if (!payment) return
  const p = payment.purchase
  if (
    input.outcome === "CONFIRMED" &&
    p.status === "CONFIRMED" &&
    p.debt &&
    input.applicable !== undefined
  ) {
    const { allocatePurchasePaymentInTx } =
      await import("@/modules/credits/receivable.service")
    if (input.applicable.greaterThan(0))
      await allocatePurchasePaymentInTx(
        tx,
        actor.id,
        {
          receivableId: p.debt.id,
          playerId: p.playerId,
          purchasePaymentId: payment.id,
          amount: input.applicable,
        },
        ctx
      )
    if (input.excess && input.excess.greaterThan(0) && input.bankTransferId) {
      await tx.unappliedPlayerFunds.create({
        data: {
          playerId: p.playerId,
          amount: input.excess,
          reason: `Transferencia de la compra ${p.folio} verificada cuando su deuda ya estaba cubierta`,
          bankTransferId: input.bankTransferId,
          purchasePaymentId: payment.id,
          createdById: actor.id,
        },
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.UNAPPLIED_FUNDS_RECORDED,
          entityType: "ChipPurchase",
          entityId: p.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            playerId: p.playerId,
            excess: input.excess.toFixed(2),
            bankTransferId: input.bankTransferId,
          },
        },
        tx
      )
    }
  }
  if (p.status === "DRAFT" || p.status === "READY_FOR_DELIVERY") {
    // Cambio material del resumen firmado: la firma anterior deja de valer.
    await invalidatePurchaseSignaturesInTx(
      tx,
      {
        purchaseId: p.id,
        actorId: actor.id,
        reason:
          input.outcome === "CONFIRMED"
            ? "Transferencia verificada: cambió el resumen financiero"
            : "Transferencia rechazada: cambió el resumen financiero",
      },
      ctx
    )
    await tx.purchaseCreditAuthorization.updateMany({
      where: { purchaseId: p.id, status: "ACTIVE" },
      data: { status: "SUPERSEDED" },
    })
    await tx.chipPurchase.update({
      where: { id: p.id },
      data: { version: { increment: 1 } },
    })
  }
  await recordAudit(
    {
      action: AUDIT_ACTIONS.PURCHASE_TRANSFER_APPLIED,
      entityType: "ChipPurchase",
      entityId: p.id,
      actorUserId: actor.id,
      requestId: ctx.requestId,
      metadata: {
        folio: p.folio,
        paymentId: payment.id,
        outcome: input.outcome,
        confirmedAmount: input.confirmedAmount?.toFixed(2) ?? null,
        purchaseStatus: p.status,
      },
    },
    tx
  )
}
