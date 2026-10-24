import { Prisma } from "@/generated/prisma/client"

/**
 * Lógica PURA del cierre (Módulo 12): clasificación de hallazgos, flujos
 * nominales de fichas, distinción entre diferencia física y fichas en
 * circulación, efectivo esperado y requisitos del cierre definitivo.
 * Sin acceso a datos: los servicios le pasan hechos ya leídos bajo bloqueo.
 */

export type Dec = Prisma.Decimal
export const ZERO = new Prisma.Decimal(0)
export const dec = (v: Prisma.Decimal | string | number | null | undefined) =>
  new Prisma.Decimal(v ?? 0)
export const fmt = (v: Prisma.Decimal) => v.toFixed(2)

// ── Hallazgos de la prevalidación ─────────────────────────────────────

export type FindingSeverity = "BLOCKING" | "WARNING" | "INFO"

export type FindingCode =
  | "SESSION_NOT_OPERABLE"
  | "OPEN_TABLES"
  | "ACTIVE_PARTICIPANTS"
  | "PURCHASES_PENDING_DELIVERY"
  | "SETTLEMENTS_PENDING_RECEPTION"
  | "ACTIVE_CHIP_RESERVATIONS"
  | "CHIP_COUNT_DRAFT_ELSEWHERE"
  | "CHIP_DIFFERENCES_UNRECONCILED"
  | "CASH_COUNT_DRAFT"
  | "CASH_DIFFERENCES_UNRECONCILED"
  | "INVENTORY_LEDGER_MISMATCH"
  | "PLAYER_DEBTS_OUTSTANDING"
  | "PAYABLES_PENDING"
  | "INCOMING_TRANSFERS_PENDING"
  | "OUTGOING_TRANSFERS_PENDING"
  | "CASH_DEPOSITS_IN_TRANSIT"
  | "CARD_CLEARING_PENDING"
  | "UNAPPLIED_FUNDS_PENDING"
  | "CHIPS_IN_PLAY"
  | "CHIPS_RECONCILED"
  | "SESSION_NOMINAL_DIFFERENCE"
  | "SESSION_RETURNED_PRIOR_CIRCULATION"
  | "GLOBAL_CIRCULATION"
  | "NO_ACTIVITY"
  | "CASH_BALANCE"
  | "LAST_PHYSICAL_COUNT"
  | "SETTLING_PARTICIPANTS"
  // Módulo 18
  | "RAKE_COUNT_PENDING"
  | "RAKE_DIFFERENCE"
  | "STAFF_TIPS_UNCONFIRMED"

export type Finding = {
  code: FindingCode
  severity: FindingSeverity
  title: string
  detail: string
  count?: number
  amount?: string
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  BLOCKING: 0,
  WARNING: 1,
  INFO: 2,
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.code.localeCompare(b.code)
  )
}

/**
 * Resumen de la prevalidación. Solo los BLOCKING impiden iniciar o
 * confirmar el cierre: las advertencias (deudas, pagos pendientes, fichas
 * no retornadas…) se muestran pero NO bloquean.
 */
export function summarizeFindings(findings: Finding[]) {
  const blocking = findings.filter((f) => f.severity === "BLOCKING").length
  const warnings = findings.filter((f) => f.severity === "WARNING").length
  const info = findings.filter((f) => f.severity === "INFO").length
  return { blocking, warnings, info, clear: blocking === 0 }
}

// ── Clasificación del cierre ──────────────────────────────────────────

/** Sin ningún ciclo de mesa → cierre SIN ACTIVIDAD (exige motivo). */
export function closureKindFor(tableCycles: number): "NORMAL" | "NO_ACTIVITY" {
  return tableCycles === 0 ? "NO_ACTIVITY" : "NORMAL"
}

export function requiresNoActivityReason(
  kind: "NORMAL" | "NO_ACTIVITY",
  reason: string | null | undefined
): boolean {
  return kind === "NO_ACTIVITY" && !(reason ?? "").trim()
}

// ── Fichas: flujos nominales del libro (Módulo 04) ────────────────────

