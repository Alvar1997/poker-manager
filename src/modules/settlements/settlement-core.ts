import "server-only"

import { Prisma } from "@/generated/prisma/client"
import { BusinessRuleError, NotFoundError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTIONS, recordAudit } from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import { ExcessPaymentError } from "@/modules/credits/credit.math"
import { receivablesOf } from "@/modules/credits/receivable.service"
import {
  completeParticipationFromSettlementInTx,
  type SettlementVerifier,
} from "@/modules/session-tables/participation.service"
import {
  payableState,
  planSettlement,
  SettlementRuleError,
  type PayableState,
  type SettlementPlan,
} from "@/modules/settlements/settlement.math"

/**
 * Piezas compartidas del Módulo 11 (liquidaciones): bloqueos, plan de
 * compensación (FIFO del Módulo 10), parte MATERIAL firmada, versionado,
 * verificador real para la participación y proyección de la cuenta por
 * pagar. Sin endpoints: lo usan los servicios del módulo.
 *
 * Orden de bloqueos (sin interbloqueos, compatible con compras y abonos):
 *   sesión (FOR SHARE) → liquidación → mesa → participación → jugador →
 *   inventario compartido → cuenta por pagar → desembolso → saldos.
 */

export type Tx = Prisma.TransactionClient
export type Db = Tx | typeof prisma
export const SETTLEMENT_TX = { maxWait: 15_000, timeout: 30_000 } as const

export const dec = (v: Prisma.Decimal | string | number) =>
  new Prisma.Decimal(v)
export const fmt = (v: Prisma.Decimal) => v.toFixed(2)

export const SETTLEMENT_STALE_MESSAGE =
  "La liquidación cambió desde que el jugador firmó (importe, compensación o deudas). Prepara un nuevo resumen y solicita una nueva firma."

/** Convierte errores de reglas puras en errores de negocio (422). */
export function asBusiness(e: unknown): never {
  if (e instanceof SettlementRuleError || e instanceof ExcessPaymentError)
    throw new BusinessRuleError(e.message)
  throw e
}

/** Bloquea la sesión en modo compartido (no cambia de estado a la mitad). */
export async function lockSessionShare(tx: Tx, sessionId: string) {
  const rows = await tx.$queryRaw<
    { id: string; folio: string; status: string }[]
  >`SELECT "id", "folio", "status"::text AS "status" FROM "poker_sessions" WHERE "id" = ${sessionId} FOR SHARE`
  if (rows.length === 0) throw new NotFoundError("Sesión no encontrada")
  return rows[0]
}

export const settlementCoreSelect = {
  id: true,
  folio: true,
  status: true,
  version: true,
  sessionId: true,
  sessionTableId: true,
  cycleId: true,
  participationId: true,
  playerId: true,
  tableId: true,
  returnedNominalAmount: true,
  offsetDecision: true,
  requestedOffsetAmount: true,
  offsetAmount: true,
  netPayoutAmount: true,
  debtBalanceSnapshot: true,
  chipReturnOperationId: true,
  signatureId: true,
  receivedAt: true,
  confirmIdempotencyKey: true,
  createdAt: true,
  player: { select: { id: true, name: true } },
  session: { select: { id: true, folio: true, status: true } },
  table: { select: { id: true, name: true } },
} satisfies Prisma.PlayerSettlementSelect

export type SettlementCore = Prisma.PlayerSettlementGetPayload<{
  select: typeof settlementCoreSelect
}>

