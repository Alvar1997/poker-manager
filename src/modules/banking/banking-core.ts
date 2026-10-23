import "server-only"

import { createHash } from "node:crypto"

import { Prisma } from "@/generated/prisma/client"
import { AppError, BusinessRuleError, NotFoundError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import {
  AUDIT_ACTIONS,
  recordAudit,
  type AuditAction,
} from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import { lockPlayerInTx } from "@/modules/credits/receivable.service"

import {
  advanceLimit,
  canonicalJson,
  confirmedDeficit,
  dec,
  fmt,
  GAMES_PER_CYCLE,
  reserveBalance,
  segmentForGame,
  withdrawableReserve,
  ZERO,
  type Dec,
  type GameFact,
} from "./banking.math"

/**
 * Núcleo de servidor del Módulo 17 (PRIVADO): bloqueos, hechos derivados y
 * estados. Todo saldo (reserva, pérdida arrastrada, anticipos pagados,
 * recuperaciones) se DERIVA de filas inmutables; nunca hay un saldo
 * editable. Orden de bloqueos: sesión → mesa → participación → JUGADOR
 * (`lockPlayerInTx`, el mismo del Módulo 10) → filas de bancaje →
 * inventario → obligaciones especiales → saldos financieros.
 */

export type Tx = Prisma.TransactionClient
export type Db = Tx | typeof prisma
export const BANKING_TX = { maxWait: 15_000, timeout: 30_000 } as const

export { lockPlayerInTx }

export const sha256 = (s: string) =>
  createHash("sha256").update(s).digest("hex")
export const hashOf = (value: unknown) => sha256(canonicalJson(value))

export const ADVANCE_SOURCE = "BankingAdvance"
export const WITHDRAWAL_SOURCE = "BankingReserveWithdrawal"
export const CLOSING_SOURCE = "BankingCycleClosing"

// ── Acuerdos ──────────────────────────────────────────────────────────

export async function activeAgreementOf(db: Db, playerId: string) {
  return db.bankingAgreement.findFirst({
    where: { playerId, status: "ACTIVE" },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  })
}

export async function requireActiveAgreement(db: Db, playerId: string) {
  const a = await activeAgreementOf(db, playerId)
  if (!a || !a.versions[0])
    throw new BusinessRuleError(
      "El jugador no tiene un acuerdo de bancaje vigente."
    )
  return { agreement: a, version: a.versions[0] }
}

// ── Ciclos y jugadas ──────────────────────────────────────────────────

export const gameInclude = {
  sources: {
    select: { purchaseId: true, nominalAmount: true, createdAt: true },
  },
  adjustments: { select: { id: true, amount: true } },
  session: {
    select: { id: true, folio: true, businessDate: true, status: true },
  },
} satisfies Prisma.BankingGameInclude

type GameRow = Prisma.BankingGameGetPayload<{ include: typeof gameInclude }>

/** Resultado efectivo de una jugada conciliada: bruto + ajustes auditados. */
export function effectiveResult(g: {
  grossResult: Prisma.Decimal | null
  adjustments: { amount: Prisma.Decimal }[]
}): Dec {
  return g.adjustments.reduce(
    (a, x) => a.add(dec(x.amount)),
    dec(g.grossResult)
  )
}

/** Hechos del ciclo: jugadas, tramos y los GameFact de las confirmadas. */
export async function loadCycleFacts(db: Db, cycleId: string) {
  const cycle = await db.bankingCycle.findUnique({
    where: { id: cycleId },
    include: {
      games: { orderBy: { gameNumber: "asc" }, include: gameInclude },
      segments: { orderBy: { createdAt: "asc" } },
      player: { select: { id: true, name: true, nickname: true } },
    },
  })
  if (!cycle) throw new NotFoundError("Ciclo no encontrado")
  const segments = cycle.segments.map((s) => ({
    id: s.id,
    fromGameNumber: s.fromGameNumber,
    playerPercent: dec(s.playerPercent),
    createdAt: s.createdAt,
  }))
  const facts: GameFact[] = cycle.games
    .filter((g) => g.status === "CONFIRMED")
    .map((g) => {
      const seg = segmentForGame(segments, g.gameNumber)
      return {
        gameNumber: g.gameNumber,
        result: effectiveResult(g),
        segmentId: seg.id,
        playerPercent: seg.playerPercent,
      }
    })
  const unsettled = cycle.games.some((g) => g.status !== "CONFIRMED")
  return { cycle, segments, facts, unsettled, games: cycle.games as GameRow[] }
}

/**
 * Pérdida arrastrada al ciclo `number`: la del corte APROBADO del ciclo
 * anterior. null si el anterior existe y todavía no está cerrado (no se
 * puede garantizar el cálculo).
 */
export async function previousCarriedLoss(
  db: Db,
  playerId: string,
  cycleNumber: number
): Promise<Dec | null> {
  if (cycleNumber <= 1) return ZERO
  const prev = await db.bankingCycle.findUnique({
    where: { playerId_number: { playerId, number: cycleNumber - 1 } },
    select: {
      status: true,
      closings: {
        where: { status: "APPROVED" },
        select: { carriedLossOut: true },
      },
    },
  })
  if (!prev) return ZERO
  if (prev.status !== "CLOSED" || !prev.closings[0]) return null
  return dec(prev.closings[0].carriedLossOut)
}

export async function reserveBalanceOf(db: Db, playerId: string) {
  const rows = await db.bankingReserveMovement.findMany({
    where: { playerId },
    select: { kind: true, amount: true },
  })
  return reserveBalance(
    rows.map((r) => ({ kind: r.kind, amount: dec(r.amount) }))
  )
}

/** Excedentes que se acordó recuperar y su remanente (FIFO por antigüedad). */
export async function pendingRecoveriesOf(db: Db, playerId: string) {
  const regs = await db.bankingRegularization.findMany({
    where: { playerId, status: "RECOVERING" },
    orderBy: { openedAt: "asc" },
    include: {
      recoveries: { select: { amount: true } },
      receipts: { select: { amount: true } },
    },
  })
  const list = regs.map((r) => {
    const used = [...r.recoveries, ...r.receipts].reduce(
      (a, x) => a.add(dec(x.amount)),
      ZERO
    )
    return { id: r.id, remaining: dec(r.amount).sub(used) }
  })
  return {
    list: list.filter((x) => x.remaining.greaterThan(0)),
    total: list.reduce((a, x) => a.add(x.remaining), ZERO),
  }
}

/** Obligaciones especiales (Módulo 16) de un anticipo o retiro. */
export async function payablesOfSource(
  db: Db,
  sourceType: string,
  sourceId: string
) {
  return db.specialPayable.findMany({
    where: { sourceType, sourceId: { startsWith: `${sourceId}:` } },
    include: { payouts: { orderBy: { sequence: "asc" } } },
    orderBy: { createdAt: "asc" },
  })
}

export function payoutTotals(
  payables: {
    originalAmount: Prisma.Decimal
    payouts: { amount: Prisma.Decimal; status: string }[]
  }[]
) {
  let executed = ZERO
  let inTransit = ZERO
  let obligations = ZERO
  for (const p of payables) {
    obligations = obligations.add(dec(p.originalAmount))
    for (const x of p.payouts) {
      if (x.status === "EXECUTED") executed = executed.add(dec(x.amount))
      if (x.status === "PENDING") inTransit = inTransit.add(dec(x.amount))
    }
  }
  return { executed, inTransit, obligations, unpaid: obligations.sub(executed) }
}

/** Anticipos del ciclo: pagado (EXECUTED) y comprometido para el límite. */
export async function advancesOfCycle(db: Db, cycleId: string) {
  const advances = await db.bankingAdvance.findMany({
    where: { cycleId },
    orderBy: { recordedAt: "asc" },
  })
  let paid = ZERO
  let committed = ZERO
  let unresolved = 0
  const rows = []
  for (const a of advances) {
    const payables = await payablesOfSource(db, ADVANCE_SOURCE, a.id)
    const t = payoutTotals(payables)
    paid = paid.add(t.executed)
    const open = a.status === "AUTHORIZED" || a.status === "PARTIALLY_PAID"
    committed = committed.add(open ? dec(a.authorizedAmount) : t.obligations)
    if (open || t.inTransit.greaterThan(0) || t.unpaid.greaterThan(0))
      unresolved++
    rows.push({ advance: a, payables, totals: t })
  }
  return { rows, paid, committed, unresolved }
}

/** Retiros de reserva APROBADOS: comprometido pendiente (aprobado − pagado). */
export async function withdrawalsOf(db: Db, playerId: string) {
  const list = await db.bankingReserveWithdrawal.findMany({
    where: { playerId },
    orderBy: { requestedAt: "desc" },
  })
  const rows = []
  for (const w of list) {
    const payables = await payablesOfSource(db, WITHDRAWAL_SOURCE, w.id)
    rows.push({ withdrawal: w, payables, totals: payoutTotals(payables) })
  }
  return rows
}

/** Ciclo «vivo» del jugador (el último no cerrado), si existe. */
export async function openCycleOf(db: Db, playerId: string) {
  return db.bankingCycle.findFirst({
    where: { playerId, status: { not: "CLOSED" } },
    orderBy: { number: "desc" },
  })
}

/** Déficit confirmado de los ciclos abiertos que la reserva tendría que cubrir. */
export async function openCyclesDeficit(db: Db, playerId: string) {
  const open = await db.bankingCycle.findMany({
    where: { playerId, status: { not: "CLOSED" } },
    orderBy: { number: "asc" },
    select: { id: true, number: true },
  })
  let total = ZERO
  for (const c of open) {
    const f = await loadCycleFacts(db, c.id)
    const carried = (await previousCarriedLoss(db, playerId, c.number)) ?? ZERO
    total = total.add(
      confirmedDeficit({ games: f.facts, previousCarriedLoss: carried })
    )
  }
  return total
}

/** Estado de la reserva del jugador (todo derivado del libro). */
export async function reserveStateOf(db: Db, playerId: string) {
  const balance = await reserveBalanceOf(db, playerId)
  const deficit = await openCyclesDeficit(db, playerId)
  return {
    balance,
    openCyclesDeficit: deficit,
    withdrawable: withdrawableReserve({
      balance,
      currentCycleDeficit: deficit,
    }),
  }
}

/** Límite conservador de anticipos del ciclo (revalidado en cada transacción). */
export async function advanceLimitOf(db: Db, cycleId: string) {
  const f = await loadCycleFacts(db, cycleId)
  const carried = await previousCarriedLoss(
    db,
    f.cycle.playerId,
    f.cycle.number
  )
  const adv = await advancesOfCycle(db, cycleId)
  const recovery = await pendingRecoveriesOf(db, f.cycle.playerId)
  const openReg = await db.bankingRegularization.count({
    where: { playerId: f.cycle.playerId, status: "OPEN" },
  })
  const limit = advanceLimit({
    cycleOpen:
      f.cycle.status === "IN_PROGRESS" && f.games.length < GAMES_PER_CYCLE,
    previousCyclesClosed: carried !== null,
    unsettledGames: f.unsettled,
    openRegularization: openReg > 0,
    games: f.facts,
    previousCarriedLoss: carried ?? ZERO,
    committedAdvances: adv.committed,
    pendingRecovery: recovery.total,
  })
  return { ...limit, facts: f, advances: adv, carried, recovery }
}

/** Ciclo al que pertenece la siguiente jugada (crea el siguiente si hace falta). */
export async function cycleForNewGameInTx(
  tx: Tx,
  actor: SessionUser,
  agreement: { id: string; playerId: string },
  version: {
    id: string
    playerPercent: Prisma.Decimal
    housePercent: Prisma.Decimal
  },
  ctx: RequestContext
) {
  const last = await tx.bankingCycle.findFirst({
    where: { playerId: agreement.playerId },
    orderBy: { number: "desc" },
    include: { _count: { select: { games: true } } },
  })
  if (
    last &&
    last.agreementId === agreement.id &&
    last._count.games < GAMES_PER_CYCLE &&
    last.status !== "CLOSED"
  )
    return { cycle: last, created: false }
  const number = (last?.number ?? 0) + 1
  const cycle = await tx.bankingCycle.create({
    data: {
      playerId: agreement.playerId,
      agreementId: agreement.id,
      number,
      createdById: actor.id,
    },
  })
  await tx.bankingPercentageSegment.create({
    data: {
      cycleId: cycle.id,
      fromGameNumber: 1,
      agreementVersionId: version.id,
      playerPercent: version.playerPercent,
      housePercent: version.housePercent,
      createdById: actor.id,
    },
  })
  await audit(tx, actor, ctx, AUDIT_ACTIONS.BANKING_CYCLE_STARTED, {
    entityType: "BankingCycle",
    entityId: cycle.id,
    playerId: agreement.playerId,
    metadata: {
      cycleNumber: number,
      playerPercent: fmt(dec(version.playerPercent)),
    },
  })
  return { cycle: { ...cycle, _count: { games: 0 } }, created: true }
}

/** Recalcula el estado del ciclo a partir de sus jugadas y cortes. */
export async function refreshCycleStatusInTx(tx: Tx, cycleId: string) {
  const c = await tx.bankingCycle.findUniqueOrThrow({
    where: { id: cycleId },
    include: {
      games: { select: { status: true } },
      closings: { where: { status: "UNDER_REVIEW" }, select: { id: true } },
    },
  })
  if (c.status === "CLOSED") return c.status
  const next = c.games.some(
    (g) =>
      g.status === "PENDING_RECONCILIATION" || g.status === "UNDER_CORRECTION"
  )
    ? "UNDER_REGULARIZATION"
    : c.closings.length > 0
      ? "UNDER_REVIEW"
      : c.games.length === GAMES_PER_CYCLE &&
          c.games.every((g) => g.status === "CONFIRMED")
        ? "READY_FOR_REVIEW"
        : "IN_PROGRESS"
  if (next !== c.status)
    await tx.bankingCycle.update({
      where: { id: cycleId },
      data: {
        status: next,
        readyAt:
          next === "READY_FOR_REVIEW" && !c.readyAt ? new Date() : c.readyAt,
      },
    })
  return next
}

/**
 * Cualquier cambio de jugada, porcentaje, anticipo, reserva o distribución
 * INVALIDA el corte en revisión: una aprobación nunca vale para importes
 * distintos de los revisados.
 */
export async function supersedeOpenClosingsInTx(
  tx: Tx,
  actor: SessionUser,
  playerId: string,
  reason: string,
  ctx: RequestContext
) {
  const open = await tx.bankingCycleClosing.findMany({
    where: { status: "UNDER_REVIEW", cycle: { playerId } },
    select: { id: true, cycleId: true, version: true },
  })
  for (const c of open) {
    await tx.bankingCycleClosing.update({
      where: { id: c.id },
      data: { status: "SUPERSEDED", decisionNotes: reason },
    })
    await audit(tx, actor, ctx, AUDIT_ACTIONS.BANKING_CLOSING_SUPERSEDED, {
      entityType: "BankingCycleClosing",
      entityId: c.id,
      playerId,
      metadata: { cycleId: c.cycleId, version: c.version, reason },
    })
    await refreshCycleStatusInTx(tx, c.cycleId)
  }
  return open.length
}

// ── Auditoría ─────────────────────────────────────────────────────────

export async function audit(
  tx: Tx,
  actor: SessionUser,
  ctx: RequestContext,
  action: AuditAction,
  e: {
    entityType: string
    entityId: string
    playerId?: string | null
    sessionId?: string | null
    amount?: string | null
    reason?: string | null
    idempotencyKey?: string | null
    metadata?: Record<string, unknown>
  }
) {
  return recordAudit(
    {
      action,
      entityType: e.entityType,
      entityId: e.entityId,
      actorUserId: actor.id,
      actorRole: actor.role,
      requestId: ctx.requestId,
      playerId: e.playerId ?? null,
      sessionId: e.sessionId ?? null,
      amount: e.amount ?? null,
      reason: e.reason ?? null,
      idempotencyKey: e.idempotencyKey ?? null,
      metadata: e.metadata,
    },
    tx
  )
}

/** Registra el rechazo REAL de una operación de bancaje (fuera de la tx fallida). */
export async function auditBankingFailure(
  actor: SessionUser,
  entityType: string,
  entityId: string,
  error: unknown,
  ctx: RequestContext,
  denied = false
) {
  if (!(error instanceof AppError)) return
  try {
    await recordAudit({
      action: denied
        ? AUDIT_ACTIONS.BANKING_CLOSING_APPROVAL_DENIED
        : AUDIT_ACTIONS.BANKING_OPERATION_FAILED,
      entityType,
      entityId,
      actorUserId: actor.id,
      actorRole: actor.role,
      requestId: ctx.requestId,
      result: denied ? "DENIED" : "FAILURE",
      reason: error.message.slice(0, 500),
      metadata: { code: error.code },
    })
  } catch {
    // La auditoría del fallo nunca oculta el error original.
  }
}

/** Socio (PARTNER o SUPERADMIN) ACTIVO que autoriza verbalmente o por mensaje. */
export async function assertAuthorizerInTx(tx: Tx, userId: string) {
  const u = await tx.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, role: true, isActive: true },
  })
  if (!u || !u.isActive || (u.role !== "PARTNER" && u.role !== "SUPERADMIN"))
    throw new BusinessRuleError(
      "El autorizador debe ser un PARTNER o SUPERADMIN activo."
    )
  return u
}

export async function lockBankingRow(
  tx: Tx,
  table:
    | "banking_cycles"
    | "banking_games"
    | "banking_advances"
    | "banking_reserve_withdrawals"
    | "banking_regularizations"
    | "banking_cycle_closings"
    | "banking_percentage_change_requests",
  id: string
) {
  const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
    `SELECT "id" FROM "${table}" WHERE "id" = $1 FOR UPDATE`,
    id
  )
  if (rows.length === 0) throw new NotFoundError("Registro no encontrado")
}

export { dec, fmt, ZERO }
