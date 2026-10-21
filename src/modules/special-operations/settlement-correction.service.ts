import "server-only"

import { randomUUID } from "node:crypto"

import { BusinessRuleError, NotFoundError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import type { Tx } from "@/modules/cash/ledger"
import {
  linkExecutionInTx,
  requireApprovedCorrectionInTx,
} from "@/modules/corrections/correction.service"
import {
  lockPlayerInTx,
  reverseSettlementOffsetsInTx,
} from "@/modules/credits/receivable.service"
import { issueFolio } from "@/modules/settings/folio.service"
import type { Strokes } from "@/modules/signatures/signature.strokes"

import {
  createSpecialReceiptInTx,
  discardSpecialSignature,
  recordSpecialEvidenceInTx,
  stageSpecialSignature,
} from "./special-evidence"
import {
  auditFailure,
  createSpecialPayableInTx,
  payableView,
  SPECIAL_TX,
} from "./special-payout.service"
import {
  dec,
  fmt,
  planSettlementCorrection,
  SPECIAL_DECLARATIONS,
  ZERO,
} from "./special.math"

/**
 * 16.3 — Corrección de una liquidación RECIBIDA que ya tiene pagos reales.
 *
 * La liquidación original, su firma, su comprobante, sus pagos y la caja de
 * su sesión NO se modifican. La corrección crea efectos NUEVOS:
 *   - OFFSET_REVERSAL: contraasientos de la compensación FIFO (las deudas
 *     recuperan su saldo) y una obligación por pagar al jugador por ese
 *     mismo valor (el valor de sus fichas sigue siendo suyo). No entra ni
 *     sale efectivo al ejecutarla.
 *   - ADDITIONAL_PAYOUT: el negocio debe una diferencia adicional
 *     (obligación nueva; se paga con pagos reales).
 * Exige solicitud APROBADA (Módulo 15) y la firma del jugador sobre el
 * resumen preparado por el servidor. Reclamar al jugador dinero pagado de
 * más NO está implementado (requeriría una cuenta por cobrar nueva).
 */

async function activeOffsets(db: Tx | typeof prisma, settlementId: string) {
  const rows = await db.paymentAllocation.findMany({
    where: { settlementId, source: "CHIP_SETTLEMENT_OFFSET" },
    select: {
      kind: true,
      amount: true,
      receivable: {
        select: {
          purchase: { select: { reversal: { select: { id: true } } } },
        },
      },
    },
  })
  const net = rows.reduce(
    (acc, a) =>
      a.kind === "APPLICATION" ? acc.add(a.amount) : acc.sub(a.amount),
    ZERO
  )
  const reversedPurchase = rows.some((a) => a.receivable.purchase.reversal)
  return {
    net,
    alreadyReversed: rows.some((a) => a.kind === "REVERSAL"),
    reversedPurchase,
  }
}

async function loadSettlement(db: Tx | typeof prisma, id: string) {
  const s = await db.playerSettlement.findUnique({
    where: { id },
    select: {
      id: true,
      folio: true,
      status: true,
      version: true,
      sessionId: true,
      playerId: true,
      returnedNominalAmount: true,
      offsetAmount: true,
      player: { select: { id: true, name: true } },
      session: { select: { id: true, folio: true, status: true } },
    },
  })
  if (!s) throw new NotFoundError("Liquidación no encontrada")
  return s
}

export type SettlementCorrectionInput = {
  kind: "ADDITIONAL_PAYOUT" | "OFFSET_REVERSAL"
  amount?: string
}

function summaryContent(
  s: Awaited<ReturnType<typeof loadSettlement>>,
  kind: SettlementCorrectionInput["kind"],
  amount: string
) {
  return {
    type: "SETTLEMENT_CORRECTION",
    settlementFolio: s.folio,
    sessionFolio: s.session.folio,
    player: s.player.name,
    kind,
    amount,
    debtsRestored: kind === "OFFSET_REVERSAL" ? amount : "0.00",
    newPayable: amount,
    cashMovedNow: "0.00",
  }
}

export async function previewSettlementCorrection(
  settlementId: string,
  input: SettlementCorrectionInput
) {
  const s = await loadSettlement(prisma, settlementId)
  const off = await activeOffsets(prisma, settlementId)
  const correction = await prisma.correctionRequest.findFirst({
    where: {
      type: "SETTLEMENT_REVERSAL_WITH_PAYOUTS",
      targetId: settlementId,
      status: { in: ["APPROVED", "FAILED"] },
    },
    orderBy: { requestedAt: "desc" },
    select: { id: true, folio: true, status: true },
  })
  const plan = planSettlementCorrection({
    status: s.status,
    activeOffsets: off.net,
    alreadyReversedOffsets: off.alreadyReversed,
    approvedCorrection: Boolean(correction),
    kind: input.kind,
    amount: input.amount ? dec(input.amount) : null,
  })
  if (input.kind === "OFFSET_REVERSAL" && off.reversedPurchase)
    plan.blockers.push(
      "La compensación se aplicó a la deuda de una compra ya revertida: no puede reabrirse."
    )
  return {
    settlement: {
      id: s.id,
      folio: s.folio,
      status: s.status,
      version: s.version,
      player: s.player,
      session: s.session,
      returned: fmt(s.returnedNominalAmount),
      activeOffsets: fmt(off.net),
    },
    correction,
    plan: { ...plan, executable: plan.blockers.length === 0 },
    summary: summaryContent(s, input.kind, plan.effects.amount),
    declaration: SPECIAL_DECLARATIONS.SETTLEMENT_CORRECTION,
  }
}

export async function executeSettlementCorrection(
  actor: SessionUser,
  settlementId: string,
  input: SettlementCorrectionInput & {
    correctionId: string
    expectedVersion: number
    reason: string
    strokes: Strokes
    idempotencyKey: string
  },
  ctx: RequestContext = {}
) {
  const previous = await prisma.settlementCorrection.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, settlementId: true },
  })
  if (previous) {
    if (previous.settlementId !== settlementId)
      throw new BusinessRuleError("Clave de operación reutilizada")
    return { correctionRecordId: previous.id, replayed: true }
  }
  const fileId = await stageSpecialSignature(actor, input.strokes)
  try {
    const result = await prisma.$transaction(async (tx) => {
      const head = await loadSettlement(tx, settlementId)
      await tx.$queryRaw`SELECT "id" FROM "poker_sessions" WHERE "id" = ${head.sessionId} FOR SHARE`
      await tx.$queryRaw`SELECT "id" FROM "player_settlements" WHERE "id" = ${settlementId} FOR UPDATE`
      await lockPlayerInTx(tx, head.playerId)
      const correction = await requireApprovedCorrectionInTx(
        tx,
        input.correctionId,
        { type: "SETTLEMENT_REVERSAL_WITH_PAYOUTS", targetId: settlementId }
      )
      const s = await loadSettlement(tx, settlementId)
      if (s.version !== input.expectedVersion)
        throw new BusinessRuleError(
          "La liquidación cambió mientras la revisabas."
        )
      const off = await activeOffsets(tx, settlementId)
      const plan = planSettlementCorrection({
        status: s.status,
        activeOffsets: off.net,
        alreadyReversedOffsets: off.alreadyReversed,
        approvedCorrection: true,
        kind: input.kind,
        amount: input.amount ? dec(input.amount) : null,
      })
      if (input.kind === "OFFSET_REVERSAL" && off.reversedPurchase)
        plan.blockers.push(
          "La compensación se aplicó a la deuda de una compra ya revertida: no puede reabrirse."
        )
      if (plan.blockers.length > 0)
        throw new BusinessRuleError(plan.blockers.join(" "))
      const amount = dec(plan.effects.amount)
      const id = randomUUID()
      const content = summaryContent(s, input.kind, fmt(amount))
      const evidenceId = await recordSpecialEvidenceInTx(
        tx,
        actor,
        {
          fileId,
          sourceType: "SettlementCorrection",
          sourceId: id,
          content,
          declarationText: SPECIAL_DECLARATIONS.SETTLEMENT_CORRECTION,
          signerName: s.player.name,
          playerId: s.playerId,
        },
        ctx
      )
      const folio = await issueFolio(tx, "SETTLEMENT_CORRECTION")
      const record = await tx.settlementCorrection.create({
        data: {
          id,
          folio,
          settlementId,
          kind: input.kind,
          correctionId: correction.id,
          amount,
          reason: input.reason.trim(),
          evidenceId,
          executedById: actor.id,
          idempotencyKey: input.idempotencyKey,
        },
      })
      let restored = ZERO
      if (input.kind === "OFFSET_REVERSAL") {
        const reversed = await reverseSettlementOffsetsInTx(
          tx,
          actor.id,
          settlementId
        )
        restored = reversed.reduce((acc, r) => acc.add(r.amount), ZERO)
        if (!restored.equals(amount))
          throw new BusinessRuleError(
            "La compensación cambió durante la corrección: vuelve a intentarlo."
          )
      }
      const payable = await createSpecialPayableInTx(tx, actor, {
        kind: "SETTLEMENT_ADJUSTMENT",
        sourceType: "SettlementCorrection",
        sourceId: record.id,
        playerId: s.playerId,
        beneficiaryName: s.player.name,
        sessionId: s.sessionId,
        amount,
      })
      await createSpecialReceiptInTx(tx, actor, {
        kind: "SETTLEMENT_CORRECTION",
        sourceKey: `settlement-correction:${record.id}`,
        kicker: `Corrección ${folio} · liquidación ${s.folio}`,
        title: "Corrección de liquidación",
        lines: [
          { label: "Jugador", value: s.player.name },
          { label: "Sesión", value: s.session.folio },
          {
            label: "Tipo",
            value:
              input.kind === "OFFSET_REVERSAL"
                ? "Reverso de compensación"
                : "Pago adicional",
          },
          {
            label: "Deudas restablecidas",
            value: `$${fmt(restored)}`,
          },
          {
            label: "Nuevo importe por pagar",
            value: `$${fmt(amount)}`,
            strong: true,
          },
          { label: "Pagado", value: "$0.00" },
        ],
        footer:
          "La liquidación original, su firma y sus pagos se conservan. Nada se paga hasta registrar un pago real.",
        evidenceFileId: fileId,
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.SETTLEMENT_CORRECTION_EXECUTED,
          entityType: "PlayerSettlement",
          entityId: settlementId,
          actorUserId: actor.id,
          actorRole: actor.role,
          requestId: ctx.requestId,
          sessionId: s.sessionId,
          playerId: s.playerId,
          idempotencyKey: input.idempotencyKey,
          reason: input.reason,
          amount: fmt(amount),
          evidenceRef: evidenceId,
          metadata: {
            folio,
            settlementFolio: s.folio,
            kind: input.kind,
            correctionId: correction.id,
            debtsRestored: fmt(restored),
            payableId: payable.id,
            sessionStatus: s.session.status,
          },
        },
        tx
      )
      await linkExecutionInTx(
        tx,
        actor,
        correction,
        record.id,
        `Corrección ejecutada; $${fmt(amount)} pendientes de pago.`,
        ctx
      )
      return { correctionRecordId: record.id, replayed: false }
    }, SPECIAL_TX)
    return result
  } catch (error) {
    await discardSpecialSignature(fileId)
    await auditFailure(actor, "PlayerSettlement", settlementId, error, ctx, {
      kind: input.kind,
    })
    throw error
  }
}