/** Bloquea (FOR UPDATE) la liquidación y la devuelve. */
export async function lockSettlement(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "player_settlements" WHERE "id" = ${id} FOR UPDATE
  `
  if (rows.length === 0) throw new NotFoundError("Liquidación no encontrada")
  return tx.playerSettlement.findUniqueOrThrow({
    where: { id },
    select: settlementCoreSelect,
  })
}

export type DebtInfo = {
  purchaseFolio: string
  sessionFolio: string
  tableName: string
  createdAt: Date
}

/**
 * Plan VIGENTE (deudas reales del jugador al momento): compensación según
 * la decisión del cajero, FIFO y neto. Nunca usa datos del navegador.
 */
export async function planForInTx(
  db: Db,
  input: {
    playerId: string
    returned: Prisma.Decimal
    decision: "NO_COMPENSATE" | "PARTIAL" | "MAXIMUM"
    requested: Prisma.Decimal | null
  }
): Promise<{ plan: SettlementPlan; debts: Map<string, DebtInfo> }> {
  const receivables = await receivablesOf(db, input.playerId)
  let plan: SettlementPlan
  try {
    plan = planSettlement({
      returned: input.returned,
      receivables,
      decision: input.decision,
      requested: input.requested,
    })
  } catch (e) {
    asBusiness(e)
  }
  const ids = receivables
    .filter((r) => r.balance.greaterThan(0))
    .map((r) => r.id)
  const rows = ids.length
    ? await db.playerDebt.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          createdAt: true,
          session: { select: { folio: true } },
          purchase: {
            select: { folio: true, table: { select: { name: true } } },
          },
        },
      })
    : []
  return {
    plan,
    debts: new Map(
      rows.map((d) => [
        d.id,
        {
          purchaseFolio: d.purchase.folio,
          sessionFolio: d.session.folio,
          tableName: d.purchase.table.name,
          createdAt: d.createdAt,
        },
      ])
    ),
  }
}

export function planInputOf(s: {
  playerId: string
  returnedNominalAmount: Prisma.Decimal
  offsetDecision: "NO_COMPENSATE" | "PARTIAL" | "MAXIMUM"
  requestedOffsetAmount: Prisma.Decimal | null
}) {
  return {
    playerId: s.playerId,
    returned: dec(s.returnedNominalAmount),
    decision: s.offsetDecision,
    requested: s.requestedOffsetAmount ? dec(s.requestedOffsetAmount) : null,
  }
}

/**
 * Parte MATERIAL de lo firmado: lo que compromete a ambas partes. Si al
 * confirmar la recepción el plan vigente no produce exactamente esto, la
 * confirmación se bloquea y se exige una nueva firma.
 */
export function materialOf(
  s: {
    id: string
    version: number
    playerId: string
    participationId: string
  },
  plan: SettlementPlan,
  declarationVersion: string
) {
  return {
    settlementId: s.id,
    settlementVersion: s.version,
    playerId: s.playerId,
    participationId: s.participationId,
    returnedNominalAmount: fmt(plan.returned),
    offsetDecision: plan.decision,
    offsetAmount: fmt(plan.offset),
    allocations: plan.allocations.map((a) => ({
      receivableId: a.receivableId,
      amount: fmt(a.amount),
    })),
    netPayoutAmount: fmt(plan.net),
    declarationVersion,
  }
}
export type SettlementMaterial = ReturnType<typeof materialOf>

export async function recordSettlementStatus(
  tx: Tx,
  settlementId: string,
  from: SettlementCore["status"] | null,
  to: SettlementCore["status"],
  actorId: string,
  reason?: string | null
) {
  await tx.settlementStatusHistory.create({
    data: {
      settlementId,
      fromStatus: from,
      toStatus: to,
      changedById: actorId,
      reason: reason ?? null,
    },
  })
}

/**
 * Invalida (o cancela) la firma VALID de una liquidación AÚN NO RECIBIDA.
 * La evidencia se conserva con motivo, responsable y fecha; la base impide
 * invalidar la firma de una recepción confirmada.
 */
export async function invalidateSettlementSignaturesInTx(
  tx: Tx,
  input: {
    settlementId: string
    actorId: string
    reason: string
    status?: "INVALIDATED" | "CANCELLED"
  },
  ctx: RequestContext = {}
) {
  const status = input.status ?? "INVALIDATED"
  const valid = await tx.settlementSignature.findMany({
    where: { settlementId: input.settlementId, status: "VALID" },
    select: {
      id: true,
      playerId: true,
      snapshot: { select: { payloadHash: true } },
    },
  })
  for (const s of valid) {
    const { count } = await tx.settlementSignature.updateMany({
      where: { id: s.id, status: "VALID" },
      data: {
        status,
        invalidatedAt: new Date(),
        invalidatedById: input.actorId,
        invalidationReason: input.reason,
      },
    })
    if (count !== 1) continue
    await recordAudit(
      {
        action: AUDIT_ACTIONS.SETTLEMENT_SIGNATURE_INVALIDATED,
        entityType: "SettlementSignature",
        entityId: s.id,
        actorUserId: input.actorId,
        requestId: ctx.requestId,
        metadata: {
          settlementId: input.settlementId,
          playerId: s.playerId,
          snapshotDigest: s.snapshot.payloadHash,
          status,
          reason: input.reason,
        },
      },
      tx
    )
  }
  return valid.length
}

/**
 * Cambio material antes de recibir: nueva versión, firma anterior
 * INVALIDATED (se conserva) y la liquidación vuelve a DRAFT.
 */
export async function bumpSettlementVersionInTx(
  tx: Tx,
  actor: { id: string },
  s: Pick<SettlementCore, "id" | "status" | "version">,
  reason: string,
  data: Prisma.PlayerSettlementUpdateManyMutationInput = {},
  ctx: RequestContext = {}
) {
  if (s.status !== "DRAFT" && s.status !== "READY_FOR_CONFIRMATION")
    throw new BusinessRuleError(
      "La recepción ya se confirmó: la liquidación no se edita."
    )
  await invalidateSettlementSignaturesInTx(
    tx,
    { settlementId: s.id, actorId: actor.id, reason },
    ctx
  )
  const { count } = await tx.playerSettlement.updateMany({
    where: { id: s.id, version: s.version, status: s.status },
    data: { ...data, version: s.version + 1, status: "DRAFT" },
  })
  if (count !== 1)
    throw new BusinessRuleError(
      "La liquidación cambió: recarga e intenta de nuevo."
    )
  if (s.status !== "DRAFT")
    await recordSettlementStatus(tx, s.id, s.status, "DRAFT", actor.id, reason)
  return s.version + 1
}

/**
 * Verificador REAL de liquidaciones para el Módulo 07: SETTLING exige la
 * recepción confirmada con pago pendiente; SETTLED, la liquidación pagada
 * (o revertida, sin pagos pendientes). Siempre de la misma participación,
 * jugador y sesión.
 */
export const settlementVerifier: SettlementVerifier = {
  async assertConfirmedSettlement(tx, settlementId, participation, target) {
    const s = await tx.playerSettlement.findUnique({
      where: { id: settlementId },
      select: {
        participationId: true,
        playerId: true,
        sessionId: true,
        status: true,
        receivedAt: true,
      },
    })
    if (
      !s ||
      s.participationId !== participation.id ||
      s.playerId !== participation.playerId ||
      s.sessionId !== participation.sessionId
    )
      throw new BusinessRuleError(
        "La liquidación no corresponde a esta participación."
      )
    if (!s.receivedAt)
      throw new BusinessRuleError(
        "La liquidación no tiene la recepción de fichas confirmada."
      )
    if (target === "SETTLING" && s.status !== "PENDING_PAYOUT")
      throw new BusinessRuleError("La liquidación no está pendiente de pago.")
    if (
      (target ?? "SETTLED") === "SETTLED" &&
      s.status !== "COMPLETED" &&
      s.status !== "REVERSED"
    )
      throw new BusinessRuleError(
        "La liquidación aún tiene pagos pendientes: la participación sigue en liquidación."
      )
  },
}

/** Cuenta por pagar bloqueada (FOR UPDATE) con su estado derivado. */
export async function lockPayable(tx: Tx, settlementId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "settlement_payables" WHERE "settlementId" = ${settlementId} FOR UPDATE
  `
  if (rows.length === 0)
    throw new BusinessRuleError(
      "La liquidación aún no tiene cuenta por pagar (confirma la recepción primero)."
    )
  const payable = await tx.settlementPayable.findUniqueOrThrow({
    where: { id: rows[0].id },
    select: {
      id: true,
      originalAmount: true,
      status: true,
      sourceSessionId: true,
      payouts: {
        orderBy: { sequence: "asc" },
        select: { id: true, amount: true, status: true, sequence: true },
      },
    },
  })
  return {
    payable,
    state: payableState(
      dec(payable.originalAmount),
      payable.payouts.map((p) => ({ amount: dec(p.amount), status: p.status }))
    ),
  }
}