export type NominalRow = {
  movementType: string
  custodyBefore: Prisma.Decimal | string
  custodyAfter: Prisma.Decimal | string
  circulationBefore: Prisma.Decimal | string
  circulationAfter: Prisma.Decimal | string
  playerId?: string | null
}

/**
 * Entregado / devuelto / neto no retornado según el libro nominal: cada
 * movimiento aporta lo que cambió la circulación (entrega +, devolución −).
 * Ajustes de custodia no cambian la circulación y no cuentan aquí.
 */
export function circulationFlows(rows: NominalRow[]) {
  let delivered = ZERO
  let returned = ZERO
  for (const r of rows) {
    const delta = dec(r.circulationAfter).sub(dec(r.circulationBefore))
    if (delta.greaterThan(0)) delivered = delivered.add(delta)
    else if (delta.lessThan(0)) returned = returned.add(delta.abs())
  }
  return { delivered, returned, net: delivered.sub(returned) }
}

/**
 * Atribución INFORMATIVA por jugador (lo que el historial registró a su
 * nombre). No prueba quién tiene físicamente las fichas: con transferencias
 * o intercambio entre jugadores el poseedor real no se conoce.
 */
export function circulationByPlayer(rows: NominalRow[]) {
  const map = new Map<string, { delivered: Dec; returned: Dec }>()
  for (const r of rows) {
    if (!r.playerId) continue
    const delta = dec(r.circulationAfter).sub(dec(r.circulationBefore))
    if (delta.isZero()) continue
    const acc = map.get(r.playerId) ?? { delivered: ZERO, returned: ZERO }
    if (delta.greaterThan(0)) acc.delivered = acc.delivered.add(delta)
    else acc.returned = acc.returned.add(delta.abs())
    map.set(r.playerId, acc)
  }
  return [...map.entries()].map(([playerId, v]) => ({
    playerId,
    delivered: v.delivered,
    returned: v.returned,
    net: v.delivered.sub(v.returned),
  }))
}

export type CustodyFlowKey =
  "deliveries" | "returns" | "adjustments" | "entries" | "withdrawals" | "other"

const CUSTODY_KEY: Record<string, CustodyFlowKey> = {
  CHIP_DELIVERY: "deliveries",
  CHIP_RETURN: "returns",
  INVENTORY_ADJUSTMENT: "adjustments",
  STOCK_ENTRY: "entries",
  INITIAL_STOCK: "entries",
  STOCK_WITHDRAWAL: "withdrawals",
}

/** Cambios de la custodia por tipo de movimiento (con signo). */
export function custodyFlows(rows: NominalRow[]) {
  const byType: Record<CustodyFlowKey, Dec> = {
    deliveries: ZERO,
    returns: ZERO,
    adjustments: ZERO,
    entries: ZERO,
    withdrawals: ZERO,
    other: ZERO,
  }
  let total = ZERO
  for (const r of rows) {
    const delta = dec(r.custodyAfter).sub(dec(r.custodyBefore))
    const key = CUSTODY_KEY[r.movementType] ?? "other"
    byType[key] = byType[key].add(delta)
    total = total.add(delta)
  }
  return { byType, total }
}

/**
 * Las TRES cifras que el cierre nunca confunde (regla crítica, §11):
 *  A. Diferencia FÍSICA de arqueo = contado − esperado bajo custodia.
 *  B. Neto no retornado de la sesión = entregado − devuelto (circulación).
 *  C. Circulación GLOBAL = valor nominal fuera de custodia (todas las
 *     sesiones; continua, nunca se reinicia).
 * Solo A bloquea el cierre. B y C no son faltante, ingreso, utilidad,
 * deuda ni pago: son valor pendiente de retorno (canjeable después).
 */
