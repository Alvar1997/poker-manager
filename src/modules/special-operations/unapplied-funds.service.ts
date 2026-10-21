import "server-only"

import type { Prisma } from "@/generated/prisma/client"
import { NotFoundError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import {
  linkExecutionInTx,
  requireApprovedCorrectionInTx,
} from "@/modules/corrections/correction.service"
import { lockPlayerInTx } from "@/modules/credits/receivable.service"

import { createSpecialReceiptInTx } from "./special-evidence"
import {
  auditFailure,
  createSpecialPayableInTx,
  payableView,
  SPECIAL_TX,
} from "./special-payout.service"
import { fmt, unappliedStatusFor } from "./special.math"

/**
 * 16.4 — Devolución de fondos NO aplicados (dinero real recibido que excedió
 * la deuda; Módulo 10 lo registró en UNAPPLIED_PLAYER_FUNDS). Nunca es saldo
 * a favor ni se aplica a deudas futuras.
 *
 *   PENDING_REVIEW → (corrección UNAPPLIED_FUNDS_RETURN aprobada) obligación
 *   de devolución → PARTIALLY_REFUNDED → REFUNDED (solo pagos EXECUTED).
 *
 * La devolución nunca excede el importe REAL recibido (la obligación es
 * exactamente ese importe y el trigger impide pagar de más).
 */

export async function registerUnappliedRefund(
  actor: SessionUser,
  fundsId: string,
  input: { correctionId: string; notes?: string; idempotencyKey: string },
  ctx: RequestContext = {}
) {
  const existing = await prisma.specialPayable.findUnique({
    where: { kind_sourceId: { kind: "UNAPPLIED_REFUND", sourceId: fundsId } },
    select: { id: true },
  })
  if (existing) return { payableId: existing.id, replayed: true }
  try {
    return await prisma.$transaction(async (tx) => {
      const funds = await tx.unappliedPlayerFunds.findUnique({
        where: { id: fundsId },
        include: { player: { select: { name: true } } },
      })
      if (!funds) throw new NotFoundError("Fondos no aplicados no encontrados")
      await lockPlayerInTx(tx, funds.playerId)
      const correction = await requireApprovedCorrectionInTx(
        tx,
        input.correctionId,
        { type: "UNAPPLIED_FUNDS_RETURN", targetId: fundsId }
      )
      const payable = await createSpecialPayableInTx(tx, actor, {
        kind: "UNAPPLIED_REFUND",
        sourceType: "UnappliedPlayerFunds",
        sourceId: fundsId,
        playerId: funds.playerId,
        beneficiaryName: funds.player.name,
        sessionId: null,
        amount: funds.amount,
      })
      await createSpecialReceiptInTx(tx, actor, {
        kind: "UNAPPLIED_REFUND",
        sourceKey: `unapplied:${fundsId}`,
        kicker: `Fondos no aplicados · ${correction.folio}`,
        title: "Devolución registrada",
        lines: [
          { label: "Jugador", value: funds.player.name },
          {
            label: "Importe recibido no aplicado",
            value: `$${fmt(funds.amount)}`,
          },
          { label: "A devolver", value: `$${fmt(funds.amount)}`, strong: true },
          { label: "Devuelto", value: "$0.00" },
        ],
        footer:
          "No es saldo a favor. Solo cuenta como devuelto lo efectivamente pagado (efectivo entregado o transferencia ejecutada).",
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.UNAPPLIED_FUNDS_REFUND_REGISTERED,
          entityType: "UnappliedPlayerFunds",
          entityId: fundsId,
          actorUserId: actor.id,
          actorRole: actor.role,
          requestId: ctx.requestId,
          playerId: funds.playerId,
          idempotencyKey: input.idempotencyKey,
          amount: fmt(funds.amount),
          reason: input.notes ?? null,
          metadata: {
            payableId: payable.id,
            correctionId: correction.id,
            correctionFolio: correction.folio,
          },
        },
        tx
      )
      await linkExecutionInTx(
        tx,
        actor,
        correction,
        payable.id,
        "Obligación de devolución registrada (el pago se registra aparte).",
        ctx
      )
      return { payableId: payable.id, replayed: false }
    }, SPECIAL_TX)
  } catch (error) {
    const again = await prisma.specialPayable.findUnique({
      where: { kind_sourceId: { kind: "UNAPPLIED_REFUND", sourceId: fundsId } },
      select: { id: true },
    })
    if (again) return { payableId: again.id, replayed: true }
    await auditFailure(actor, "UnappliedPlayerFunds", fundsId, error, ctx)
    throw error
  }
}

const include = {
  player: { select: { id: true, name: true } },
  bankTransfer: {
    select: {
      id: true,
      bankReference: true,
      declaredAmount: true,
      confirmedAmount: true,
      verifiedAt: true,
    },
  },
} as const

async function payablesFor(ids: string[]) {
  const rows = await prisma.specialPayable.findMany({
    where: { kind: "UNAPPLIED_REFUND", sourceId: { in: ids } },
    include: { payouts: { orderBy: { sequence: "asc" } } },
  })
  return new Map(rows.map((r) => [r.sourceId, r]))
}

async function correctionsFor(ids: string[]) {
  const rows = await prisma.correctionRequest.findMany({
    where: { type: "UNAPPLIED_FUNDS_RETURN", targetId: { in: ids } },
    orderBy: { requestedAt: "desc" },
    select: { id: true, folio: true, status: true, targetId: true },
  })
  const map = new Map<string, (typeof rows)[number][]>()
  for (const r of rows) map.set(r.targetId, [...(map.get(r.targetId) ?? []), r])
  return map
}

export async function listUnappliedFunds() {
  const rows = await prisma.unappliedPlayerFunds.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    include,
  })
  const ids = rows.map((r) => r.id)
  const [payables, corrections] = await Promise.all([
    payablesFor(ids),
    correctionsFor(ids),
  ])
  return rows.map((r) =>
    view(r, payables.get(r.id) ?? null, corrections.get(r.id) ?? [])
  )
}

