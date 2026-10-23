import "server-only"

import { Prisma } from "@/generated/prisma/client"
import { BusinessRuleError, ConflictError, NotFoundError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import type { Tx } from "@/modules/cash/ledger"
import {
  linkExecutionInTx,
  requireApprovedCorrectionInTx,
} from "@/modules/corrections/correction.service"
import { lockPlayerInTx } from "@/modules/credits/receivable.service"
import { confirmNominalChipReturnInTx } from "@/modules/inventory/reservation.service"
import type { PaymentLike } from "@/modules/purchases/purchase.math"
import { issueFolio } from "@/modules/settings/folio.service"
import { voidReceiptInTx } from "@/modules/signatures/receipt.service"

import { createSpecialReceiptInTx } from "./special-evidence"
import {
  auditFailure,
  createSpecialPayableInTx,
  payableView,
  SPECIAL_TX,
} from "./special-payout.service"
import {
  dec,
  fmt,
  planPurchaseReversal,
  type AllocationLite,
  type PurchaseReversalPlan,
} from "./special.math"

/**
 * 16.2 — Reverso COMPLETO de una compra confirmada (entregada).
 *
 * Nunca muta la compra original salvo su estado final REVERSED (el trigger
 * solo lo permite con un reverso registrado). Efectos REALES, en UNA
 * transacción y solo si todo es ejecutable:
 *   1. Recepción FÍSICA de las fichas por el valor completo de la compra
 *      (`confirmNominalChipReturnInTx`): sin ella el reverso se BLOQUEA.
 *   2. Extinción NO monetaria del saldo de su deuda (aplicación
 *      PURCHASE_REVERSAL; no es un pago ni entra dinero).
 *   3. Obligación de reembolso por el dinero REALMENTE pagado (efectivo,
 *      terminal aprobada, transferencias verificadas, abonos y
 *      compensaciones aplicados a esa deuda). Se paga aparte (pagos reales).
 *   4. La solicitud de corrección aprobada (Módulo 15) pasa a EXECUTED.
 * Una sesión CLOSED no se reabre ni se toca su caja: el reembolso sale de
 * custodia o banco (o de la caja de su sesión solo si sigue OPEN).
 */

async function loadFacts(db: Tx | typeof prisma, purchaseId: string) {
  const p = await db.chipPurchase.findUnique({
    where: { id: purchaseId },
    select: {
      id: true,
      folio: true,
      status: true,
      version: true,
      nominalAmount: true,
      sessionId: true,
      tableId: true,
      participationId: true,
      playerId: true,
      confirmedAt: true,
      fundingSource: true,
      player: { select: { id: true, name: true } },
      session: { select: { id: true, folio: true, status: true } },
      table: { select: { name: true } },
      payments: {
        select: {
          id: true,
          method: true,
          amount: true,
          status: true,
          bankTransfer: { select: { status: true, confirmedAmount: true } },
        },
      },
      debt: {
        select: {
          id: true,
          originalAmount: true,
          allocations: { select: { kind: true, source: true, amount: true } },
        },
      },
      reversal: { select: { id: true } },
    },
  })
  if (!p) throw new NotFoundError("Compra no encontrada")
  // Módulo 17: una compra financiada por la casa no se revierte con este
  // proceso (reembolsaría dinero que el jugador no pagó); se corrige en la
  // sección privada (ajuste auditado de la jugada).
  if (p.fundingSource === "HOUSE")
    throw new BusinessRuleError(
      "Esta compra tiene un registro administrativo: su corrección se realiza desde Administración."
    )
  const settlements = await db.playerSettlement.count({
    where: {
      participationId: p.participationId,
      status: { notIn: ["CANCELLED", "REVERSED"] },
    },
  })
  const payments: PaymentLike[] = p.payments.map((x) => ({
    id: x.id,
    method: x.method,
    amount: dec(x.amount),
    status: x.status,
    transferStatus: x.bankTransfer?.status ?? null,
    transferConfirmedAmount: x.bankTransfer?.confirmedAmount
      ? dec(x.bankTransfer.confirmedAmount)
      : null,
  }))
  return { p, payments, settled: settlements > 0 }
}

function planFor(
  f: Awaited<ReturnType<typeof loadFacts>>,
  input: {
    approvedCorrection: boolean
    physicalReturnConfirmed: boolean
    returnedNominal: string | null
  }
) {
  return planPurchaseReversal({
    status: f.p.status,
    nominal: f.p.nominalAmount,
    payments: f.payments,
    debt: f.p.debt
      ? {
          original: f.p.debt.originalAmount,
          allocations: f.p.debt.allocations as AllocationLite[],
        }
      : null,
    alreadyReversed: Boolean(f.p.reversal),
    approvedCorrection: input.approvedCorrection,
    physicalReturn: {
      confirmed: input.physicalReturnConfirmed,
      nominal: input.returnedNominal ? dec(input.returnedNominal) : null,
    },
    sessionStatus: f.p.session.status,
    participationSettled: f.settled,
  })
}

async function approvedCorrectionFor(purchaseId: string) {
  return prisma.correctionRequest.findFirst({
    where: {
      type: "PURCHASE_REVERSAL",
      targetId: purchaseId,
      status: { in: ["APPROVED", "FAILED"] },
    },
    orderBy: { requestedAt: "desc" },
    select: { id: true, folio: true, status: true },
  })
}

/** Vista previa SIN escrituras: clasificación, bloqueos y efectos exactos. */
export async function previewPurchaseReversal(
  purchaseId: string,
  input: { physicalReturnConfirmed?: boolean; returnedNominal?: string } = {}
) {
  const f = await loadFacts(prisma, purchaseId)
  const correction = await approvedCorrectionFor(purchaseId)
  const plan = planFor(f, {
    approvedCorrection: Boolean(correction),
    physicalReturnConfirmed: input.physicalReturnConfirmed ?? false,
    returnedNominal: input.returnedNominal ?? null,
  })
  return {
    purchase: {
      id: f.p.id,
      folio: f.p.folio,
      status: f.p.status,
      version: f.p.version,
      nominal: fmt(f.p.nominalAmount),
      player: f.p.player,
      session: f.p.session,
      table: f.p.table.name,
      confirmedAt: f.p.confirmedAt?.toISOString() ?? null,
    },
    correction,
    plan,
  }
}

export async function executePurchaseReversal(
  actor: SessionUser,
  purchaseId: string,
  input: {
    correctionId: string
    expectedVersion: number
    physicalReturnConfirmed: boolean
    returnedNominal: string
    reason: string
    idempotencyKey: string
  },
  ctx: RequestContext = {}
) {
  const previous = await prisma.purchaseReversal.findUnique({
    where: { purchaseId },
    select: { id: true, idempotencyKey: true },
  })
  if (previous) {
    if (previous.idempotencyKey === input.idempotencyKey)
      return { reversalId: previous.id, replayed: true }
    throw new BusinessRuleError("La compra ya fue revertida.")
  }
  let blockedPlan: PurchaseReversalPlan | null = null
  try {
    return await prisma.$transaction(async (tx) => {
      // Orden: sesión (FOR SHARE) → compra → participación → jugador →
      // solicitud → inventario compartido → saldos.
      const head = await tx.chipPurchase.findUnique({
        where: { id: purchaseId },
        select: { sessionId: true, participationId: true, playerId: true },
      })
      if (!head) throw new NotFoundError("Compra no encontrada")
      await tx.$queryRaw`SELECT "id" FROM "poker_sessions" WHERE "id" = ${head.sessionId} FOR SHARE`
      await tx.$queryRaw`SELECT "id" FROM "chip_purchases" WHERE "id" = ${purchaseId} FOR UPDATE`
      await tx.$queryRaw`SELECT "id" FROM "table_participations" WHERE "id" = ${head.participationId} FOR UPDATE`
      await lockPlayerInTx(tx, head.playerId)
      const correction = await requireApprovedCorrectionInTx(
        tx,
        input.correctionId,
        { type: "PURCHASE_REVERSAL", targetId: purchaseId }
      )
      const f = await loadFacts(tx, purchaseId)
      if (f.p.version !== input.expectedVersion)
        throw new ConflictError("La compra cambió mientras la revisabas.")
      const plan = planFor(f, {
        approvedCorrection: true,
        physicalReturnConfirmed: input.physicalReturnConfirmed,
        returnedNominal: input.returnedNominal,
      })
      if (!plan.executable || !plan.effects) {
        blockedPlan = plan
        throw new BusinessRuleError(plan.blockers.join(" "), {
          classification: plan.classification,
          blockers: plan.blockers,
        })
      }
      const effects = plan.effects
      const nominal = f.p.nominalAmount
      // 1. Recepción física (una vez; la base impide exceder la circulación).
      const op = await confirmNominalChipReturnInTx(
        tx,
        actor,
        {
          amount: nominal.toFixed(2),
          referenceType: "PurchaseReversal",
          referenceId: purchaseId,
          idempotencyKey: `purchase-reversal-return:${purchaseId}`,
          playerId: f.p.playerId,
          tableId: f.p.tableId,
          // Solo se atribuye a la sesión si sigue abierta; una sesión
          // cerrada no cambia (el regreso ocurre hoy, fuera de ella).
          sessionId: f.p.session.status === "OPEN" ? f.p.sessionId : null,
        },
        ctx
      )
      const folio = await issueFolio(tx, "PURCHASE_REVERSAL")
      const extinguish = dec(effects.extinguish)
      const refund = dec(effects.refund)
      const reversal = await tx.purchaseReversal.create({
        data: {
          folio,
          purchaseId,
          correctionId: correction.id,
          chipOperationId: op.operationId,
          returnedNominal: nominal,
          extinguishedAmount: extinguish,
          refundAmount: refund,
          plan: plan as unknown as Prisma.InputJsonValue,
          reason: input.reason.trim(),
          executedById: actor.id,
          idempotencyKey: input.idempotencyKey,
        },
      })
      // 2. Extinción no monetaria del saldo (si lo había).
      if (extinguish.greaterThan(0) && f.p.debt)
        await tx.paymentAllocation.create({
          data: {
            receivableId: f.p.debt.id,
            playerId: f.p.playerId,
            kind: "APPLICATION",
            source: "PURCHASE_REVERSAL",
            amount: extinguish,
            allocationOrder: 1,
            purchaseReversalId: reversal.id,
            createdById: actor.id,
          },
        })
      // 3. Reembolso del dinero REALMENTE pagado (obligación; se paga aparte).
      const payable = refund.greaterThan(0)
        ? await createSpecialPayableInTx(tx, actor, {
            kind: "PURCHASE_REFUND",
            sourceType: "PurchaseReversal",
            sourceId: reversal.id,
            playerId: f.p.playerId,
            beneficiaryName: f.p.player.name,
            sessionId: f.p.sessionId,
            amount: refund,
          })
        : null
      // 4. Estado final de la compra (el trigger exige el reverso registrado).
      await tx.chipPurchase.update({
        where: { id: purchaseId },
        data: { status: "REVERSED", version: { increment: 1 } },
      })
      // Comprobante original: se marca ANULADO con referencia al reverso
      // (Módulo 09); su contenido y su firma no cambian.
      await voidReceiptInTx(
        tx,
        actor,
        purchaseId,
        { reason: input.reason.trim(), reference: folio },
        ctx
      )
      await createSpecialReceiptInTx(tx, actor, {
        kind: "PURCHASE_REVERSAL",
        sourceKey: `purchase-reversal:${reversal.id}`,
        kicker: `Reverso ${folio} · compra ${f.p.folio}`,
        title: "Reverso de compra",
        lines: [
          { label: "Jugador", value: f.p.player.name },
          { label: "Sesión", value: f.p.session.folio },
          {
            label: "Fichas devueltas",
            value: `$${fmt(nominal)}`,
            strong: true,
          },
          {
            label: "Deuda extinguida (sin dinero)",
            value: `$${fmt(extinguish)}`,
          },
          {
            label: "Reembolso a pagar",
            value: `$${fmt(refund)}`,
            strong: true,
          },
          { label: "Reembolsado", value: "$0.00" },
        ],
        footer:
          "La compra original, su firma y su comprobante se conservan. El reembolso solo cuenta cuando se paga.",
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.PURCHASE_REVERSAL_EXECUTED,
          entityType: "ChipPurchase",
          entityId: purchaseId,
          actorUserId: actor.id,
          actorRole: actor.role,
          requestId: ctx.requestId,
          sessionId: f.p.sessionId,
          playerId: f.p.playerId,
          idempotencyKey: input.idempotencyKey,
          reason: input.reason,
          amount: fmt(nominal),
          metadata: {
            folio,
            purchaseFolio: f.p.folio,
            reversalId: reversal.id,
            correctionId: correction.id,
            chipOperationId: op.operationId,
            extinguished: fmt(extinguish),
            refund: fmt(refund),
            payableId: payable?.id ?? null,
            sessionStatus: f.p.session.status,
          },
        },
        tx
      )
      await linkExecutionInTx(
        tx,
        actor,
        correction,
        reversal.id,
        refund.greaterThan(0)
          ? `Reverso ejecutado; reembolso de $${fmt(refund)} pendiente de pago.`
          : "Reverso ejecutado; sin reembolso (no hubo pagos).",
        ctx
      )
      return { reversalId: reversal.id, replayed: false }
    }, SPECIAL_TX)
  } catch (error) {
    if (blockedPlan) {
      const plan = blockedPlan as PurchaseReversalPlan
      await recordAudit({
        action: AUDIT_ACTIONS.PURCHASE_REVERSAL_BLOCKED,
        entityType: "ChipPurchase",
        entityId: purchaseId,
        actorUserId: actor.id,
        actorRole: actor.role,
        requestId: ctx.requestId,
        result: "FAILURE",
        reason: plan.blockers.join(" ").slice(0, 500),
        metadata: { classification: plan.classification },
      }).catch(() => undefined)
    } else await auditFailure(actor, "ChipPurchase", purchaseId, error, ctx)
    throw error
  }
}

export async function getPurchaseReversal(id: string) {
  const r = await prisma.purchaseReversal.findUnique({
    where: { id },
    include: {
      purchase: {
        select: {
          id: true,
          folio: true,
          nominalAmount: true,
          player: { select: { id: true, name: true } },
          session: { select: { id: true, folio: true, status: true } },
        },
      },
      correction: { select: { id: true, folio: true, status: true } },
      executedBy: { select: { name: true } },
    },
  })
  if (!r) throw new NotFoundError("Reverso no encontrado")
  const [payable, receipts] = await Promise.all([
    prisma.specialPayable.findUnique({
      where: { kind_sourceId: { kind: "PURCHASE_REFUND", sourceId: id } },
      include: { payouts: { orderBy: { sequence: "asc" } } },
    }),
    prisma.specialOperationReceipt.findMany({
      where: {
        OR: [
          { sourceKey: `purchase-reversal:${id}` },
          { sourceKey: { startsWith: `payout:purchase-refund:${id}:` } },
        ],
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, kind: true, title: true, createdAt: true },
    }),
  ])
  return {
    id: r.id,
    folio: r.folio,
    purchase: { ...r.purchase, nominalAmount: fmt(r.purchase.nominalAmount) },
    correction: r.correction,
    returned: fmt(r.returnedNominal),
    extinguished: fmt(r.extinguishedAmount),
    refund: fmt(r.refundAmount),
    reason: r.reason,
    executedBy: r.executedBy.name,
    executedAt: r.executedAt.toISOString(),
    payable: payable ? payableView(payable) : null,
    receipts: receipts.map((x) => ({
      ...x,
      createdAt: x.createdAt.toISOString(),
    })),
  }
}