export function chipPosition(input: {
  expectedCustody: Dec
  countedCustody: Dec | null
  sessionNetNotReturned: Dec
  globalCirculation: Dec
}) {
  const physicalDifference =
    input.countedCustody === null
      ? null
      : input.countedCustody.sub(input.expectedCustody)
  return {
    expectedCustody: input.expectedCustody,
    countedCustody: input.countedCustody,
    physicalDifference,
    physicalStatus:
      physicalDifference === null
        ? ("NOT_COUNTED" as const)
        : physicalDifference.isZero()
          ? ("MATCH" as const)
          : physicalDifference.isNegative()
            ? ("SHORTAGE" as const)
            : ("SURPLUS" as const),
    sessionNetNotReturned: input.sessionNetNotReturned,
    globalCirculation: input.globalCirculation,
    /** Nunca se reconoce como ingreso ni utilidad (DEC-21). */
    recognizedAsIncome: ZERO,
  }
}

// ── Efectivo ──────────────────────────────────────────────────────────

/** Saldo del libro a partir de partidas de CASH_ON_HAND (DEBIT − CREDIT). */
export function cashFromEntries(
  entries: { direction: "DEBIT" | "CREDIT"; amount: Dec | string }[]
) {
  let inflow = ZERO
  let outflow = ZERO
  for (const e of entries) {
    if (e.direction === "DEBIT") inflow = inflow.add(dec(e.amount))
    else outflow = outflow.add(dec(e.amount))
  }
  return { inflow, outflow, balance: inflow.sub(outflow) }
}

/** El retiro final debe ser EXACTAMENTE lo disponible (deja la caja en $0). */
export function assertExactWithdrawal(requested: Dec, available: Dec) {
  if (available.isNegative()) {
    return "La caja no puede tener saldo negativo."
  }
  if (requested.lessThanOrEqualTo(0)) {
    return "El importe del retiro debe ser mayor que cero."
  }
  if (requested.greaterThan(available)) {
    return `No se puede retirar más efectivo del disponible ($${fmt(available)}).`
  }
  if (!requested.equals(available)) {
    return `El retiro final debe dejar la caja en $0.00: el disponible es $${fmt(available)}.`
  }
  return null
}

// ── Requisitos del cierre definitivo ──────────────────────────────────

export type ReadinessFacts = {
  sessionStatus: string
  closureStatus: string | null
  kind: "NORMAL" | "NO_ACTIVITY"
  noActivityReason: string | null
  openCycles: number
  blockingFindings: number
  chipCount: {
    status: string
    reconciliationStatus: string
    current: boolean
  } | null
  /** Cierre sin actividad: el arqueo de apertura sigue vigente. */
  openingCountCurrent: boolean
  openChipDiscrepancies: number
  cashCount: {
    differenceStatus: string
    balanceVersion: number
    adjusted: boolean
    countedAmount: Dec
  } | null
  openCashDiscrepancies: number
  cashVersion: number
  cashBalance: Dec
  withdrawal: { amount: Dec } | null
}

export type ReadinessCheckId =
  | "SESSION_CLOSING"
  | "TABLES_CLOSED"
  | "NO_BLOCKING"
  | "CHIP_COUNT"
  | "CHIP_DIFFERENCES"
  | "CASH_COUNT"
  | "CASH_DIFFERENCES"
  | "CASH_UNCHANGED"
  | "CASH_WITHDRAWN"
  | "CASH_ZERO"
  | "NO_ACTIVITY_REASON"

export type ReadinessCheck = {
  id: ReadinessCheckId
  label: string
  ok: boolean
  message: string | null
}

