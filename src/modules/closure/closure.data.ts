import "server-only"

import type { Prisma } from "@/generated/prisma/client"
import { canonicalHash } from "@/lib/canonical-json"
import { NotFoundError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import { appliedByReceivable } from "@/modules/credits/receivable.service"
import { sharedChipSetId } from "@/modules/inventory/inventory.core"
import {
  getGlobalChipPosition,
  getSessionChipFlows,
  getSessionChipReconciliation,
} from "@/modules/closure/chip-circulation.service"
import {
  cashFromEntries,
  chipPosition,
  closureKindFor,
  custodyFlows,
  dec,
  evaluateReadiness,
  fmt,
  sortFindings,
  summarizeFindings,
  ZERO,
  type Finding,
} from "@/modules/closure/closure.math"

/**
 * Lecturas del cierre (Módulo 12). Todo se DERIVA de registros reales
 * (ciclos, participaciones, compras, liquidaciones, libro nominal de
 * fichas, libro financiero); no hay banderas editables. Cada función acepta
 * la transacción del cierre para volver a evaluar bajo bloqueo.
 */

export type Db = Prisma.TransactionClient | typeof prisma

const user = { select: { id: true, name: true } } as const

// ── Sesión e intento de cierre ────────────────────────────────────────

export async function loadSessionHead(db: Db, sessionId: string) {
  const s = await db.pokerSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      folio: true,
      status: true,
      openedAt: true,
      closingStartedAt: true,
      closedAt: true,
      createdBy: user,
      openedBy: user,
      opening: {
        select: { chipStockCountId: true, confirmedAt: true },
      },
    },
  })
  if (!s) throw new NotFoundError("Sesión no encontrada")
  return s
}

const closureSelect = {
  id: true,
  sessionId: true,
  attemptNumber: true,
  status: true,
  kind: true,
  noActivityReason: true,
  startedAt: true,
  startedBy: user,
  returnedAt: true,
  returnedBy: user,
  returnReason: true,
  forgottenOperationAt: true,
  completedAt: true,
} satisfies Prisma.SessionClosureSelect

export type ClosureRecord = Prisma.SessionClosureGetPayload<{
  select: typeof closureSelect
}>

/** Intento vigente (IN_PROGRESS) o, si no hay, el más reciente. */
export async function currentClosure(db: Db, sessionId: string) {
  return db.sessionClosure.findFirst({
    where: { sessionId },
    orderBy: { attemptNumber: "desc" },
    select: closureSelect,
  })
}

export async function closureAttempts(db: Db, sessionId: string) {
  return db.sessionClosure.findMany({
    where: { sessionId },
    orderBy: { attemptNumber: "asc" },
    select: closureSelect,
  })
}

// ── Prevalidación ─────────────────────────────────────────────────────

/** Saldo pendiente derivado de las cuentas por pagar de la sesión. */
export async function payablesPendingOf(db: Db, sessionId: string) {
  const payables = await db.settlementPayable.findMany({
    where: {
      sourceSessionId: sessionId,
      status: { in: ["OPEN", "PARTIALLY_PAID"] },
    },
    select: {
      id: true,
      playerId: true,
      originalAmount: true,
      payouts: { select: { amount: true, status: true } },
    },
  })
  let pending = ZERO
  let inTransit = ZERO
  for (const p of payables) {
    const executed = p.payouts
      .filter((x) => x.status === "EXECUTED")
      .reduce((acc, x) => acc.add(x.amount), ZERO)
    pending = pending.add(dec(p.originalAmount).sub(executed))
    inTransit = inTransit.add(
      p.payouts
        .filter((x) => x.status === "PENDING")
        .reduce((acc, x) => acc.add(x.amount), ZERO)
    )
  }
  return {
    count: payables.length,
    players: new Set(payables.map((p) => p.playerId)).size,
    pending,
    inTransit,
  }
}

/** Deudas NACIDAS en la sesión con saldo derivado (sobreviven al cierre). */
export async function sessionDebtsOf(db: Db, sessionId: string) {
  const debts = await db.playerDebt.findMany({
    where: { sessionId },
    select: { id: true, playerId: true, originalAmount: true },
  })
  const applied = await appliedByReceivable(
    db,
    debts.map((d) => d.id)
  )
  let originated = ZERO
  let outstanding = ZERO
  const players = new Set<string>()
  for (const d of debts) {
    originated = originated.add(d.originalAmount)
    const balance = dec(d.originalAmount).sub(applied.get(d.id) ?? ZERO)
    if (balance.greaterThan(0)) {
      outstanding = outstanding.add(balance)
      players.add(d.playerId)
    }
  }
  return {
    count: debts.length,
    originated,
    outstanding,
    playersWithBalance: players.size,
  }
}

async function cashBalanceRow(db: Db, sessionId: string) {
  const row = await db.financialAccountBalance.findFirst({
    where: { scopeKey: sessionId, account: { kind: "CASH_ON_HAND" } },
    select: { balance: true, version: true },
  })
  return { balance: dec(row?.balance), version: row?.version ?? 0 }
}

async function cardClearingGlobal(db: Db) {
  const row = await db.financialAccountBalance.findFirst({
    where: { scopeKey: "GLOBAL", account: { kind: "CARD_TERMINAL_CLEARING" } },
    select: { balance: true },
  })
  return dec(row?.balance)
}

/** Arqueos que NO son el arqueo de cierre de esta sesión (incluye sesión nula). */
function notThisClosing(sessionId: string): Prisma.ChipStockCountWhereInput[] {
  return [
    { sessionId: null },
    { sessionId: { not: sessionId } },
    { countType: { not: "CLOSING" } },
  ]
}

/**
 * Prevalidación global: BLOCKING impide iniciar/confirmar el cierre;
 * WARNING e INFO se muestran sin bloquear (deudas, pagos pendientes,
 * transferencias pendientes, fichas no retornadas…). Nunca marca como
 * conciliado algo que no lo está.
 */