export async function getUnappliedFunds(id: string) {
  const r = await prisma.unappliedPlayerFunds.findUnique({
    where: { id },
    include,
  })
  if (!r) throw new NotFoundError("Fondos no aplicados no encontrados")
  const [payables, corrections, receipts] = await Promise.all([
    payablesFor([id]),
    correctionsFor([id]),
    prisma.specialOperationReceipt.findMany({
      where: {
        OR: [
          { sourceKey: `unapplied:${id}` },
          { sourceKey: { startsWith: `payout:unapplied-refund:${id}:` } },
        ],
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, kind: true, title: true, createdAt: true },
    }),
  ])
  return {
    ...view(r, payables.get(id) ?? null, corrections.get(id) ?? []),
    receipts: receipts.map((x) => ({
      ...x,
      createdAt: x.createdAt.toISOString(),
    })),
  }
}

function view(
  r: {
    id: string
    amount: Prisma.Decimal
    reason: string
    createdAt: Date
    player: { id: string; name: string }
    bankTransfer: {
      id: string
      bankReference: string | null
      declaredAmount: Prisma.Decimal
      confirmedAmount: Prisma.Decimal | null
      verifiedAt: Date | null
    }
  },
  payable: Parameters<typeof payableView>[0] | null,
  corrections: { id: string; folio: string; status: string }[]
) {
  return {
    id: r.id,
    player: r.player,
    amount: fmt(r.amount),
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
    bankTransfer: {
      id: r.bankTransfer.id,
      bankReference: r.bankTransfer.bankReference,
      amount: fmt(
        r.bankTransfer.confirmedAmount ?? r.bankTransfer.declaredAmount
      ),
      verifiedAt: r.bankTransfer.verifiedAt?.toISOString() ?? null,
    },
    status: unappliedStatusFor(
      payable
        ? { original: payable.originalAmount, payouts: payable.payouts }
        : null
    ),
    payable: payable ? payableView(payable) : null,
    corrections,
  }
}
