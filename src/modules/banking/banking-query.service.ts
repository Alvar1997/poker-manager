import "server-only"

import { NotFoundError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import { payableView } from "@/modules/special-operations/special-payout.service"

import {
  ADVANCE_SOURCE,
  advanceLimitOf,
  effectiveResult,
  loadCycleFacts,
  payablesOfSource,
  payoutTotals,
  pendingRecoveriesOf,
  previousCarriedLoss,
  reserveStateOf,
  WITHDRAWAL_SOURCE,
} from "./banking-core"
import {
  computeCycle,
  cycleResultToJson,
  dec,
  fmt,
  GAMES_PER_CYCLE,
  segmentForGame,
  ZERO,
} from "./banking.math"

/**
 * Lecturas del Módulo 17 (PRIVADAS: solo rutas con `banking:read`). Nada de
 * esto se usa en la mesa ni en vistas compartidas. Todo importe es derivado.
 */

const user = { select: { id: true, name: true } } as const
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null

/** Pérdida pendiente de recuperar (arrastre del último corte aprobado). */
async function pendingLossOf(playerId: string) {
  const last = await prisma.bankingCycleClosing.findFirst({
    where: { status: "APPROVED", cycle: { playerId } },
    orderBy: { decidedAt: "desc" },
    select: { carriedLossOut: true },
  })
  return dec(last?.carriedLossOut)
}

export async function listAuthorizers() {
  return prisma.user.findMany({
    where: { isActive: true, role: { in: ["PARTNER", "SUPERADMIN"] } },
    orderBy: { name: "asc" },
    select: { id: true, name: true, role: true },
  })
}

export async function getBankingDashboard() {
  const [
    activeAgreements,
    inProgress,
    ready,
    underReview,
    regularization,
    closingsPending,
    withdrawalsPending,
    changesPending,
    regsOpen,
    reserveRows,
    payables,
  ] = await Promise.all([
    prisma.bankingAgreement.count({ where: { status: "ACTIVE" } }),
    prisma.bankingCycle.count({ where: { status: "IN_PROGRESS" } }),
    prisma.bankingCycle.count({ where: { status: "READY_FOR_REVIEW" } }),
    prisma.bankingCycle.count({ where: { status: "UNDER_REVIEW" } }),
    prisma.bankingCycle.count({ where: { status: "UNDER_REGULARIZATION" } }),
    prisma.bankingCycleClosing.count({ where: { status: "UNDER_REVIEW" } }),
    prisma.bankingReserveWithdrawal.count({ where: { status: "REQUESTED" } }),
    prisma.bankingPercentageChangeRequest.count({
      where: { status: "PENDING" },
    }),
    prisma.bankingRegularization.count({
      where: { status: { in: ["OPEN", "AWAITING_RETURN", "RECOVERING"] } },
    }),
    prisma.bankingReserveMovement.groupBy({
      by: ["kind"],
      _sum: { amount: true },
    }),
    prisma.specialPayable.findMany({
      where: {
        kind: {
          in: [
            "BANKING_ADVANCE",
            "BANKING_CYCLE_PAYOUT",
            "BANKING_RESERVE_WITHDRAWAL",
          ],
        },
      },
      include: { payouts: true },
    }),
  ])
  let reserves = ZERO
  for (const r of reserveRows) {
    const v = dec(r._sum.amount)
    reserves =
      r.kind === "CREATED" || r.kind === "RELEASED_FROM_WITHDRAWAL"
        ? reserves.add(v)
        : reserves.sub(v)
  }
  const advancePayables = payables.filter((p) => p.kind === "BANKING_ADVANCE")
  const advancesPaid = payoutTotals(advancePayables).executed
  const all = payoutTotals(payables)
  const losses = await prisma.bankingCycleClosing.findMany({
    where: { status: "APPROVED", carriedLossOut: { gt: 0 } },
    select: { carriedLossOut: true, cycle: { select: { playerId: true } } },
    orderBy: { decidedAt: "desc" },
  })
  const seen = new Set<string>()
  let pendingLosses = ZERO
  for (const l of losses) {
    if (seen.has(l.cycle.playerId)) continue
    seen.add(l.cycle.playerId)
    pendingLosses = pendingLosses.add(dec(l.carriedLossOut))
  }
  return {
    activeAgreements,
    cycles: { inProgress, ready, underReview, regularization },
    closingsPending,
    withdrawalsPending,
    changesPending,
    regularizationsOpen: regsOpen,
    /** Saldos CONTABLES (no son dinero en caja). */
    accounting: {
      reserves: fmt(reserves),
      pendingLosses: fmt(pendingLosses),
    },
    /** Movimientos REALES de dinero (pagos ejecutados y pendientes). */
    money: {
      advancesPaid: fmt(advancesPaid),
      paidTotal: fmt(all.executed),
      inTransit: fmt(all.inTransit),
      pendingPayables: fmt(all.unpaid),
    },
  }
}

export async function listBankedPlayers() {
  const agreements = await prisma.bankingAgreement.findMany({
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    include: {
      player: { select: { id: true, name: true, nickname: true } },
      versions: { orderBy: { version: "desc" }, take: 1 },
    },
  })
  const out = []
  for (const a of agreements) {
    const cycle = await prisma.bankingCycle.findFirst({
      where: { playerId: a.playerId },
      orderBy: { number: "desc" },
      include: { games: { select: { status: true } } },
    })
    const reserve = await reserveStateOf(prisma, a.playerId)
    out.push({
      agreementId: a.id,
      status: a.status,
      player: a.player,
      playerPercent: fmt(dec(a.versions[0]?.playerPercent)),
      housePercent: fmt(dec(a.versions[0]?.housePercent)),
      cycle: cycle
        ? {
            id: cycle.id,
            number: cycle.number,
            status: cycle.status,
            confirmed: cycle.games.filter((g) => g.status === "CONFIRMED")
              .length,
            games: cycle.games.length,
          }
        : null,
      reserve: fmt(reserve.balance),
      pendingLoss: fmt(await pendingLossOf(a.playerId)),
    })
  }
  return out
}

function gameView(
  g: Awaited<ReturnType<typeof loadCycleFacts>>["games"][number],
  percent: string
) {
  return {
    id: g.id,
    gameNumber: g.gameNumber,
    status: g.status,
    version: g.version,
    session: {
      id: g.session.id,
      folio: g.session.folio,
      businessDate: g.session.businessDate.toISOString().slice(0, 10),
      status: g.session.status,
    },
    financed: fmt(
      g.sources.reduce((a, s) => a.add(dec(s.nominalAmount)), ZERO)
    ),
    purchases: g.sources.length,
    returned: g.returnedNominal ? fmt(dec(g.returnedNominal)) : null,
    zeroReturnConfirmed: g.zeroReturnConfirmed,
    grossResult: g.grossResult ? fmt(dec(g.grossResult)) : null,
    adjustments: fmt(
      g.adjustments.reduce((a, x) => a.add(dec(x.amount)), ZERO)
    ),
    effectiveResult: g.grossResult ? fmt(effectiveResult(g)) : null,
    playerPercent: percent,
    discrepancyNotes: g.discrepancyNotes,
    confirmedAt: iso(g.confirmedAt),
  }
}

export async function getCycle(cycleId: string) {
  const f = await loadCycleFacts(prisma, cycleId)
  const carried = await previousCarriedLoss(
    prisma,
    f.cycle.playerId,
    f.cycle.number
  )
  const [closings, segments, limit, reserve, recovery] = await Promise.all([
    prisma.bankingCycleClosing.findMany({
      where: { cycleId },
      orderBy: { version: "desc" },
      include: { preparedBy: user, decidedBy: user },
    }),
    prisma.bankingPercentageSegment.findMany({
      where: { cycleId },
      orderBy: { createdAt: "asc" },
      include: { createdBy: user },
    }),
    advanceLimitOf(prisma, cycleId),
    reserveStateOf(prisma, f.cycle.playerId),
    pendingRecoveriesOf(prisma, f.cycle.playerId),
  ])
  const provisional =
    f.facts.length > 0
      ? cycleResultToJson(
          computeCycle({
            games: f.facts,
            previousCarriedLoss: carried ?? ZERO,
            reserveAvailable: reserve.balance,
            advancesPaid: limit.advances.paid,
            pendingRecovery: recovery.total,
            allocation: null,
          })
        )
      : null
  const payables = await Promise.all(
    closings
      .filter((c) => c.payableId)
      .map(async (c) =>
        prisma.specialPayable.findUnique({
          where: { id: c.payableId! },
          include: { payouts: { orderBy: { sequence: "asc" } } },
        })
      )
  )
  return {
    id: f.cycle.id,
    number: f.cycle.number,
    status: f.cycle.status,
    player: f.cycle.player,
    startedAt: f.cycle.startedAt.toISOString(),
    closedAt: iso(f.cycle.closedAt),
    gamesPerCycle: GAMES_PER_CYCLE,
    games: f.games.map((g) =>
      gameView(g, fmt(segmentForGame(f.segments, g.gameNumber).playerPercent))
    ),
    segments: segments.map((s) => ({
      id: s.id,
      fromGameNumber: s.fromGameNumber,
      playerPercent: fmt(dec(s.playerPercent)),
      housePercent: fmt(dec(s.housePercent)),
      createdAt: s.createdAt.toISOString(),
      createdBy: s.createdBy,
      changeRequestId: s.changeRequestId,
    })),
    previousCarriedLoss: carried === null ? null : fmt(carried),
    provisional,
    advanceLimit: {
      guaranteedShare: fmt(limit.guaranteedShare),
      committed: fmt(limit.committed),
      available: fmt(limit.available),
      blockedReason: limit.blockedReason,
      paid: fmt(limit.advances.paid),
    },
    advances: limit.advances.rows.map((x) => ({
      id: x.advance.id,
      status: x.advance.status,
      authorized: fmt(dec(x.advance.authorizedAmount)),
      paid: fmt(x.totals.executed),
      inTransit: fmt(x.totals.inTransit),
      authorizerName: x.advance.authorizerName,
      channel: x.advance.channel,
      recordedAt: x.advance.recordedAt.toISOString(),
    })),
    closings: closings.map((c) => ({
      id: c.id,
      version: c.version,
      status: c.status,
      snapshotHash: c.snapshotHash,
      snapshot: c.snapshot,
      grossTotal: fmt(dec(c.grossTotal)),
      playerShare: fmt(dec(c.playerShare)),
      houseShare: fmt(dec(c.houseShare)),
      advancesPaid: fmt(dec(c.advancesPaid)),
      reserveConsumed: fmt(dec(c.reserveConsumed)),
      reserveAmount: fmt(dec(c.reserveAmount)),
      payAmount: fmt(dec(c.payAmount)),
      carriedLossOut: fmt(dec(c.carriedLossOut)),
      excessAdvance: fmt(dec(c.excessAdvance)),
      recoveryApplied: fmt(dec(c.recoveryApplied)),
      notes: c.notes,
      decisionNotes: c.decisionNotes,
      preparedBy: c.preparedBy,
      preparedAt: c.preparedAt.toISOString(),
      decidedBy: c.decidedBy,
      decidedAt: iso(c.decidedAt),
      payable: payables.find((p) => p?.id === c.payableId)
        ? payableView(payables.find((p) => p?.id === c.payableId)!)
        : null,
    })),
  }
}
export type BankingCycleView = Awaited<ReturnType<typeof getCycle>>

export async function getBankedPlayer(playerId: string) {
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: { id: true, name: true, nickname: true, isActive: true },
  })
  if (!player) throw new NotFoundError("Jugador no encontrado")
  const [agreements, cycles, movements, changeRequests, regs, reserve] =
    await Promise.all([
      prisma.bankingAgreement.findMany({
        where: { playerId },
        orderBy: { createdAt: "desc" },
        include: {
          versions: {
            orderBy: { version: "desc" },
            include: { approvedBy: user, createdBy: user },
          },
          createdBy: user,
        },
      }),
      prisma.bankingCycle.findMany({
        where: { playerId },
        orderBy: { number: "desc" },
        include: {
          games: {
            select: { status: true, grossResult: true, adjustments: true },
          },
        },
      }),
      prisma.bankingReserveMovement.findMany({
        where: { playerId },
        orderBy: { createdAt: "desc" },
        include: { createdBy: user },
      }),
      prisma.bankingPercentageChangeRequest.findMany({
        where: { agreement: { playerId } },
        orderBy: { requestedAt: "desc" },
        include: { requestedBy: user, decidedBy: user },
      }),
      prisma.bankingRegularization.findMany({
        where: { playerId },
        orderBy: { openedAt: "desc" },
        include: { recoveries: true, receipts: true },
      }),
      reserveStateOf(prisma, playerId),
    ])
  // Participación ACTIVA en la sesión abierta (para compras financiadas y
  // conciliación) y su jugada.
  const active = await prisma.tableParticipation.findFirst({
    where: { playerId, status: "ACTIVE", session: { status: "OPEN" } },
    select: {
      id: true,
      sessionId: true,
      session: { select: { folio: true } },
      sessionTable: { select: { table: { select: { name: true } } } },
    },
  })
  const currentGame = active
    ? await prisma.bankingGame.findUnique({
        where: {
          playerId_sessionId: { playerId, sessionId: active.sessionId },
        },
        include: { sources: true },
      })
    : null
  const ownPurchases = active
    ? await prisma.chipPurchase.count({
        where: {
          sessionId: active.sessionId,
          playerId,
          fundingSource: "PLAYER",
          status: { in: ["DRAFT", "READY_FOR_DELIVERY", "CONFIRMED"] },
        },
      })
    : 0
  const withdrawals = []
  for (const w of await prisma.bankingReserveWithdrawal.findMany({
    where: { playerId },
    orderBy: { requestedAt: "desc" },
    include: { requestedBy: user, decidedBy: user },
  })) {
    const payables = await payablesOfSource(prisma, WITHDRAWAL_SOURCE, w.id)
    const t = payoutTotals(payables)
    withdrawals.push({
      id: w.id,
      status: w.status,
      requested: fmt(dec(w.requestedAmount)),
      approved: w.approvedAmount ? fmt(dec(w.approvedAmount)) : null,
      paid: fmt(t.executed),
      inTransit: fmt(t.inTransit),
      unpaidObligations: fmt(t.unpaid),
      reason: w.reason,
      requestedBy: w.requestedBy,
      requestedAt: w.requestedAt.toISOString(),
      decidedBy: w.decidedBy,
      decidedAt: iso(w.decidedAt),
      payables: payables.map(payableView),
    })
  }
  const advances = []
  for (const a of await prisma.bankingAdvance.findMany({
    where: { playerId },
    orderBy: { recordedAt: "desc" },
    include: { recordedBy: user, cycle: { select: { number: true } } },
  })) {
    const payables = await payablesOfSource(prisma, ADVANCE_SOURCE, a.id)
    const t = payoutTotals(payables)
    advances.push({
      id: a.id,
      cycleId: a.cycleId,
      cycleNumber: a.cycle.number,
      status: a.status,
      requested: fmt(dec(a.requestedAmount)),
      authorized: fmt(dec(a.authorizedAmount)),
      limitAtRegistration: fmt(dec(a.limitAtRegistration)),
      paid: fmt(t.executed),
      inTransit: fmt(t.inTransit),
      unpaidObligations: fmt(t.unpaid),
      authorizerName: a.authorizerName,
      channel: a.channel,
      recordedBy: a.recordedBy,
      recordedAt: a.recordedAt.toISOString(),
      payables: payables.map(payableView),
    })
  }
  const agreement = agreements.find((a) => a.status === "ACTIVE") ?? null
  const openSession = await prisma.pokerSession.findFirst({
    where: { status: "OPEN" },
    select: { id: true, folio: true },
  })
  return {
    player,
    /** Sesión ABIERTA (su caja puede pagar; el servidor lo revalida). */
    openSession,
    agreement: agreement
      ? {
          id: agreement.id,
          playerPercent: fmt(dec(agreement.versions[0]?.playerPercent)),
          housePercent: fmt(dec(agreement.versions[0]?.housePercent)),
          createdAt: agreement.createdAt.toISOString(),
        }
      : null,
    agreements: agreements.map((a) => ({
      id: a.id,
      status: a.status,
      createdAt: a.createdAt.toISOString(),
      endedAt: iso(a.endedAt),
      endReason: a.endReason,
      versions: a.versions.map((v) => ({
        version: v.version,
        playerPercent: fmt(dec(v.playerPercent)),
        housePercent: fmt(dec(v.housePercent)),
        reason: v.reason,
        effectiveFrom: v.effectiveFrom.toISOString(),
        approvedBy: v.approvedBy,
        createdBy: v.createdBy,
      })),
    })),
    cycles: cycles.map((c) => ({
      id: c.id,
      number: c.number,
      status: c.status,
      games: c.games.length,
      confirmed: c.games.filter((g) => g.status === "CONFIRMED").length,
      net: fmt(
        c.games
          .filter((g) => g.status === "CONFIRMED")
          .reduce(
            (a, g) =>
              a.add(
                effectiveResult({
                  grossResult: g.grossResult,
                  adjustments: g.adjustments,
                })
              ),
            ZERO
          )
      ),
    })),
    reserve: {
      balance: fmt(reserve.balance),
      withdrawable: fmt(reserve.withdrawable),
      openCyclesDeficit: fmt(reserve.openCyclesDeficit),
      movements: movements.map((m) => ({
        id: m.id,
        kind: m.kind,
        amount: fmt(dec(m.amount)),
        notes: m.notes,
        createdAt: m.createdAt.toISOString(),
        createdBy: m.createdBy,
      })),
    },
    pendingLoss: fmt(await pendingLossOf(playerId)),
    advances,
    withdrawals,
    changeRequests: changeRequests.map((r) => ({
      id: r.id,
      status: r.status,
      mode: r.mode,
      from: fmt(dec(r.fromPlayerPercent)),
      to: fmt(dec(r.toPlayerPercent)),
      startGameNumber: r.startGameNumber,
      reason: r.reason,
      requestedBy: r.requestedBy,
      requestedAt: r.requestedAt.toISOString(),
      decidedBy: r.decidedBy,
      decidedAt: iso(r.decidedAt),
      decisionNotes: r.decisionNotes,
      before: r.beforeCalculation,
      after: r.afterCalculation,
    })),
    regularizations: regs.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      amount: fmt(dec(r.amount)),
      description: r.description,
      resolution: r.resolution,
      resolutionNotes: r.resolutionNotes,
      recovered: fmt(r.recoveries.reduce((a, x) => a.add(dec(x.amount)), ZERO)),
      received: fmt(r.receipts.reduce((a, x) => a.add(dec(x.amount)), ZERO)),
      openedAt: r.openedAt.toISOString(),
    })),
    live: active
      ? {
          participationId: active.id,
          sessionId: active.sessionId,
          sessionFolio: active.session.folio,
          tableName: active.sessionTable.table.name,
          ownPurchases,
          game: currentGame
            ? {
                id: currentGame.id,
                status: currentGame.status,
                version: currentGame.version,
                financed: fmt(
                  currentGame.sources.reduce(
                    (a, s) => a.add(dec(s.nominalAmount)),
                    ZERO
                  )
                ),
                purchases: currentGame.sources.length,
              }
            : null,
        }
      : null,
  }
}
export type BankedPlayerView = Awaited<ReturnType<typeof getBankedPlayer>>