export function evaluateReadiness(f: ReadinessFacts) {
  const checks: ReadinessCheck[] = []
  const add = (
    id: ReadinessCheckId,
    label: string,
    ok: boolean,
    message: string | null
  ) => checks.push({ id, label, ok, message: ok ? null : message })

  add(
    "SESSION_CLOSING",
    "Sesión en cierre",
    f.sessionStatus === "CLOSING" && f.closureStatus === "IN_PROGRESS",
    "La sesión debe estar en cierre (CLOSING) con un proceso de cierre en curso."
  )
  add(
    "TABLES_CLOSED",
    "Todas las mesas cerradas",
    f.openCycles === 0,
    `Hay ${f.openCycles} ciclo(s) de mesa abiertos.`
  )
  add(
    "NO_BLOCKING",
    "Sin operaciones bloqueantes",
    f.blockingFindings === 0,
    `La prevalidación tiene ${f.blockingFindings} bloqueo(s).`
  )

  const chipOk =
    f.chipCount !== null
      ? f.chipCount.status === "CONFIRMED" && f.chipCount.current
      : f.kind === "NO_ACTIVITY" && f.openingCountCurrent
  add(
    "CHIP_COUNT",
    "Arqueo global de fichas vigente",
    chipOk,
    f.chipCount === null
      ? "Falta el arqueo físico global de fichas del cierre."
      : f.chipCount.status !== "CONFIRMED"
        ? "El arqueo de fichas aún no está confirmado."
        : "Hubo movimientos de fichas después del arqueo: vuelve a contar."
  )
  // Módulo 18 (decisión del propietario): una diferencia física de fichas
  // NO bloquea; se registra al confirmar con el motivo del cajero (sin
  // ajustes). Las diferencias de EFECTIVO siguen bloqueando.
  add(
    "CHIP_DIFFERENCES",
    "Diferencias de fichas (se registran con motivo)",
    true,
    null
  )

  add(
    "CASH_COUNT",
    "Arqueo de efectivo de cierre",
    f.cashCount !== null,
    "Falta contar físicamente el efectivo de la caja."
  )
  const cashDiffOk =
    f.openCashDiscrepancies === 0 &&
    (f.cashCount === null ||
      f.cashCount.differenceStatus === "NOT_REQUIRED" ||
      f.cashCount.differenceStatus === "ADJUSTED")
  add(
    "CASH_DIFFERENCES",
    "Diferencias de efectivo resueltas",
    cashDiffOk,
    "Hay una diferencia de efectivo sin resolver."
  )
  const expectedVersion =
    f.cashCount === null
      ? null
      : f.cashCount.balanceVersion +
        (f.cashCount.adjusted ? 1 : 0) +
        (f.withdrawal ? 1 : 0)
  add(
    "CASH_UNCHANGED",
    "Sin movimientos de efectivo posteriores al arqueo",
    expectedVersion !== null && f.cashVersion === expectedVersion,
    "El efectivo cambió después del arqueo de cierre: vuelve a contar."
  )
  const mustWithdraw =
    f.cashCount !== null && f.cashCount.countedAmount.greaterThan(0)
  add(
    "CASH_WITHDRAWN",
    "Retiro final registrado",
    !mustWithdraw || f.withdrawal !== null,
    "Registra el retiro físico final del efectivo y quién lo recibe."
  )
  add(
    "CASH_ZERO",
    "Caja final en $0.00",
    f.cashBalance.isZero(),
    `La caja aún tiene $${fmt(f.cashBalance)}: debe terminar exactamente en $0.00.`
  )
  if (f.kind === "NO_ACTIVITY") {
    add(
      "NO_ACTIVITY_REASON",
      "Motivo del cierre sin actividad",
      !requiresNoActivityReason(f.kind, f.noActivityReason),
      "El cierre sin actividad exige un motivo."
    )
  }
  return { ready: checks.every((c) => c.ok), checks }
}

// ── Conciliación GLOBAL de fichas de la sesión (corrección transversal) ─

/**
 * Estado nominal de la sesión (docs/CHIP_GLOBAL_RECONCILIATION.md).
 *
 * REGLA: ningún jugador se lleva fichas. El resultado individual de cada
 * jugador (devuelto − comprado) NO es un faltante: lo que uno pierde lo
 * gana otro y regresa en SU liquidación. Lo que se concilia es el balance
 * GLOBAL de la sesión (ambas mesas; las transferencias no generan
 * movimientos):
 *
 *   diferencia = Σ entregado − Σ devuelto − Σ diferencias autorizadas
 *
 * - Con jugadores ACTIVOS: las fichas están legítimamente EN JUEGO.
 * - Todos terminaron y diferencia = 0: CONCILIADA.
 * - Todos terminaron y diferencia > 0: entregas sin retorno registrado →
 *   POR INVESTIGAR (bloquea el cierre; nunca es «circulación» legítima).
 * - Diferencia < 0: se devolvieron fichas de circulación ANTERIOR (sesiones
 *   previas al cambio de regla); se informa.
 */