/**
 * Recalcula la cuenta por pagar (dentro de la transacción del desembolso) y,
 * si quedó pagada, termina la liquidación y la participación (→ SETTLED).
 */
export async function refreshPayableInTx(
  tx: Tx,
  actor: SessionUser,
  settlement: Pick<
    SettlementCore,
    "id" | "status" | "participationId" | "playerId" | "sessionId" | "folio"
  >,
  ctx: RequestContext = {}
): Promise<PayableState> {
  const { payable, state } = await lockPayable(tx, settlement.id)
  if (payable.status !== state.status && payable.status !== "VOIDED") {
    await tx.settlementPayable.update({
      where: { id: payable.id },
      data: {
        status: state.status,
        ...(state.status === "PAID" ? { paidAt: new Date() } : {}),
      },
    })
  }
  if (state.status === "PAID" && settlement.status === "PENDING_PAYOUT") {
    const now = new Date()
    const { count } = await tx.playerSettlement.updateMany({
      where: { id: settlement.id, status: "PENDING_PAYOUT" },
      data: { status: "COMPLETED", completedAt: now },
    })
    if (count !== 1)
      throw new BusinessRuleError("La liquidación cambió de estado.")
    await recordSettlementStatus(
      tx,
      settlement.id,
      "PENDING_PAYOUT",
      "COMPLETED",
      actor.id,
      "Pago neto cubierto por completo"
    )
    await recordAudit(
      {
        action: AUDIT_ACTIONS.SETTLEMENT_COMPLETED,
        entityType: "PlayerSettlement",
        entityId: settlement.id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          folio: settlement.folio,
          playerId: settlement.playerId,
          sessionId: settlement.sessionId,
          participationId: settlement.participationId,
          netPayout: fmt(state.original),
          paid: fmt(state.executed),
          from: "PENDING_PAYOUT",
          to: "COMPLETED",
        },
      },
      tx
    )
    await completeParticipationFromSettlementInTx(
      tx,
      actor,
      {
        participationId: settlement.participationId,
        settlementId: settlement.id,
      },
      settlementVerifier,
      ctx
    )
  }
  return state
}
