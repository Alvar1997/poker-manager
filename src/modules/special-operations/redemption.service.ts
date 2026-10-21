import "server-only"

import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import type { Tx } from "@/modules/cash/ledger"
import { isAuthorizerRole } from "@/modules/corrections/correction.rules"
import {
  readNominal,
  sharedChipSetId,
} from "@/modules/inventory/inventory.core"
import { confirmNominalChipReturnInTx } from "@/modules/inventory/reservation.service"
import { assertPlayerSelectable } from "@/modules/players/player.rules"
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
  SPECIAL_DECLARATIONS,
  validateRedemption,
} from "./special.math"

/**
 * 16.1 — Canje POSTERIOR de fichas no retornadas.
 *
 *   REQUESTED → (validación del valor por PARTNER/SUPERADMIN) VALIDATING
 *   → (recepción FÍSICA confirmada + firma) PAYMENT_PENDING
 *   → PARTIALLY_PAID → PAID   (solo con pagos EXECUTED)
 *   REQUESTED/VALIDATING → REJECTED | CANCELLED
 *
 * - La entrada al inventario compartido ocurre UNA vez al recibir
 *   (`confirmNominalChipReturnInTx`, clave por canje); la base impide
 *   devolver más de lo que está en circulación.
 * - La sesión de origen es INFORMATIVA: su caja, su inventario y su
 *   comprobante de cierre no se tocan; nunca se reabre.
 * - La circulación global no prueba el derecho a cobrar: por eso un socio
 *   valida el valor aceptado antes de recibir.
 */