export async function computePrecheck(db: Db, sessionId: string) {
  const session = await loadSessionHead(db, sessionId)
  const chipSetId = await sharedChipSetId(db)
  const closure = await currentClosure(db, sessionId)
  const since =
    closure?.status === "IN_PROGRESS" ? closure.startedAt : new Date(0)
  const [
    openTables,
    openCycles,
    tableCycles,
    activeParticipants,
    settlingParticipants,
    pendingPurchases,
    settlementsInProgress,
    activeReservations,
    otherChipDrafts,
    pendingChipCounts,
    cashDrafts,
    pendingCashControls,
    incomingTransfers,
    cashDeposits,
    outgoingPayouts,
    unapplied,
    cardPurchasesPending,
    cardAbonosPending,
  ] = await Promise.all([
    db.sessionTable.findMany({
      where: { sessionId, status: "OPEN" },
      orderBy: { table: { name: "asc" } },
      select: { table: { select: { name: true } } },
    }),
    db.sessionTableCycle.count({
      where: { sessionTable: { sessionId }, status: "OPEN" },
    }),
    db.sessionTableCycle.count({ where: { sessionTable: { sessionId } } }),
    db.tableParticipation.count({ where: { sessionId, status: "ACTIVE" } }),
    db.tableParticipation.count({ where: { sessionId, status: "SETTLING" } }),
    db.chipPurchase.findMany({
      where: { sessionId, status: { in: ["DRAFT", "READY_FOR_DELIVERY"] } },
      orderBy: { folio: "asc" },
      select: { folio: true },
    }),
    db.playerSettlement.findMany({
      where: {
        sessionId,
        status: { in: ["DRAFT", "READY_FOR_CONFIRMATION"] },
      },
      orderBy: { folio: "asc" },
      select: { folio: true },
    }),
    db.chipReservation.count({ where: { chipSetId, status: "ACTIVE" } }),
    db.chipStockCount.count({
      where: { chipSetId, status: "DRAFT", OR: notThisClosing(sessionId) },
    }),
    db.chipStockCount.count({
      where: {
        chipSetId,
        status: "CONFIRMED",
        reconciliationStatus: "PENDING",
        OR: notThisClosing(sessionId),
      },
    }),
    db.cashReconciliation.count({ where: { sessionId, status: "DRAFT" } }),
    db.cashReconciliation.count({
      where: {
        sessionId,
        status: "CONFIRMED",
        differenceStatus: "PENDING",
        reconciliationType: { not: "CLOSING" },
      },
    }),
    db.bankTransferVerification.aggregate({
      where: {
        sessionId,
        kind: "PLAYER_PAYMENT",
        status: "PENDING_VERIFICATION",
      },
      _count: { _all: true },
      _sum: { declaredAmount: true },
    }),
    db.bankTransferVerification.aggregate({
      where: {
        sessionId,
        kind: "CASH_DEPOSIT",
        status: "PENDING_VERIFICATION",
      },
      _count: { _all: true },
      _sum: { declaredAmount: true },
    }),
    db.settlementPayout.aggregate({
      where: {
        status: "PENDING",
        method: "BANK_TRANSFER",
        payable: { sourceSessionId: sessionId },
      },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    db.unappliedPlayerFunds.aggregate({
      where: {
        status: "PENDING_RESOLUTION",
        bankTransfer: { sessionId },
      },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    db.purchasePayment.aggregate({
      where: {
        purchase: { sessionId, status: { in: ["CONFIRMED", "REVERSED"] } },
        method: { in: ["CARD_DEBIT", "CARD_CREDIT"] },
        status: "APPROVED",
        cardSettlementId: null,
      },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    db.receivablePayment.aggregate({
      where: {
        sessionId,
        method: { in: ["CARD_DEBIT", "CARD_CREDIT"] },
        status: "CONFIRMED",
        cardSettlementId: null,
      },
      _count: { _all: true },
      _sum: { amount: true },
    }),
  ])
  const [debts, payables, flows, global, cash, lastCount] = await Promise.all([
    sessionDebtsOf(db, sessionId),
    payablesPendingOf(db, sessionId),
    getSessionChipReconciliation(db, sessionId),
    getGlobalChipPosition(db),
    cashBalanceRow(db, sessionId),
    db.chipStockCount.findFirst({
      where: {
        chipSetId,
        status: "CONFIRMED",
        reconciliationStatus: { in: ["NOT_REQUIRED", "RECONCILED"] },
      },
      orderBy: { confirmedAt: "desc" },
      select: { id: true, countType: true, confirmedAt: true },
    }),
  ])

  const f: Finding[] = []
  const add = (x: Finding) => f.push(x)

  if (session.status !== "OPEN" && session.status !== "CLOSING") {
    add({
      code: "SESSION_NOT_OPERABLE",
      severity: "BLOCKING",
      title: "Sesión no disponible para cierre",
      detail: `La sesión está ${session.status}: solo una sesión abierta (o en cierre) se cierra.`,
    })
  }
  if (openTables.length > 0 || openCycles > 0) {
    add({
      code: "OPEN_TABLES",
      severity: "BLOCKING",
      title: "Mesas abiertas",
      detail: `Cierra ${openTables.map((t) => t.table.name).join(" y ") || "las mesas"} antes del cierre (cada mesa cierra su ciclo por separado).`,
      count: Math.max(openTables.length, openCycles),
    })
  }
  if (activeParticipants > 0) {
    add({
      code: "ACTIVE_PARTICIPANTS",
      severity: "BLOCKING",
      title: "Jugadores todavía jugando",
      detail: `${activeParticipants} participación(es) activa(s): liquídalas o transfiérelas antes de cerrar su mesa.`,
      count: activeParticipants,
    })
  }
  if (pendingPurchases.length > 0) {
    add({
      code: "PURCHASES_PENDING_DELIVERY",
      severity: "BLOCKING",
      title: "Compras sin entrega resuelta",
      detail: `Entrega o cancela: ${pendingPurchases.map((p) => p.folio).join(", ")} (incluye firmas pendientes que bloquean la entrega).`,
      count: pendingPurchases.length,
    })
  }
  if (settlementsInProgress.length > 0) {
    add({
      code: "SETTLEMENTS_PENDING_RECEPTION",
      severity: "BLOCKING",
      title: "Liquidaciones sin recepción física confirmada",
      detail: `Confirma o cancela: ${settlementsInProgress.map((s) => s.folio).join(", ")}.`,
      count: settlementsInProgress.length,
    })
  }
  if (activeReservations > 0) {
    add({
      code: "ACTIVE_CHIP_RESERVATIONS",
      severity: "BLOCKING",
      title: "Reservas de fichas activas",
      detail: `${activeReservations} reserva(s) nominal(es) activas: se liberan al entregar o cancelar la compra.`,
      count: activeReservations,
    })
  }
  if (otherChipDrafts > 0) {
    add({
      code: "CHIP_COUNT_DRAFT_ELSEWHERE",
      severity: "BLOCKING",
      title: "Arqueo de fichas en borrador",
      detail:
        "Hay un arqueo de fichas en borrador ajeno al cierre: termínalo o cancélalo (solo existe un arqueo global a la vez).",
      count: otherChipDrafts,
    })
  }
  if (pendingChipCounts > 0) {
    add({
      code: "CHIP_DIFFERENCES_UNRECONCILED",
      severity: "BLOCKING",
      title: "Diferencias de fichas sin conciliar",
      detail:
        "Un arqueo de control tiene diferencias pendientes: concílialo antes del cierre.",
      count: pendingChipCounts,
    })
  }
  if (cashDrafts > 0) {
    add({
      code: "CASH_COUNT_DRAFT",
      severity: "BLOCKING",
      title: "Arqueo de efectivo en borrador",
      detail:
        "Confirma o cancela el arqueo de efectivo en borrador de la sesión.",
      count: cashDrafts,
    })
  }
  if (pendingCashControls > 0) {
    add({
      code: "CASH_DIFFERENCES_UNRECONCILED",
      severity: "BLOCKING",
      title: "Diferencias de efectivo sin resolver",
      detail:
        "Un arqueo de control de efectivo tiene diferencia pendiente: resuélvela antes del cierre.",
      count: pendingCashControls,
    })
  }
  if (!global.ledgerConsistent) {
    add({
      code: "INVENTORY_LEDGER_MISMATCH",
      severity: "BLOCKING",
      title: "Inventario inconsistente con su libro",
      detail:
        "La proyección nominal del inventario no coincide con el libro de movimientos: revisa el inventario antes de cerrar.",
    })
  }

  if (debts.outstanding.greaterThan(0)) {
    add({
      code: "PLAYER_DEBTS_OUTSTANDING",
      severity: "WARNING",
      title: "Deudas de jugadores pendientes",
      detail: `${debts.playersWithBalance} jugador(es) deben $${fmt(debts.outstanding)} de esta sesión. Sobreviven al cierre (no se cobran ni se borran).`,
      count: debts.playersWithBalance,
      amount: fmt(debts.outstanding),
    })
  }
  if (payables.pending.greaterThan(0)) {
    add({
      code: "PAYABLES_PENDING",
      severity: "WARNING",
      title: "Pagos pendientes a jugadores",
      detail: `$${fmt(payables.pending)} por pagar a ${payables.players} jugador(es). Sobreviven al cierre; se pagan después desde custodia o banco.`,
      count: payables.count,
      amount: fmt(payables.pending),
    })
  }
  if (settlingParticipants > 0) {
    add({
      code: "SETTLING_PARTICIPANTS",
      severity: "INFO",
      title: "Jugadores con liquidación por pagar",
      detail: `${settlingParticipants} jugador(es) ya entregaron sus fichas y esperan su pago (no ocupan silla).`,
      count: settlingParticipants,
    })
  }
  if (incomingTransfers._count._all > 0) {
    add({
      code: "INCOMING_TRANSFERS_PENDING",
      severity: "WARNING",
      title: "Transferencias entrantes por verificar",
      detail: `$${fmt(dec(incomingTransfers._sum.declaredAmount))} pendientes de verificación manual: no son cobro ni efectivo; conservan su estado.`,
      count: incomingTransfers._count._all,
      amount: fmt(dec(incomingTransfers._sum.declaredAmount)),
    })
  }
  if (outgoingPayouts._count._all > 0) {
    add({
      code: "OUTGOING_TRANSFERS_PENDING",
      severity: "WARNING",
      title: "Transferencias salientes en trámite",
      detail: `$${fmt(dec(outgoingPayouts._sum.amount))} a jugadores sin verificar: no cuentan como pagadas.`,
      count: outgoingPayouts._count._all,
      amount: fmt(dec(outgoingPayouts._sum.amount)),
    })
  }
  if (cashDeposits._count._all > 0) {
    add({
      code: "CASH_DEPOSITS_IN_TRANSIT",
      severity: "WARNING",
      title: "Depósitos de efectivo en tránsito",
      detail: `$${fmt(dec(cashDeposits._sum.declaredAmount))} depositados al banco sin verificar (ya salieron de la caja).`,
      count: cashDeposits._count._all,
      amount: fmt(dec(cashDeposits._sum.declaredAmount)),
    })
  }
  const cardPending = dec(cardPurchasesPending._sum.amount).add(
    dec(cardAbonosPending._sum.amount)
  )
  if (cardPending.greaterThan(0)) {
    add({
      code: "CARD_CLEARING_PENDING",
      severity: "WARNING",
      title: "Cobros con terminal por liquidar",
      detail: `$${fmt(cardPending)} aprobados en terminal esperan el depósito del adquirente (no son efectivo; no se cuentan dos veces).`,
      count: cardPurchasesPending._count._all + cardAbonosPending._count._all,
      amount: fmt(cardPending),
    })
  }
  if (unapplied._count._all > 0) {
    add({
      code: "UNAPPLIED_FUNDS_PENDING",
      severity: "WARNING",
      title: "Fondos recibidos sin aplicar",
      detail: `$${fmt(dec(unapplied._sum.amount))} por devolver o conciliar (no es saldo a favor).`,
      count: unapplied._count._all,
      amount: fmt(dec(unapplied._sum.amount)),
    })
  }
  // Conciliación GLOBAL de fichas (Módulo 18): entregado = devuelto por
  // jugadores + rake + propinas + otros + diferencia. Una diferencia (falten
  // o sobren) NO bloquea: se advierte y el cierre exige motivo del cajero.
  const b = flows.breakdown
  const chipBase = `Entregado $${fmt(flows.delivered)} · jugadores $${fmt(b.players)} · rake $${fmt(b.rake)} · propinas $${fmt(b.tips)}${b.other.isZero() ? "" : ` · otros $${fmt(b.other)}`}`
  if (flows.status === "IN_PLAY") {
    add({
      code: "CHIPS_IN_PLAY",
      severity: "INFO",
      title: "Fichas en juego",
      detail: `${chipBase}: $${fmt(flows.grossDifference)} siguen en la mesa con ${flows.activeParticipants} jugador(es) activo(s); regresan en sus liquidaciones.`,
      amount: fmt(flows.grossDifference),
    })
  } else if (flows.status === "RECONCILED") {
    add({
      code: "CHIPS_RECONCILED",
      severity: "INFO",
      title: "Fichas de la sesión conciliadas",
      detail: `${chipBase}${flows.authorizedUnrecovered.greaterThan(0) ? ` · diferencia autorizada $${fmt(flows.authorizedUnrecovered)}` : ""}: diferencia nominal $0.`,
    })
  } else {
    const missing = flows.difference.greaterThan(0)
    add({
      code: "SESSION_NOMINAL_DIFFERENCE",
      severity: "WARNING",
      title: missing
        ? `Diferencia nominal: faltan $${fmt(flows.difference)} por justificar`
        : `Diferencia nominal: sobran $${fmt(flows.difference.abs())} respecto al valor nominal entregado`,
      detail: `${chipBase}. Revisa las devoluciones, el rake de cada mesa y las propinas de cada empleado. Puedes cerrar la sesión registrando el motivo: la diferencia real se conserva (no se crea ningún ajuste).`,
      amount: fmt(flows.difference),
    })
  }
  if (flows.rake.cyclesPendingCount > 0)
    add({
      code: "RAKE_COUNT_PENDING",
      severity: "WARNING",
      title: "Rake sin conteo final",
      detail: `${flows.rake.cyclesPendingCount} ciclo(s) de mesa en conteo final sin contar el recipiente: su rake cuenta como $0 hasta registrarlo.`,
      count: flows.rake.cyclesPendingCount,
    })
  if (flows.rake.cyclesWithDifference > 0)
    add({
      code: "RAKE_DIFFERENCE",
      severity: "WARNING",
      title: "Diferencias de rake",
      detail: `${flows.rake.cyclesWithDifference} ciclo(s) con diferencia entre el rake registrado y el conteo de comprobación. Corrige un error de captura con un movimiento auditable; si no, la diferencia se conserva.`,
      count: flows.rake.cyclesWithDifference,
    })
  if (flows.tips.unconfirmed > 0)
    add({
      code: "STAFF_TIPS_UNCONFIRMED",
      severity: "WARNING",
      title: "Propinas sin confirmar",
      detail: `${flows.tips.unconfirmed} empleado(s) sin conteo de propinas confirmado: no cuentan en la conciliación hasta confirmarlo.`,
      count: flows.tips.unconfirmed,
    })
  add({
    code: "GLOBAL_CIRCULATION",
    severity: "INFO",
    title: "Circulación global de fichas",
    detail: `$${fmt(global.circulation)} en circulación (todas las sesiones, continuo). Bajo custodia: $${fmt(global.custody)}.`,
    amount: fmt(global.circulation),
  })
  add({
    code: "CASH_BALANCE",
    severity: "INFO",
    title: "Efectivo esperado en caja",
    detail: `$${fmt(cash.balance)} según el libro (la caja abrió en $0 y debe terminar en $0).`,
    amount: fmt(cash.balance),
  })
  if (lastCount) {
    add({
      code: "LAST_PHYSICAL_COUNT",
      severity: "INFO",
      title: "Último arqueo físico válido",
      detail: `Arqueo ${lastCount.countType.toLowerCase()} confirmado ${lastCount.confirmedAt?.toISOString() ?? ""}.`,
    })
  }
  if (tableCycles === 0) {
    add({
      code: "NO_ACTIVITY",
      severity: "INFO",
      title: "Sesión sin actividad de mesas",
      detail:
        "Nunca se abrió una mesa: se cerrará como cierre SIN ACTIVIDAD (motivo obligatorio).",
    })
  }

  const findings = sortFindings(f)
  return {
    sessionId,
    folio: session.folio,
    status: session.status,
    kind: closureKindFor(tableCycles),
    since: since.toISOString(),
    findings,
    summary: summarizeFindings(findings),
  }
}
export type ClosurePrecheck = Awaited<ReturnType<typeof computePrecheck>>

// ── Inventario y arqueo final ─────────────────────────────────────────

/** Arqueo de fichas del intento vigente (el más reciente, no cancelado). */
export async function closureChipCount(
  db: Db,
  sessionId: string,
  closure: { startedAt: Date } | null
) {
  if (!closure) return null
  return db.chipStockCount.findFirst({
    where: {
      sessionId,
      countType: "CLOSING",
      status: { not: "CANCELLED" },
      createdAt: { gte: closure.startedAt },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      reconciliationStatus: true,
      expectedTotal: true,
      countedTotal: true,
      differenceTotal: true,
      resultingInventoryVersion: true,
      confirmedAt: true,
      confirmedBy: user,
      reconciliationOperationId: true,
      details: {
        orderBy: { unitValue: "asc" },
        select: {
          denominationId: true,
          unitValue: true,
          expectedQuantity: true,
          countedQuantity: true,
          denomination: { select: { name: true, color: true } },
        },
      },
    },
  })
}

/** Inventario: esperado nominal (con su cálculo), contado, diferencia y circulación. */
export async function getInventoryStatus(db: Db, sessionId: string) {
  const session = await loadSessionHead(db, sessionId)
  const closure = await currentClosure(db, sessionId)
  const active = closure?.status === "IN_PROGRESS" ? closure : null
  const [global, flows, count, chipRec] = await Promise.all([
    getGlobalChipPosition(db),
    getSessionChipFlows(db, sessionId),
    closureChipCount(db, sessionId, active),
    getSessionChipReconciliation(db, sessionId),
  ])
  const openingCount = session.opening
    ? await db.chipStockCount.findUnique({
        where: { id: session.opening.chipStockCountId },
        select: {
          id: true,
          countedTotal: true,
          resultingInventoryVersion: true,
        },
      })
    : null
  // Cálculo nominal: custodia conciliada al abrir + movimientos reales del
  // libro posteriores a la apertura (de cualquier origen: el inventario es
  // compartido) = esperado. Se verifica contra la proyección.
  const after = session.openedAt
    ? await db.chipNominalMovement.findMany({
        where: {
          chipSetId: global.chipSetId,
          createdAt: { gt: session.openedAt },
        },
        select: {
          movementType: true,
          custodyBefore: true,
          custodyAfter: true,
          circulationBefore: true,
          circulationAfter: true,
        },
      })
    : []
  const custody = custodyFlows(after)
  const openingCustody = dec(openingCount?.countedTotal)
  const computedExpected = openingCustody.add(custody.total)
  const counted = count?.status === "CONFIRMED" ? dec(count.countedTotal) : null
  const expected =
    count?.status === "CONFIRMED" ? dec(count.expectedTotal) : global.custody
  const position = chipPosition({
    expectedCustody: expected,
    countedCustody: counted,
    sessionNetNotReturned: flows.netNotReturned,
    globalCirculation: global.circulation,
  })
  return {
    closureId: active?.id ?? null,
    inventoryVersion: global.inventoryVersion,
    nominal: {
      openingCustody: fmt(openingCustody),
      deliveries: fmt(custody.byType.deliveries),
      returns: fmt(custody.byType.returns),
      adjustments: fmt(custody.byType.adjustments),
      entries: fmt(custody.byType.entries),
      withdrawals: fmt(custody.byType.withdrawals),
      other: fmt(custody.byType.other),
      computedExpected: fmt(computedExpected),
      projectedCustody: fmt(global.custody),
      /** El cálculo desde la apertura coincide con la proyección del libro. */
      consistent:
        global.ledgerConsistent &&
        (!openingCount || computedExpected.equals(global.custody)),
    },
    count: count
      ? {
          id: count.id,
          status: count.status,
          reconciliationStatus: count.reconciliationStatus,
          // Módulo 18: un arqueo con diferencia (PENDING) también es vigente;
          // la diferencia física se registra al cerrar con motivo.
          current:
            count.status === "CONFIRMED" &&
            count.reconciliationStatus !== "SUPERSEDED" &&
            count.resultingInventoryVersion === global.inventoryVersion,
          confirmedAt: count.confirmedAt?.toISOString() ?? null,
          confirmedBy: count.confirmedBy,
          details: count.details.map((d) => ({
            denominationId: d.denominationId,
            name: d.denomination.name,
            color: d.denomination.color,
            unitValue: fmt(dec(d.unitValue)),
            countedQuantity: d.countedQuantity,
            subtotal:
              d.countedQuantity === null
                ? null
                : fmt(dec(d.unitValue).mul(d.countedQuantity)),
          })),
        }
      : null,
    openingCountCurrent:
      !!openingCount &&
      openingCount.resultingInventoryVersion === global.inventoryVersion,
    position: {
      expectedCustody: fmt(position.expectedCustody),
      countedCustody: position.countedCustody
        ? fmt(position.countedCustody)
        : null,
      physicalDifference: position.physicalDifference
        ? fmt(position.physicalDifference)
        : null,
      physicalStatus: position.physicalStatus,
      sessionDelivered: fmt(chipRec.delivered),
      sessionReturned: fmt(chipRec.returned),
      sessionNetNotReturned: fmt(position.sessionNetNotReturned),
      globalCirculation: fmt(position.globalCirculation),
      globalCustody: fmt(global.custody),
      recognizedAsIncome: fmt(position.recognizedAsIncome),
    },
    /** Conciliación GLOBAL de la sesión (ambas mesas). */
    reconciliation: {
      status: chipRec.status,
      delivered: fmt(chipRec.delivered),
      returned: fmt(chipRec.returned),
      grossDifference: fmt(chipRec.grossDifference),
      authorizedUnrecovered: fmt(chipRec.authorizedUnrecovered),
      identifiedInCount: fmt(chipRec.identifiedInCount),
      difference: fmt(chipRec.difference),
      activeParticipants: chipRec.activeParticipants,
      /** Módulo 18: destinos de las fichas (cada una contada una vez). */
      returnedByPlayers: fmt(chipRec.breakdown.players),
      rake: fmt(chipRec.breakdown.rake),
      tips: fmt(chipRec.breakdown.tips),
      otherReturns: fmt(chipRec.breakdown.other),
    },
    /** Resultado individual por jugador (INFORMATIVO, no es faltante). */
    attribution: { byPlayer: flows.byPlayer, byTable: flows.byTable },
  }
}

// ── Efectivo ──────────────────────────────────────────────────────────

const CASH_TYPE_LABEL: Record<string, string> = {
  CASH_CONTRIBUTION: "Aportaciones",
  CASH_WITHDRAWAL: "Retiros",
  CASH_TRANSFER: "Traslados (depósitos al banco)",
  PURCHASE_PAYMENT: "Compras pagadas en efectivo",
  DEBT_PAYMENT: "Abonos de deuda en efectivo",
  PLAYER_SETTLEMENT: "Liquidaciones pagadas en efectivo",
  REVERSAL: "Reversos",
  CASH_RECONCILIATION_ADJUSTMENT: "Ajustes de arqueo",
}

export async function closureCashCount(
  db: Db,
  sessionId: string,
  closure: { startedAt: Date } | null
) {
  if (!closure) return null
  return db.cashReconciliation.findFirst({
    where: {
      sessionId,
      reconciliationType: "CLOSING",
      status: "CONFIRMED",
      confirmedAt: { gte: closure.startedAt },
    },
    orderBy: { confirmedAt: "desc" },
    select: {
      id: true,
      expectedAmount: true,
      countedAmount: true,
      differenceAmount: true,
      differenceStatus: true,
      balanceVersion: true,
      adjustmentTransactionId: true,
      explanation: true,
      confirmedAt: true,
      confirmedBy: user,
      details: {
        orderBy: { unitValue: "desc" },
        select: { unitValue: true, quantity: true },
      },
    },
  })
}

/** Efectivo esperado (libro) con su desglose por tipo, arqueo y retiro. */
export async function getCashStatus(db: Db, sessionId: string) {
  const closure = await currentClosure(db, sessionId)
  const active = closure?.status === "IN_PROGRESS" ? closure : null
  const [entries, cash, count, withdrawal] = await Promise.all([
    db.cashTransactionEntry.findMany({
      where: { scopeKey: sessionId, account: { kind: "CASH_ON_HAND" } },
      select: {
        direction: true,
        amount: true,
        transaction: { select: { transactionType: true } },
      },
    }),
    cashBalanceRow(db, sessionId),
    closureCashCount(db, sessionId, active),
    active
      ? db.closureCashWithdrawal.findUnique({
          where: { closureId: active.id },
          select: {
            id: true,
            amount: true,
            recipientName: true,
            recipientUser: user,
            withdrawnBy: user,
            withdrawalAt: true,
            notes: true,
            cashTransaction: { select: { id: true, folio: true } },
          },
        })
      : null,
  ])
  const total = cashFromEntries(entries)
  const byType = new Map<string, { inflow: string; outflow: string }>()
  for (const type of new Set(
    entries.map((e) => e.transaction.transactionType)
  )) {
    const t = cashFromEntries(
      entries.filter((e) => e.transaction.transactionType === type)
    )
    byType.set(type, { inflow: fmt(t.inflow), outflow: fmt(t.outflow) })
  }
  return {
    closureId: active?.id ?? null,
    openingAmount: "0.00",
    inflow: fmt(total.inflow),
    outflow: fmt(total.outflow),
    expected: fmt(cash.balance),
    ledgerConsistent: total.balance.equals(cash.balance),
    balanceVersion: cash.version,
    byType: [...byType.entries()].map(([type, v]) => ({
      type,
      label: CASH_TYPE_LABEL[type] ?? type,
      ...v,
    })),
    count: count
      ? {
          id: count.id,
          expectedAmount: fmt(dec(count.expectedAmount)),
          countedAmount: fmt(dec(count.countedAmount)),
          differenceAmount: fmt(dec(count.differenceAmount)),
          differenceStatus: count.differenceStatus,
          balanceVersion: count.balanceVersion,
          adjusted: Boolean(count.adjustmentTransactionId),
          explanation: count.explanation,
          confirmedAt: count.confirmedAt?.toISOString() ?? null,
          confirmedBy: count.confirmedBy,
          details: count.details.map((d) => ({
            unitValue: fmt(dec(d.unitValue)),
            quantity: d.quantity,
          })),
        }
      : null,
    withdrawal: withdrawal
      ? {
          id: withdrawal.id,
          amount: fmt(dec(withdrawal.amount)),
          recipientName: withdrawal.recipientName,
          recipientUser: withdrawal.recipientUser,
          withdrawnBy: withdrawal.withdrawnBy,
          withdrawalAt: withdrawal.withdrawalAt.toISOString(),
          notes: withdrawal.notes,
          transaction: withdrawal.cashTransaction,
        }
      : null,
    /** Lo que debe retirarse para dejar la caja en $0 (nunca negativo). */
    toWithdraw: fmt(cash.balance.isNegative() ? ZERO : cash.balance),
    hasCash: cash.balance.greaterThan(0),
  }
}

// ── Discrepancias ─────────────────────────────────────────────────────

export async function listDiscrepancies(db: Db, sessionId: string) {
  const rows = await db.closureDiscrepancy.findMany({
    where: { sessionId },
    orderBy: { detectedAt: "desc" },
    select: {
      id: true,
      closureId: true,
      kind: true,
      status: true,
      chipStockCountId: true,
      cashReconciliationId: true,
      expectedAmount: true,
      countedAmount: true,
      differenceAmount: true,
      detectedAt: true,
      investigationNotes: true,
      resolution: true,
      resolutionNotes: true,
      resolvedAt: true,
      resolvedBy: user,
      recountChipStockCountId: true,
      recountCashReconciliationId: true,
      adjustment: {
        select: {
          id: true,
          amount: true,
          reason: true,
          authorizedBy: user,
          chipOperationId: true,
          cashTransactionId: true,
          createdAt: true,
        },
      },
    },
  })
  return rows.map((r) => ({
    ...r,
    expectedAmount: fmt(dec(r.expectedAmount)),
    countedAmount: fmt(dec(r.countedAmount)),
    differenceAmount: fmt(dec(r.differenceAmount)),
    detectedAt: r.detectedAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    adjustment: r.adjustment
      ? {
          ...r.adjustment,
          amount: fmt(dec(r.adjustment.amount)),
          createdAt: r.adjustment.createdAt.toISOString(),
        }
      : null,
  }))
}

// ── Resumen financiero e indicadores ──────────────────────────────────

/**
 * Indicadores basados en operaciones REALES. Nunca llama utilidad a la
 * diferencia entre compras y fichas devueltas, ni suma el cobro aprobado
 * con terminal y su depósito como dos ingresos, ni trata transferencias
 * pendientes como efectivo.
 */
export async function getFinancialSummary(db: Db, sessionId: string) {
  const [
    tables,
    participants,
    purchases,
    payments,
    receivables,
    settlements,
    payouts,
    transfersIn,
  ] = await Promise.all([
    db.sessionTable.findMany({
      where: { sessionId },
      orderBy: { table: { name: "asc" } },
      select: {
        table: { select: { name: true } },
        cycles: {
          orderBy: { cycleNumber: "asc" },
          select: { id: true, status: true },
        },
      },
    }),
    db.tableParticipation.findMany({
      where: { sessionId },
      select: { playerId: true },
      distinct: ["playerId"],
    }),
    db.chipPurchase.groupBy({
      by: ["purchaseType"],
      where: { sessionId, status: { in: ["CONFIRMED", "REVERSED"] } },
      _count: { _all: true },
      _sum: { nominalAmount: true },
    }),
    db.purchasePayment.groupBy({
      by: ["method", "status"],
      where: {
        purchase: { sessionId, status: { in: ["CONFIRMED", "REVERSED"] } },
      },
      _sum: { amount: true },
    }),
    db.receivablePayment.groupBy({
      by: ["method", "status"],
      where: { sessionId },
      _sum: { amount: true },
    }),
    db.playerSettlement.groupBy({
      by: ["status"],
      where: { sessionId, status: { in: ["PENDING_PAYOUT", "COMPLETED"] } },
      _count: { _all: true },
      _sum: { returnedNominalAmount: true, offsetAmount: true },
    }),
    db.settlementPayout.groupBy({
      by: ["method", "status", "funding"],
      where: { payable: { sourceSessionId: sessionId } },
      _sum: { amount: true },
    }),
    db.bankTransferVerification.groupBy({
      by: ["kind", "status"],
      where: { sessionId },
      _count: { _all: true },
      _sum: { declaredAmount: true, confirmedAmount: true },
    }),
  ])
  const [debts, payables, flows, global, cash] = await Promise.all([
    sessionDebtsOf(db, sessionId),
    payablesPendingOf(db, sessionId),
    getSessionChipReconciliation(db, sessionId),
    getGlobalChipPosition(db),
    cashBalanceRow(db, sessionId),
  ])
  const cardClearing = await cardClearingGlobal(db)
  const sum = (
    rows: { _sum: { amount: Prisma.Decimal | null } }[],
    pred: (r: never) => boolean
  ) =>
    rows
      .filter((r) => pred(r as never))
      .reduce((acc, r) => acc.add(r._sum.amount ?? 0), ZERO)
  const pay = (method: string | string[], status: string) =>
    fmt(
      sum(
        payments,
        (r: { method: string; status: string }) =>
          (Array.isArray(method) ? method : [method]).includes(r.method) &&
          r.status === status
      )
    )
  const ab = (method: string | string[], status: string) =>
    fmt(
      sum(
        receivables,
        (r: { method: string; status: string }) =>
          (Array.isArray(method) ? method : [method]).includes(r.method) &&
          r.status === status
      )
    )
  const po = (method: string, status: string) =>
    fmt(
      sum(
        payouts,
        (r: { method: string; status: string }) =>
          r.method === method && r.status === status
      )
    )
  const ptype = (t: "INITIAL_PURCHASE" | "REBUY") =>
    purchases.find((p) => p.purchaseType === t)
  const st = (s: "PENDING_PAYOUT" | "COMPLETED") =>
    settlements.find((x) => x.status === s)
  const tin = (kind: string, status: string) => {
    const r = transfersIn.find((x) => x.kind === kind && x.status === status)
    return {
      count: r?._count._all ?? 0,
      amount: fmt(
        dec(
          status === "CONFIRMED"
            ? (r?._sum.confirmedAmount ?? r?._sum.declaredAmount)
            : r?._sum.declaredAmount
        )
      ),
    }
  }
  const cycles = tables.flatMap((t) => t.cycles)
  const withdrawals = await db.cashTransaction.aggregate({
    where: { sessionId, transactionType: "CASH_WITHDRAWAL" },
    _count: { _all: true },
  })
  const withdrawnEntries = await db.cashTransactionEntry.aggregate({
    where: {
      scopeKey: sessionId,
      direction: "CREDIT",
      account: { kind: "CASH_ON_HAND" },
      transaction: { transactionType: "CASH_WITHDRAWAL" },
    },
    _sum: { amount: true },
  })
  return {
    tables: {
      operated: tables.filter((t) => t.cycles.length > 0).length,
      names: tables.filter((t) => t.cycles.length > 0).map((t) => t.table.name),
      cyclesOpen: cycles.filter((c) => c.status === "OPEN").length,
      cyclesClosed: cycles.filter((c) => c.status === "CLOSED").length,
    },
    players: participants.length,
    purchases: {
      initialCount: ptype("INITIAL_PURCHASE")?._count._all ?? 0,
      initialNominal: fmt(dec(ptype("INITIAL_PURCHASE")?._sum.nominalAmount)),
      rebuyCount: ptype("REBUY")?._count._all ?? 0,
      rebuyNominal: fmt(dec(ptype("REBUY")?._sum.nominalAmount)),
      paidCash: pay("CASH", "CONFIRMED"),
      paidTransferConfirmed: pay("BANK_TRANSFER", "CONFIRMED"),
      paidTransferPending: pay("BANK_TRANSFER", "PENDING"),
      paidCardApproved: pay(["CARD_DEBIT", "CARD_CREDIT"], "APPROVED"),
    },
    chips: {
      delivered: fmt(flows.delivered),
      returned: fmt(flows.returned),
      netNotReturned: fmt(flows.grossDifference),
      /** Conciliación global: estado y diferencia por investigar/autorizada. */
      reconciliationStatus: flows.status,
      authorizedUnrecovered: fmt(flows.authorizedUnrecovered),
      unexplainedDifference: fmt(
        flows.difference.greaterThan(0) ? flows.difference : ZERO
      ),
      globalCirculation: fmt(global.circulation),
    },
    credits: {
      originated: fmt(debts.originated),
      outstanding: fmt(debts.outstanding),
      playersWithBalance: debts.playersWithBalance,
    },
    abonos: {
      cash: ab("CASH", "CONFIRMED"),
      transferConfirmed: ab("BANK_TRANSFER", "CONFIRMED"),
      transferPending: ab("BANK_TRANSFER", "PENDING"),
      card: ab(["CARD_DEBIT", "CARD_CREDIT"], "CONFIRMED"),
    },
    settlements: {
      completed: st("COMPLETED")?._count._all ?? 0,
      pendingPayout: st("PENDING_PAYOUT")?._count._all ?? 0,
      returnedNominal: fmt(
        dec(st("COMPLETED")?._sum.returnedNominalAmount).add(
          dec(st("PENDING_PAYOUT")?._sum.returnedNominalAmount)
        )
      ),
      offsets: fmt(
        dec(st("COMPLETED")?._sum.offsetAmount).add(
          dec(st("PENDING_PAYOUT")?._sum.offsetAmount)
        )
      ),
      paidCash: po("CASH", "EXECUTED"),
      paidTransfer: po("BANK_TRANSFER", "EXECUTED"),
      transferInTransit: po("BANK_TRANSFER", "PENDING"),
      pendingAmount: fmt(payables.pending),
      pendingPlayers: payables.players,
    },
    bank: {
      incomingConfirmed: tin("PLAYER_PAYMENT", "CONFIRMED"),
      incomingPending: tin("PLAYER_PAYMENT", "PENDING_VERIFICATION"),
      incomingRejected: tin("PLAYER_PAYMENT", "REJECTED"),
      depositsConfirmed: tin("CASH_DEPOSIT", "CONFIRMED"),
      depositsPending: tin("CASH_DEPOSIT", "PENDING_VERIFICATION"),
      outgoingExecuted: po("BANK_TRANSFER", "EXECUTED"),
      outgoingPending: po("BANK_TRANSFER", "PENDING"),
    },
    card: {
      approvedInSession: fmt(
        dec(pay(["CARD_DEBIT", "CARD_CREDIT"], "APPROVED")).add(
          dec(ab(["CARD_DEBIT", "CARD_CREDIT"], "CONFIRMED"))
        )
      ),
      /** Saldo GLOBAL por liquidar del adquirente (no es de esta sesión ni efectivo). */
      clearingGlobal: fmt(cardClearing),
    },
    cash: {
      withdrawals: withdrawals._count._all,
      withdrawn: fmt(dec(withdrawnEntries._sum.amount)),
      final: fmt(cash.balance),
    },
  }
}

// ── Requisitos y huella del resumen ───────────────────────────────────

/**
 * Hechos para el cierre definitivo, el resumen revisado y su HUELLA. La
 * huella cambia con cualquier movimiento relevante (inventario, efectivo,
 * arqueos, retiro, discrepancias, deudas, pagos o transferencias), lo que
 * invalida una aprobación preparada antes (DEC-16 / §16).
 */
export async function buildClosurePreview(db: Db, sessionId: string) {
  const session = await loadSessionHead(db, sessionId)
  const closure = await currentClosure(db, sessionId)
  const active = closure?.status === "IN_PROGRESS" ? closure : null
  const [precheck, inventory, cash, financial, discrepancies] =
    await Promise.all([
      computePrecheck(db, sessionId),
      getInventoryStatus(db, sessionId),
      getCashStatus(db, sessionId),
      getFinancialSummary(db, sessionId),
      listDiscrepancies(db, sessionId),
    ])
  const current = discrepancies.filter(
    (d) => active && d.closureId === active.id
  )
  const readiness = evaluateReadiness({
    sessionStatus: session.status,
    closureStatus: active?.status ?? null,
    kind: active?.kind ?? precheck.kind,
    noActivityReason: active?.noActivityReason ?? null,
    openCycles: financial.tables.cyclesOpen,
    blockingFindings: precheck.summary.blocking,
    chipCount: inventory.count
      ? {
          status: inventory.count.status,
          reconciliationStatus: inventory.count.reconciliationStatus,
          current: inventory.count.current,
        }
      : null,
    openingCountCurrent: inventory.openingCountCurrent,
    openChipDiscrepancies: current.filter(
      (d) => d.kind === "CHIP_INVENTORY" && d.status === "OPEN"
    ).length,
    cashCount: cash.count
      ? {
          differenceStatus: cash.count.differenceStatus,
          balanceVersion: cash.count.balanceVersion,
          adjusted: cash.count.adjusted,
          countedAmount: dec(cash.count.countedAmount),
        }
      : null,
    openCashDiscrepancies: current.filter(
      (d) => d.kind === "CASH" && d.status === "OPEN"
    ).length,
    cashVersion: cash.balanceVersion,
    cashBalance: dec(cash.expected),
    withdrawal: cash.withdrawal
      ? { amount: dec(cash.withdrawal.amount) }
      : null,
  })
  const material = {
    sessionId,
    sessionStatus: session.status,
    closureId: active?.id ?? null,
    attempt: active?.attemptNumber ?? null,
    kind: active?.kind ?? precheck.kind,
    inventoryVersion: inventory.inventoryVersion,
    chipCountId: inventory.count?.id ?? null,
    chipCountStatus: inventory.count
      ? `${inventory.count.status}/${inventory.count.reconciliationStatus}`
      : null,
    position: inventory.position,
    cashVersion: cash.balanceVersion,
    cashExpected: cash.expected,
    cashCountId: cash.count?.id ?? null,
    cashCountStatus: cash.count?.differenceStatus ?? null,
    withdrawalId: cash.withdrawal?.id ?? null,
    discrepancies: current.map((d) => `${d.id}:${d.status}`).sort(),
    findings: precheck.findings.map(
      (f) => `${f.code}:${f.severity}:${f.count ?? ""}:${f.amount ?? ""}`
    ),
    financial,
  }
  return {
    session,
    closure: active,
    precheck,
    inventory,
    cash,
    financial,
    discrepancies: current,
    readiness,
    previewHash: canonicalHash(material),
  }
}
export type ClosurePreview = Awaited<ReturnType<typeof buildClosurePreview>>