export async function getSettlementCorrection(id: string) {
  const r = await prisma.settlementCorrection.findUnique({
    where: { id },
    include: {
      settlement: {
        select: {
          id: true,
          folio: true,
          player: { select: { id: true, name: true } },
          session: { select: { id: true, folio: true, status: true } },
        },
      },
      correction: { select: { id: true, folio: true, status: true } },
      executedBy: { select: { name: true } },
    },
  })
  if (!r) throw new NotFoundError("Corrección no encontrada")
  const [payable, receipts] = await Promise.all([
    prisma.specialPayable.findUnique({
      where: { kind_sourceId: { kind: "SETTLEMENT_ADJUSTMENT", sourceId: id } },
      include: { payouts: { orderBy: { sequence: "asc" } } },
    }),
    prisma.specialOperationReceipt.findMany({
      where: {
        OR: [
          { sourceKey: `settlement-correction:${id}` },
          { sourceKey: { startsWith: `payout:settlement-adjustment:${id}:` } },
        ],
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, kind: true, title: true, createdAt: true },
    }),
  ])
  return {
    id: r.id,
    folio: r.folio,
    kind: r.kind,
    amount: fmt(r.amount),
    reason: r.reason,
    settlement: r.settlement,
    correction: r.correction,
    executedBy: r.executedBy.name,
    executedAt: r.executedAt.toISOString(),
    payable: payable ? payableView(payable) : null,
    receipts: receipts.map((x) => ({
      ...x,
      createdAt: x.createdAt.toISOString(),
    })),
  }
}