export type SessionChipStatus =
  | "IN_PLAY"
  | "RECONCILED"
  | "UNEXPLAINED_DIFFERENCE"
  | "PRIOR_CIRCULATION_RETURNED"

export function sessionChipReconciliation(input: {
  delivered: Dec
  returned: Dec
  /** Diferencias documentadas y autorizadas (UNRECOVERED_AUTHORIZED). */
  authorizedUnrecovered: Dec
  activeParticipants: number
}) {
  const grossDifference = input.delivered.sub(input.returned)
  const difference = grossDifference.sub(input.authorizedUnrecovered)
  const status: SessionChipStatus =
    input.activeParticipants > 0
      ? "IN_PLAY"
      : difference.isZero()
        ? "RECONCILED"
        : difference.greaterThan(0)
          ? "UNEXPLAINED_DIFFERENCE"
          : "PRIOR_CIRCULATION_RETURNED"
  return {
    delivered: input.delivered,
    returned: input.returned,
    grossDifference,
    authorizedUnrecovered: input.authorizedUnrecovered,
    difference,
    status,
  }
}

/** Destino de cada movimiento nominal de la sesión (Módulo 18). */
export type ChipDestination = "PLAYERS" | "RAKE" | "TIPS" | "OTHER"

const DESTINATION_BY_REFERENCE: Record<string, ChipDestination> = {
  RakeMovement: "RAKE",
  RakeCount: "RAKE",
  StaffTipCount: "TIPS",
  StaffTipEntry: "TIPS",
  SessionChipReconciliation: "OTHER",
}

/**
 * Destinos de las fichas de la sesión (Módulo 18), del libro nominal:
 * entregado a jugadores = Σ salidas de compras (incluye financiadas);
 * jugadores = Σ devoluciones de liquidaciones/jugadas; rake y propinas =
 * NETO de sus registros (una corrección negativa devuelve fichas a
 * circulación y no es una entrega a jugadores); otros = retornos
 * identificados en el arqueo. Cada ficha se cuenta UNA vez.
 */
export function chipDestinations(
  rows: {
    referenceType: string | null
    circulationBefore: Dec | string
    circulationAfter: Dec | string
  }[]
) {
  const out = {
    deliveredToPlayers: ZERO,
    returnedByPlayers: ZERO,
    rake: ZERO,
    tips: ZERO,
    other: ZERO,
  }
  for (const r of rows) {
    const delta = dec(r.circulationAfter).sub(dec(r.circulationBefore))
    if (delta.isZero()) continue
    const d = DESTINATION_BY_REFERENCE[r.referenceType ?? ""] ?? "PLAYERS"
    if (d === "PLAYERS") {
      if (delta.greaterThan(0))
        out.deliveredToPlayers = out.deliveredToPlayers.add(delta)
      else out.returnedByPlayers = out.returnedByPlayers.add(delta.abs())
    } else if (d === "RAKE") out.rake = out.rake.sub(delta)
    else if (d === "TIPS") out.tips = out.tips.sub(delta)
    else out.other = out.other.sub(delta)
  }
  return {
    ...out,
    /** Total explicado (jugadores + rake + propinas + otros). */
    explained: out.returnedByPlayers.add(out.rake).add(out.tips).add(out.other),
  }
}

/** Resultado nominal INDIVIDUAL: devuelto − comprado (no es faltante). */
export function individualResult(returned: Dec, purchased: Dec): Dec {
  return returned.sub(purchased)
}

/**
 * Cuánto puede registrarse como «retorno identificado en el arqueo»: solo
 * hasta lo que el arqueo de cierre encontró DE MÁS en la caja y hasta la
 * diferencia pendiente (nunca una entrada sin fichas contadas).
 */
export function identifiableReturn(input: {
  physicalSurplus: Dec | null
  pendingDifference: Dec
}): Dec {
  if (!input.physicalSurplus || !input.physicalSurplus.greaterThan(0))
    return ZERO
  if (!input.pendingDifference.greaterThan(0)) return ZERO
  return input.physicalSurplus.lessThan(input.pendingDifference)
    ? input.physicalSurplus
    : input.pendingDifference
}