async function lockRedemptionInTx(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "late_chip_redemptions" WHERE "id" = ${id} FOR UPDATE`
  if (rows.length === 0) throw new NotFoundError("Canje no encontrado")
  return tx.lateChipRedemption.findUniqueOrThrow({ where: { id } })
}

function assertVersion(current: number, expected: number) {
  if (current !== expected)
    throw new ConflictError("El canje cambió mientras lo revisabas. Recárgalo.")
}

export async function createRedemption(
  actor: SessionUser,
  input: {
    presenterName: string
    playerId?: string
    originSessionId?: string
    originEvidence?: string
    presentedNominal: string
    notes?: string
    idempotencyKey: string
  },
  ctx: RequestContext = {}
) {
  const previous = await prisma.lateChipRedemption.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true },
  })
  if (previous) return { id: previous.id, replayed: true }
  const presented = dec(input.presentedNominal)
  if (!presented.greaterThan(0))
    throw new BusinessRuleError("El valor presentado debe ser mayor que cero.")
  if (input.originSessionId && !input.originEvidence?.trim())
    throw new BusinessRuleError(
      "Si indicas la sesión de origen, documenta la evidencia que la sustenta (es informativa)."
    )
  try {
    return await prisma.$transaction(async (tx) => {
      if (input.playerId) {
        const p = await tx.player.findUnique({
          where: { id: input.playerId },
          select: { name: true, isActive: true },
        })
        if (!p) throw new NotFoundError("Jugador no encontrado")
        assertPlayerSelectable(p)
      }
      if (input.originSessionId) {
        const s = await tx.pokerSession.findUnique({
          where: { id: input.originSessionId },
          select: { id: true },
        })
        if (!s) throw new NotFoundError("Sesión de origen no encontrada")
      }
      const folio = await issueFolio(tx, "REDEMPTION")
      const r = await tx.lateChipRedemption.create({
        data: {
          folio,
          presenterName: input.presenterName.trim(),
          playerId: input.playerId ?? null,
          originSessionId: input.originSessionId ?? null,
          originEvidence: input.originEvidence?.trim() || null,
          presentedNominal: presented,
          notes: input.notes?.trim() || null,
          requestedById: actor.id,
          idempotencyKey: input.idempotencyKey,
        },
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.LATE_REDEMPTION_REQUESTED,
          entityType: "LateChipRedemption",
          entityId: r.id,
          actorUserId: actor.id,
          actorRole: actor.role,
          requestId: ctx.requestId,
          playerId: r.playerId,
          sessionId: r.originSessionId,
          idempotencyKey: input.idempotencyKey,
          amount: fmt(presented),
          metadata: {
            folio,
            presenterName: r.presenterName,
            originSessionInformative: Boolean(r.originSessionId),
          },
        },
        tx
      )
      return { id: r.id, replayed: false }
    }, SPECIAL_TX)
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await prisma.lateChipRedemption.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true },
      })
      if (again) return { id: again.id, replayed: true }
    }
    throw error
  }
}

/** Vista previa (sin escrituras): qué se aceptaría frente a la circulación. */
export async function previewRedemptionValidation(
  id: string,
  input: {
    acceptedNominal: string
    denominations?: { denominationId: string; quantity: number }[]
  }
) {
  const r = await prisma.lateChipRedemption.findUnique({ where: { id } })
  if (!r) throw new NotFoundError("Canje no encontrado")
  const chipSetId = await sharedChipSetId(prisma)
  const n = await readNominal(prisma, chipSetId)
  const denoms = await resolveDenominations(chipSetId, input.denominations)
  return {
    ...summarizeValidation(
      validateRedemption({
        presented: r.presentedNominal,
        accepted: dec(input.acceptedNominal),
        globalCirculation: n.circulation,
        denominations: denoms?.map((d) => ({
          unitValue: d.value,
          quantity: d.quantity,
        })),
      })
    ),
    globalCirculation: fmt(n.circulation),
  }
}

function summarizeValidation(v: ReturnType<typeof validateRedemption>) {
  return {
    ok: v.ok,
    problems: v.problems,
    rejected: fmt(v.rejected),
    counted: v.counted ? fmt(v.counted) : null,
  }
}

async function resolveDenominations(
  chipSetId: string,
  list?: { denominationId: string; quantity: number }[]
) {
  if (!list || list.length === 0) return null
  const rows = await prisma.chipDenomination.findMany({
    where: { chipSetId, id: { in: list.map((d) => d.denominationId) } },
    select: { id: true, value: true, name: true },
  })
  return list.map((d) => {
    const row = rows.find((x) => x.id === d.denominationId)
    if (!row)
      throw new BusinessRuleError(
        "Una denominación no pertenece al inventario compartido."
      )
    return { ...row, quantity: d.quantity }
  })
}

/**
 * Validación del valor por PARTNER/SUPERADMIN (CASHIER solicita, no
 * autoriza). No registra fichas ni dinero: fija el valor ACEPTADO que se
 * recibirá físicamente. Aceptado 0 ⇒ REJECTED.
 */
export async function validateRedemptionValue(
  actor: SessionUser,
  id: string,
  input: {
    expectedVersion: number
    acceptedNominal: string
    denominations?: { denominationId: string; quantity: number }[]
    notes: string
  },
  ctx: RequestContext = {}
) {
  if (!isAuthorizerRole(actor.role))
    throw new ForbiddenError(
      "Solo PARTNER o SUPERADMIN validan el valor de un canje."
    )
  const chipSetId = await sharedChipSetId(prisma)
  const denoms = await resolveDenominations(chipSetId, input.denominations)
  return prisma.$transaction(async (tx) => {
    const r = await lockRedemptionInTx(tx, id)
    assertVersion(r.version, input.expectedVersion)
    if (r.status !== "REQUESTED" && r.status !== "VALIDATING")
      throw new BusinessRuleError(
        "Solo se valida un canje solicitado y aún sin recepción."
      )
    const n = await readNominal(tx, chipSetId)
    const accepted = dec(input.acceptedNominal)
    const v = validateRedemption({
      presented: r.presentedNominal,
      accepted,
      globalCirculation: n.circulation,
      denominations: denoms?.map((d) => ({
        unitValue: d.value,
        quantity: d.quantity,
      })),
    })
    if (!v.ok) throw new BusinessRuleError(v.problems.join(" "))
    const rejectedAll = accepted.isZero()
    await tx.lateChipRedemption.update({
      where: { id },
      data: {
        status: rejectedAll ? "REJECTED" : "VALIDATING",
        acceptedNominal: accepted,
        rejectedNominal: v.rejected,
        denominations: denoms
          ? denoms.map((d) => ({
              denominationId: d.id,
              name: d.name,
              value: fmt(d.value),
              quantity: d.quantity,
            }))
          : undefined,
        validationNotes: input.notes.trim(),
        validatedAt: new Date(),
        version: { increment: 1 },
      },
    })
    await recordAudit(
      {
        action: rejectedAll
          ? AUDIT_ACTIONS.LATE_REDEMPTION_REJECTED
          : AUDIT_ACTIONS.LATE_REDEMPTION_VALIDATED,
        entityType: "LateChipRedemption",
        entityId: id,
        actorUserId: actor.id,
        actorRole: actor.role,
        requestId: ctx.requestId,
        playerId: r.playerId,
        reason: input.notes,
        amount: fmt(accepted),
        metadata: {
          folio: r.folio,
          presented: fmt(r.presentedNominal),
          accepted: fmt(accepted),
          rejected: fmt(v.rejected),
          globalCirculation: fmt(n.circulation),
          byDenomination: Boolean(denoms),
        },
      },
      tx
    )
    return { status: rejectedAll ? "REJECTED" : "VALIDATING" }
  }, SPECIAL_TX)
}

/**
 * Recepción FÍSICA de las fichas validadas + firma del presentador. En UNA
 * transacción: entrada nominal (una vez), obligación por pagar, evidencia y
 * comprobante. No mueve dinero.
 */
export async function confirmRedemptionReceipt(
  actor: SessionUser,
  id: string,
  input: {
    expectedVersion: number
    physicalReceiptConfirmed: boolean
    strokes: Strokes
    idempotencyKey: string
  },
  ctx: RequestContext = {}
) {
  if (!input.physicalReceiptConfirmed)
    throw new BusinessRuleError(
      "Confirma que recibiste físicamente las fichas: sin recepción física no hay canje."
    )
  const existing = await prisma.lateChipRedemption.findUnique({
    where: { id },
    select: { chipOperationId: true, status: true },
  })
  if (!existing) throw new NotFoundError("Canje no encontrado")
  if (existing.chipOperationId) return { replayed: true }
  const fileId = await stageSpecialSignature(actor, input.strokes)
  try {
    const result = await prisma.$transaction(async (tx) => {
      const r = await lockRedemptionInTx(tx, id)
      if (r.chipOperationId) return { replayed: true }
      assertVersion(r.version, input.expectedVersion)
      if (r.status !== "VALIDATING" || !r.acceptedNominal?.greaterThan(0))
        throw new BusinessRuleError(
          "El canje debe tener un valor validado por un socio antes de recibir las fichas."
        )
      const accepted = r.acceptedNominal
      const op = await confirmNominalChipReturnInTx(
        tx,
        actor,
        {
          amount: accepted.toFixed(2),
          referenceType: "LateChipRedemption",
          referenceId: r.id,
          idempotencyKey: `redemption-receipt:${r.id}`,
          playerId: r.playerId,
        },
        ctx
      )
      const payable = await createSpecialPayableInTx(tx, actor, {
        kind: "REDEMPTION",
        sourceType: "LateChipRedemption",
        sourceId: r.id,
        playerId: r.playerId,
        beneficiaryName: r.presenterName,
        sessionId: null,
        amount: accepted,
      })
      const content = {
        type: "LATE_CHIP_REDEMPTION",
        folio: r.folio,
        presenterName: r.presenterName,
        playerId: r.playerId,
        presented: fmt(r.presentedNominal),
        accepted: fmt(accepted),
        rejected: fmt(r.rejectedNominal ?? dec(0)),
        denominations: r.denominations ?? null,
        payable: fmt(accepted),
        paid: "0.00",
      }
      const declaration = SPECIAL_DECLARATIONS.REDEMPTION
      await recordSpecialEvidenceInTx(
        tx,
        actor,
        {
          fileId,
          sourceType: "LateChipRedemption",
          sourceId: r.id,
          content,
          declarationText: declaration,
          signerName: r.presenterName,
          playerId: r.playerId,
        },
        ctx
      )
      const now = new Date()
      await tx.lateChipRedemption.update({
        where: { id: r.id },
        data: {
          status: "PAYMENT_PENDING",
          chipOperationId: op.operationId,
          receivedById: actor.id,
          receivedAt: now,
          version: { increment: 1 },
        },
      })
      await createSpecialReceiptInTx(tx, actor, {
        kind: "REDEMPTION_RECEIPT",
        sourceKey: `redemption:${r.id}`,
        kicker: `Canje posterior ${r.folio}`,
        title: "Recepción de fichas",
        lines: [
          { label: "Presentó", value: r.presenterName },
          { label: "Valor presentado", value: `$${fmt(r.presentedNominal)}` },
          { label: "Valor aceptado", value: `$${fmt(accepted)}`, strong: true },
          {
            label: "Valor rechazado",
            value: `$${fmt(r.rejectedNominal ?? dec(0))}`,
          },
          { label: "Pagado", value: "$0.00" },
          {
            label: "Pendiente de pago",
            value: `$${fmt(accepted)}`,
            strong: true,
          },
        ],
        footer:
          "Las fichas ingresaron al inventario compartido. El pago se registra aparte; solo cuenta lo efectivamente entregado.",
        evidenceFileId: fileId,
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.LATE_REDEMPTION_RECEIVED,
          entityType: "LateChipRedemption",
          entityId: r.id,
          actorUserId: actor.id,
          actorRole: actor.role,
          requestId: ctx.requestId,
          playerId: r.playerId,
          sessionId: r.originSessionId,
          idempotencyKey: input.idempotencyKey,
          amount: fmt(accepted),
          metadata: {
            folio: r.folio,
            chipOperationId: op.operationId,
            payableId: payable.id,
            accepted: fmt(accepted),
            originSessionInformative: Boolean(r.originSessionId),
          },
        },
        tx
      )
      return { replayed: false }
    }, SPECIAL_TX)
    if (result.replayed) await discardSpecialSignature(fileId)
    return result
  } catch (error) {
    await discardSpecialSignature(fileId)
    await auditFailure(actor, "LateChipRedemption", id, error, ctx)
    throw error
  }
}

export async function cancelRedemption(
  actor: SessionUser,
  id: string,
  input: { expectedVersion: number; reason: string },
  ctx: RequestContext = {}
) {
  return prisma.$transaction(async (tx) => {
    const r = await lockRedemptionInTx(tx, id)
    assertVersion(r.version, input.expectedVersion)
    if (r.chipOperationId || !["REQUESTED", "VALIDATING"].includes(r.status))
      throw new BusinessRuleError(
        "Un canje con fichas recibidas no se cancela: su obligación sigue vigente."
      )
    await tx.lateChipRedemption.update({
      where: { id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelReason: input.reason.trim(),
        version: { increment: 1 },
      },
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.LATE_REDEMPTION_CANCELLED,
        entityType: "LateChipRedemption",
        entityId: id,
        actorUserId: actor.id,
        actorRole: actor.role,
        requestId: ctx.requestId,
        reason: input.reason,
        metadata: { folio: r.folio },
      },
      tx
    )
    return { status: "CANCELLED" as const }
  }, SPECIAL_TX)
}

export async function getRedemption(id: string) {
  const r = await prisma.lateChipRedemption.findUnique({
    where: { id },
    include: {
      player: { select: { id: true, name: true } },
      originSession: { select: { id: true, folio: true, status: true } },
      requestedBy: { select: { name: true } },
      receivedBy: { select: { name: true } },
    },
  })
  if (!r) throw new NotFoundError("Canje no encontrado")
  const [payable, receipts, chipSetId] = await Promise.all([
    prisma.specialPayable.findUnique({
      where: { kind_sourceId: { kind: "REDEMPTION", sourceId: id } },
      include: { payouts: { orderBy: { sequence: "asc" } } },
    }),
    prisma.specialOperationReceipt.findMany({
      where: {
        OR: [
          { sourceKey: `redemption:${id}` },
          { sourceKey: { startsWith: `payout:redemption:${id}:` } },
        ],
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, kind: true, title: true, createdAt: true },
    }),
    sharedChipSetId(prisma),
  ])
  const n = await readNominal(prisma, chipSetId)
  return {
    id: r.id,
    folio: r.folio,
    status: r.status,
    version: r.version,
    presenterName: r.presenterName,
    player: r.player,
    originSession: r.originSession,
    originEvidence: r.originEvidence,
    presented: fmt(r.presentedNominal),
    accepted: r.acceptedNominal ? fmt(r.acceptedNominal) : null,
    rejected: r.rejectedNominal ? fmt(r.rejectedNominal) : null,
    denominations: r.denominations,
    validationNotes: r.validationNotes,
    validatedAt: r.validatedAt?.toISOString() ?? null,
    received: Boolean(r.chipOperationId),
    receivedAt: r.receivedAt?.toISOString() ?? null,
    receivedBy: r.receivedBy?.name ?? null,
    requestedBy: r.requestedBy.name,
    requestedAt: r.requestedAt.toISOString(),
    cancelReason: r.cancelReason,
    notes: r.notes,
    globalCirculation: fmt(n.circulation),
    payable: payable ? payableView(payable) : null,
    receipts: receipts.map((x) => ({
      ...x,
      createdAt: x.createdAt.toISOString(),
    })),
  }
}

export type RedemptionDetail = Awaited<ReturnType<typeof getRedemption>>