export async function listBankingRegularizations() {
  const rows = await prisma.bankingRegularization.findMany({
    orderBy: [{ status: "asc" }, { openedAt: "desc" }],
    include: {
      player: { select: { id: true, name: true } },
      recoveries: true,
      receipts: true,
    },
  })
  return rows.map((r) => ({
    id: r.id,
    player: r.player,
    kind: r.kind,
    status: r.status,
    amount: fmt(dec(r.amount)),
    description: r.description,
    resolution: r.resolution,
    resolutionNotes: r.resolutionNotes,
    recovered: fmt(r.recoveries.reduce((a, x) => a.add(dec(x.amount)), ZERO)),
    received: fmt(r.receipts.reduce((a, x) => a.add(dec(x.amount)), ZERO)),
    openedAt: r.openedAt.toISOString(),
    resolvedAt: iso(r.resolvedAt),
  }))
}

export async function listBankingClosings() {
  const rows = await prisma.bankingCycleClosing.findMany({
    orderBy: { preparedAt: "desc" },
    take: 200,
    include: {
      cycle: {
        select: {
          id: true,
          number: true,
          player: { select: { id: true, name: true } },
        },
      },
      preparedBy: user,
      decidedBy: user,
    },
  })
  return rows.map((c) => ({
    id: c.id,
    cycle: c.cycle,
    version: c.version,
    status: c.status,
    playerShare: fmt(dec(c.playerShare)),
    reserveAmount: fmt(dec(c.reserveAmount)),
    payAmount: fmt(dec(c.payAmount)),
    carriedLossOut: fmt(dec(c.carriedLossOut)),
    excessAdvance: fmt(dec(c.excessAdvance)),
    preparedBy: c.preparedBy,
    preparedAt: c.preparedAt.toISOString(),
    decidedBy: c.decidedBy,
    decidedAt: iso(c.decidedAt),
  }))
}

export async function listBankingCycles() {
  const rows = await prisma.bankingCycle.findMany({
    orderBy: [{ startedAt: "desc" }],
    take: 200,
    include: {
      player: { select: { id: true, name: true } },
      games: { select: { status: true } },
    },
  })
  return rows.map((c) => ({
    id: c.id,
    number: c.number,
    status: c.status,
    player: c.player,
    games: c.games.length,
    confirmed: c.games.filter((g) => g.status === "CONFIRMED").length,
    startedAt: c.startedAt.toISOString(),
    closedAt: iso(c.closedAt),
  }))
}

/** Anticipos, retiros y reservas de todos los jugadores (listados). */
export async function listBankingMoney() {
  const agreements = await prisma.bankingAgreement.findMany({
    select: { playerId: true },
    distinct: ["playerId"],
  })
  const players = []
  for (const a of agreements) players.push(await getBankedPlayer(a.playerId))
  return players
}

export async function bankablePlayers(q: string) {
  return prisma.player.findMany({
    where: {
      isActive: true,
      bankingAgreements: { none: { status: "ACTIVE" } },
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { nickname: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { name: "asc" },
    take: q ? 20 : 300,
    select: { id: true, name: true, nickname: true },
  })
}
