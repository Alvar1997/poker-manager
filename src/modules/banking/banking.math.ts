import { Prisma } from "@/generated/prisma/client"

/**
 * Núcleo PURO del Módulo 17 (jugadores bancados por la casa). Sin base de
 * datos: los servicios cargan los HECHOS (jugadas conciliadas, tramos de
 * porcentaje, reserva, anticipos pagados, pérdidas arrastradas) y estas
 * funciones calculan. Todo con Decimal (nunca number) y redondeo explícito.
 *
 * Orden CONFIRMADO de compensación en un corte de cuatro jugadas:
 *   1. Las pérdidas del ciclo (+ la pérdida arrastrada anterior) se
 *      compensan con las ganancias del ciclo todavía no repartidas.
 *   2. Si queda déficit, se usa la reserva positiva anterior.
 *   3. Solo lo que no pudo cubrirse se arrastra al ciclo siguiente.
 *   4. Únicamente la ganancia NETA elegible se reparte por porcentaje.
 * Una pérdida cubierta (por ganancias o reserva) nunca se vuelve a aplicar.
 *
 * Redondeo: la parte del jugador de cada tramo se redondea a centavos
 * (ROUND_HALF_UP) y la casa recibe el resto exacto, así la suma del reparto
 * coincide SIEMPRE con lo repartible. El límite conservador de anticipos
 * redondea hacia abajo y descuenta un centavo por tramo adicional.
 */

export type Dec = Prisma.Decimal
export const ZERO = new Prisma.Decimal(0)
export const HUNDRED = new Prisma.Decimal(100)
export const CENT = new Prisma.Decimal("0.01")
export const dec = (v: Prisma.Decimal | string | number | null | undefined) =>
  new Prisma.Decimal(v ?? 0)
export const fmt = (v: Prisma.Decimal) => v.toFixed(2)
const min = (a: Dec, b: Dec) => (a.lessThan(b) ? a : b)
const max = (a: Dec, b: Dec) => (a.greaterThan(b) ? a : b)

/** Cada ciclo comprende EXACTAMENTE cuatro jugadas (no días ni compras). */
export const GAMES_PER_CYCLE = 4

// ── Porcentajes ───────────────────────────────────────────────────────

const PERCENT = /^\d{1,3}(\.\d{1,2})?$/

/** Valida el porcentaje del jugador (0–100, hasta 2 decimales); casa = 100 − jugador. */
export function parsePercentages(playerPercent: string): {
  player: Dec
  house: Dec
} {
  const raw = playerPercent.trim()
  if (!PERCENT.test(raw))
    throw new Error("Porcentaje inválido (0 a 100, hasta 2 decimales).")
  const player = dec(raw)
  if (player.lessThan(0) || player.greaterThan(HUNDRED))
    throw new Error("El porcentaje del jugador debe estar entre 0 y 100.")
  return { player, house: HUNDRED.sub(player) }
}

/** Parte del jugador sobre un importe elegible (≥ 0) y el resto para la casa. */
export function splitShare(
  eligible: Dec,
  playerPercent: Dec,
  rounding: "HALF_UP" | "DOWN" = "HALF_UP"
) {
  const raw = eligible.mul(playerPercent).div(HUNDRED)
  const player = raw.toDecimalPlaces(
    2,
    rounding === "HALF_UP"
      ? Prisma.Decimal.ROUND_HALF_UP
      : Prisma.Decimal.ROUND_DOWN
  )
  return { player, house: eligible.sub(player) }
}

// ── Jugadas ───────────────────────────────────────────────────────────

/** RESULTADO_BRUTO = nominal físicamente devuelto − nominal financiado. */
export function grossResult(returned: Dec, financed: Dec): Dec {
  if (returned.isNegative())
    throw new Error("El retorno no puede ser negativo.")
  if (!financed.greaterThan(0))
    throw new Error("Una jugada requiere fichas financiadas.")
  return returned.sub(financed)
}

export type ReconcileCheck =
  | { ok: true; result: Dec }
  | {
      ok: false
      reason:
        | "NO_FINANCED_PURCHASES"
        | "PENDING_PURCHASE"
        | "ZERO_NOT_CONFIRMED"
        | "ZERO_FLAG_WITH_CHIPS"
        | "NEGATIVE_RETURN"
        | "EXCEEDS_CIRCULATION"
    }

/**
 * Condiciones para CONFIRMAR una jugada: hay compras financiadas entregadas,
 * ninguna compra pendiente, retorno ≥ 0, y un retorno CERO solo con
 * confirmación expresa (la ausencia de registro nunca es retorno cero).
 */
export function checkReconciliation(input: {
  financed: Dec
  pendingPurchases: number
  returned: Dec
  zeroReturnConfirmed: boolean
  circulation: Dec
}): ReconcileCheck {
  if (!input.financed.greaterThan(0))
    return { ok: false, reason: "NO_FINANCED_PURCHASES" }
  if (input.pendingPurchases > 0)
    return { ok: false, reason: "PENDING_PURCHASE" }
  if (input.returned.isNegative())
    return { ok: false, reason: "NEGATIVE_RETURN" }
  if (input.returned.isZero() && !input.zeroReturnConfirmed)
    return { ok: false, reason: "ZERO_NOT_CONFIRMED" }
  if (input.returned.greaterThan(0) && input.zeroReturnConfirmed)
    return { ok: false, reason: "ZERO_FLAG_WITH_CHIPS" }
  if (input.returned.greaterThan(input.circulation))
    return { ok: false, reason: "EXCEEDS_CIRCULATION" }
  return { ok: true, result: grossResult(input.returned, input.financed) }
}

export const RECONCILE_MESSAGE: Record<
  Exclude<ReconcileCheck, { ok: true }>["reason"],
  string
> = {
  NO_FINANCED_PURCHASES:
    "La jugada no tiene compras financiadas entregadas: no hay nada que conciliar.",
  PENDING_PURCHASE:
    "Hay una compra en preparación: confírmala o cancélala antes de conciliar.",
  ZERO_NOT_CONFIRMED:
    "Para registrar un retorno de $0 confirma expresamente que el jugador terminó sin fichas.",
  ZERO_FLAG_WITH_CHIPS:
    "Marcaste retorno cero pero capturaste fichas devueltas: revisa la captura.",
  NEGATIVE_RETURN: "El retorno no puede ser negativo.",
  EXCEEDS_CIRCULATION:
    "El valor devuelto excede las fichas en circulación: revisa el importe o reporta la discrepancia.",
}

// ── Tramos de porcentaje ──────────────────────────────────────────────

export type SegmentLike = {
  id: string
  fromGameNumber: number
  playerPercent: Dec
  createdAt: Date
}

/**
 * Tramo vigente para la jugada k: el creado MÁS RECIENTEMENTE con
 * `fromGameNumber ≤ k`. «Todo el ciclo» crea uno desde la jugada 1 (gana
 * a todos los anteriores); «desde la siguiente», uno desde la próxima.
 */
export function segmentForGame(
  segments: SegmentLike[],
  gameNumber: number
): SegmentLike {
  const candidates = segments
    .filter((s) => s.fromGameNumber <= gameNumber)
    .sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
    )
  if (!candidates[0])
    throw new Error(`No hay porcentaje vigente para la jugada ${gameNumber}.`)
  return candidates[0]
}

export type GameFact = {
  gameNumber: number
  /** Resultado efectivo: bruto + ajustes auditados. */
  result: Dec
  segmentId: string
  playerPercent: Dec
}

export type Tranche = {
  key: string
  playerPercent: Dec
  gameNumbers: number[]
  gains: Dec
  losses: Dec
  net: Dec
}

/** Agrupa las jugadas por tramo (en orden de la primera jugada de cada uno). */
export function buildTranches(games: GameFact[]): Tranche[] {
  const out: Tranche[] = []
  for (const g of [...games].sort((a, b) => a.gameNumber - b.gameNumber)) {
    let t = out.find((x) => x.key === g.segmentId)
    if (!t) {
      t = {
        key: g.segmentId,
        playerPercent: g.playerPercent,
        gameNumbers: [],
        gains: ZERO,
        losses: ZERO,
        net: ZERO,
      }
      out.push(t)
    }
    t.gameNumbers.push(g.gameNumber)
    if (g.result.greaterThan(0)) t.gains = t.gains.add(g.result)
    else t.losses = t.losses.add(g.result.neg())
    t.net = t.gains.sub(t.losses)
  }
  return out
}

export type Allocation = Record<string, string>

/** ¿Hace falta que un socio decida cómo repartir las pérdidas entre tramos? */
function needsDecision(tranches: Tranche[], lossesToCover: Dec): boolean {
  const withGains = tranches.filter((t) => t.gains.greaterThan(0))
  const totalGains = withGains.reduce((a, t) => a.add(t.gains), ZERO)
  if (!lossesToCover.greaterThan(0) || !totalGains.greaterThan(lossesToCover))
    return false
  if (withGains.length < 2) return false
  // Si todos los tramos con ganancia tienen el mismo porcentaje, cualquier
  // distribución reparte lo mismo: no hay decisión que tomar.
  return withGains.some(
    (t) => !t.playerPercent.equals(withGains[0].playerPercent)
  )
}

/**
 * Valida una distribución de pérdidas entre tramos: cada tramo absorbe entre
 * 0 y SUS ganancias no repartidas, y la suma es exactamente la pérdida a
 * compensar (no desaparecen pérdidas ni se inventan importes negativos).
 */
export function validateAllocation(
  tranches: Tranche[],
  lossesToCover: Dec,
  allocation: Allocation
): string[] {
  const errors: string[] = []
  const keys = new Set(tranches.map((t) => t.key))
  for (const k of Object.keys(allocation))
    if (!keys.has(k)) errors.push(`El tramo ${k} no pertenece al ciclo.`)
  let total = ZERO
  for (const t of tranches) {
    const raw = allocation[t.key] ?? "0"
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(raw)) {
      errors.push(`Importe inválido para el tramo de ${fmt(t.playerPercent)}%.`)
      continue
    }
    const v = dec(raw)
    if (v.greaterThan(t.gains))
      errors.push(
        `El tramo de ${fmt(t.playerPercent)}% absorbe $${fmt(v)} pero solo tiene $${fmt(t.gains)} de ganancias no repartidas.`
      )
    total = total.add(v)
  }
  if (!total.equals(lossesToCover))
    errors.push(
      `La pérdida asignada ($${fmt(total)}) debe ser exactamente la pérdida compensada ($${fmt(lossesToCover)}).`
    )
  return errors
}

/** Absorción automática (sin decisión): llena los tramos en orden. */
function sequentialAbsorption(
  tranches: Tranche[],
  losses: Dec
): Map<string, Dec> {
  const out = new Map<string, Dec>()
  let left = losses
  for (const t of tranches) {
    const take = min(t.gains, left)
    out.set(t.key, take)
    left = left.sub(take)
  }
  return out
}

/** Absorción que MINIMIZA la parte del jugador: tramos de mayor % primero. */
function conservativeAbsorption(
  tranches: Tranche[],
  losses: Dec
): Map<string, Dec> {
  const ordered = [...tranches].sort((a, b) =>
    b.playerPercent.comparedTo(a.playerPercent)
  )
  const out = new Map<string, Dec>(tranches.map((t) => [t.key, ZERO]))
  let left = losses
  for (const t of ordered) {
    const take = min(t.gains, left)
    out.set(t.key, take)
    left = left.sub(take)
  }
  return out
}

// ── Corte del ciclo ───────────────────────────────────────────────────

export type CycleInput = {
  /** Jugadas CONFIRMADAS del ciclo. */
  games: GameFact[]
  /** Pérdida no cubierta arrastrada del ciclo anterior (≥ 0). */
  previousCarriedLoss: Dec
  /** Reserva positiva disponible ANTES del corte (ya sin lo comprometido). */
  reserveAvailable: Dec
  /** Anticipos EFECTIVAMENTE pagados (EXECUTED) en el ciclo. */
  advancesPaid: Dec
  /** Excedentes de anticipos anteriores que se acordó recuperar (≥ 0). */
  pendingRecovery: Dec
  /** Distribución de pérdidas entre tramos decidida por el socio. */
  allocation?: Allocation | null
}

export type TrancheResult = Tranche & {
  absorbed: Dec
  eligible: Dec
  playerShare: Dec
  houseShare: Dec
}

export type CycleResult = {
  tranches: TrancheResult[]
  grossTotal: Dec
  totalGains: Dec
  cycleLosses: Dec
  previousCarriedLoss: Dec
  lossesToCover: Dec
  coveredByGains: Dec
  deficit: Dec
  reserveBefore: Dec
  reserveConsumed: Dec
  carriedLossOut: Dec
  allocationRequired: boolean
  allocationErrors: string[]
  eligibleTotal: Dec
  playerShare: Dec
  houseShare: Dec
  advancesPaid: Dec
  recoveryApplied: Dec
  /** Saldo del jugador después de anticipos y recuperaciones (≥ 0). */
  balance: Dec
  /** Anticipos pagados por encima de la participación definitiva (≥ 0). */
  excessAdvance: Dec
}

export function computeCycle(input: CycleInput): CycleResult {
  const tranches = buildTranches(input.games)
  const grossTotal = input.games.reduce((a, g) => a.add(g.result), ZERO)
  const totalGains = tranches.reduce((a, t) => a.add(t.gains), ZERO)
  const cycleLosses = tranches.reduce((a, t) => a.add(t.losses), ZERO)
  const L0 = max(input.previousCarriedLoss, ZERO)
  const lossesToCover = cycleLosses.add(L0)
  const reserveBefore = max(input.reserveAvailable, ZERO)

  let absorbed: Map<string, Dec>
  let allocationRequired = false
  let allocationErrors: string[] = []
  let deficit = ZERO
  if (!totalGains.greaterThan(lossesToCover)) {
    // Todas las ganancias se consumen compensando pérdidas: nada que repartir.
    absorbed = new Map(tranches.map((t) => [t.key, t.gains]))
    deficit = lossesToCover.sub(totalGains)
  } else if (needsDecision(tranches, lossesToCover)) {
    allocationRequired = true
    if (input.allocation) {
      allocationErrors = validateAllocation(
        tranches,
        lossesToCover,
        input.allocation
      )
    } else {
      allocationErrors = [
        "Hay pérdidas entre tramos con porcentajes distintos: un socio debe decidir su distribución al preparar el corte.",
      ]
    }
    absorbed =
      allocationErrors.length === 0
        ? new Map(
            tranches.map((t) => [t.key, dec(input.allocation![t.key] ?? 0)])
          )
        : conservativeAbsorption(tranches, lossesToCover)
  } else {
    absorbed = sequentialAbsorption(tranches, lossesToCover)
  }
  const coveredByGains = lossesToCover.sub(deficit)
  const reserveConsumed = min(reserveBefore, deficit)
  const carriedLossOut = deficit.sub(reserveConsumed)

  const results: TrancheResult[] = tranches.map((t) => {
    const a = absorbed.get(t.key) ?? ZERO
    const eligible = t.gains.sub(a)
    const s = splitShare(eligible, t.playerPercent)
    return {
      ...t,
      absorbed: a,
      eligible,
      playerShare: s.player,
      houseShare: s.house,
    }
  })
  const eligibleTotal = results.reduce((x, t) => x.add(t.eligible), ZERO)
  const playerShare = results.reduce((x, t) => x.add(t.playerShare), ZERO)
  const houseShare = results.reduce((x, t) => x.add(t.houseShare), ZERO)
  const advancesPaid = max(input.advancesPaid, ZERO)
  const afterAdvances = playerShare.sub(advancesPaid)
  let recoveryApplied = ZERO
  let balance = ZERO
  let excessAdvance = ZERO
  if (afterAdvances.isNegative()) {
    excessAdvance = afterAdvances.neg()
  } else {
    recoveryApplied = min(afterAdvances, max(input.pendingRecovery, ZERO))
    balance = afterAdvances.sub(recoveryApplied)
  }
  return {
    tranches: results,
    grossTotal,
    totalGains,
    cycleLosses,
    previousCarriedLoss: L0,
    lossesToCover,
    coveredByGains,
    deficit,
    reserveBefore,
    reserveConsumed,
    carriedLossOut,
    allocationRequired,
    allocationErrors,
    eligibleTotal,
    playerShare,
    houseShare,
    advancesPaid,
    recoveryApplied,
    balance,
    excessAdvance,
  }
}

/**
 * Distribución del saldo entre RESERVA y PAGO: ambos ≥ 0 y su suma igual
 * al saldo disponible. Con excedente de anticipos no hay nada que repartir.
 */
export function validateDistribution(
  r: Pick<CycleResult, "balance" | "excessAdvance">,
  reserveAmount: Dec,
  payAmount: Dec
): string[] {
  const errors: string[] = []
  if (reserveAmount.isNegative() || payAmount.isNegative())
    errors.push("Reserva y pago no pueden ser negativos.")
  if (r.excessAdvance.greaterThan(0)) {
    if (!reserveAmount.isZero() || !payAmount.isZero())
      errors.push(
        "Hay anticipos excedidos: no hay saldo para reservar ni pagar (se abre una regularización)."
      )
    return errors
  }
  if (!reserveAmount.add(payAmount).equals(r.balance))
    errors.push(
      `Reserva ($${fmt(reserveAmount)}) + pago ($${fmt(payAmount)}) debe ser exactamente el saldo disponible ($${fmt(r.balance)}).`
    )
  return errors
}

// ── Límite conservador de anticipos ───────────────────────────────────

/**
 * Participación del jugador MATEMÁTICAMENTE GARANTIZADA con las jugadas
 * confirmadas: el mínimo entre todas las distribuciones válidas de pérdidas
 * entre tramos (absorber primero en los de mayor porcentaje), con redondeo
 * hacia abajo y un centavo de margen por cada tramo adicional. Nunca se
 * usa una distribución favorable arbitraria.
 */
export function guaranteedPlayerShare(input: {
  games: GameFact[]
  previousCarriedLoss: Dec
}): Dec {
  const tranches = buildTranches(input.games)
  const totalGains = tranches.reduce((a, t) => a.add(t.gains), ZERO)
  const losses = tranches
    .reduce((a, t) => a.add(t.losses), ZERO)
    .add(max(input.previousCarriedLoss, ZERO))
  if (!totalGains.greaterThan(losses)) return ZERO
  const absorbed = conservativeAbsorption(tranches, losses)
  let total = ZERO
  let active = 0
  for (const t of tranches) {
    const eligible = t.gains.sub(absorbed.get(t.key) ?? ZERO)
    if (eligible.greaterThan(0)) active++
    total = total.add(splitShare(eligible, t.playerPercent, "DOWN").player)
  }
  const margin = CENT.mul(Math.max(0, active - 1))
  return max(total.sub(margin), ZERO)
}

export type AdvanceLimitInput = {
  /** El ciclo del anticipo sigue acumulando jugadas (IN_PROGRESS). */
  cycleOpen: boolean
  /** Ciclos anteriores: todos cerrados (si no, la pérdida arrastrada no se conoce). */
  previousCyclesClosed: boolean
  /** Hay jugadas en curso, en discrepancia o en corrección en el ciclo. */
  unsettledGames: boolean
  /** Hay una regularización ABIERTA (sin decisión) del jugador. */
  openRegularization: boolean
  games: GameFact[]
  previousCarriedLoss: Dec
  /** Anticipos comprometidos del ciclo (autorizados vigentes + pagados). */
  committedAdvances: Dec
  /** Recuperaciones acordadas pendientes de anticipos excedidos previos. */
  pendingRecovery: Dec
}

export type AdvanceLimit = {
  guaranteedShare: Dec
  committed: Dec
  available: Dec
  blockedReason: string | null
}

/** Disponible para anticipos = garantizado − comprometido − recuperaciones (≥ 0). */
export function advanceLimit(input: AdvanceLimitInput): AdvanceLimit {
  const guaranteedShare = guaranteedPlayerShare(input)
  const committed = max(input.committedAdvances, ZERO)
  const blockedReason = !input.cycleOpen
    ? "El ciclo ya tiene sus cuatro jugadas: lo pendiente se paga en el corte."
    : !input.previousCyclesClosed
      ? "Hay un corte anterior sin aprobar: no se puede garantizar el cálculo."
      : input.unsettledGames
        ? "Hay una jugada sin conciliar o en corrección: no se puede garantizar el cálculo."
        : input.openRegularization
          ? "Hay una regularización pendiente de decisión."
          : null
  const available = blockedReason
    ? ZERO
    : max(
        guaranteedShare.sub(committed).sub(max(input.pendingRecovery, ZERO)),
        ZERO
      )
  return { guaranteedShare, committed, available, blockedReason }
}

// ── Reserva ───────────────────────────────────────────────────────────

export type ReserveMovementLike = { kind: string; amount: Dec }

const RESERVE_IN = new Set(["CREATED", "RELEASED_FROM_WITHDRAWAL"])

/** Saldo de la reserva = Σ entradas − Σ salidas (consumos y compromisos). */
export function reserveBalance(movements: ReserveMovementLike[]): Dec {
  return movements.reduce(
    (a, m) => (RESERVE_IN.has(m.kind) ? a.add(m.amount) : a.sub(m.amount)),
    ZERO
  )
}

/**
 * Reserva que se puede RETIRAR: el saldo menos el déficit confirmado del
 * ciclo en curso que esa reserva tendría que cubrir en su corte.
 */
export function withdrawableReserve(input: {
  balance: Dec
  currentCycleDeficit: Dec
}): Dec {
  return max(input.balance.sub(max(input.currentCycleDeficit, ZERO)), ZERO)
}

/** Déficit confirmado de un ciclo abierto: pérdidas + arrastre − ganancias. */
export function confirmedDeficit(input: {
  games: GameFact[]
  previousCarriedLoss: Dec
}): Dec {
  const net = input.games.reduce((a, g) => a.add(g.result), ZERO)
  return max(max(input.previousCarriedLoss, ZERO).sub(net), ZERO)
}

/** Recuperación FIFO de excedentes (los más antiguos primero). */
export function distributeRecovery(
  amount: Dec,
  pending: { id: string; remaining: Dec }[]
): { id: string; amount: Dec }[] {
  const out: { id: string; amount: Dec }[] = []
  let left = amount
  for (const p of pending) {
    if (!left.greaterThan(0)) break
    const take = min(left, p.remaining)
    if (take.greaterThan(0)) out.push({ id: p.id, amount: take })
    left = left.sub(take)
  }
  return out
}

// ── Estados derivados ────────────────────────────────────────────────

/** Estado de un anticipo o retiro a partir de lo pagado (EXECUTED). */
export function disbursementStatus(
  authorized: Dec,
  executed: Dec,
  closed: boolean
): "AUTHORIZED" | "PARTIALLY_PAID" | "PAID" | "CLOSED" {
  if (executed.greaterThanOrEqualTo(authorized)) return "PAID"
  if (closed) return "CLOSED"
  return executed.greaterThan(0) ? "PARTIALLY_PAID" : "AUTHORIZED"
}

/** Serializa un resultado del ciclo a texto (snapshot canónico). */
export function cycleResultToJson(r: CycleResult) {
  return {
    tranches: r.tranches.map((t) => ({
      key: t.key,
      playerPercent: fmt(t.playerPercent),
      gameNumbers: t.gameNumbers,
      gains: fmt(t.gains),
      losses: fmt(t.losses),
      net: fmt(t.net),
      absorbed: fmt(t.absorbed),
      eligible: fmt(t.eligible),
      playerShare: fmt(t.playerShare),
      houseShare: fmt(t.houseShare),
    })),
    grossTotal: fmt(r.grossTotal),
    totalGains: fmt(r.totalGains),
    cycleLosses: fmt(r.cycleLosses),
    previousCarriedLoss: fmt(r.previousCarriedLoss),
    lossesToCover: fmt(r.lossesToCover),
    coveredByGains: fmt(r.coveredByGains),
    deficit: fmt(r.deficit),
    reserveBefore: fmt(r.reserveBefore),
    reserveConsumed: fmt(r.reserveConsumed),
    carriedLossOut: fmt(r.carriedLossOut),
    allocationRequired: r.allocationRequired,
    allocationErrors: r.allocationErrors,
    eligibleTotal: fmt(r.eligibleTotal),
    playerShare: fmt(r.playerShare),
    houseShare: fmt(r.houseShare),
    advancesPaid: fmt(r.advancesPaid),
    recoveryApplied: fmt(r.recoveryApplied),
    balance: fmt(r.balance),
    excessAdvance: fmt(r.excessAdvance),
  }
}
export type CycleResultJson = ReturnType<typeof cycleResultToJson>

/** JSON canónico (claves ordenadas) para huellas de snapshot. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`
      )
      .join(",")}}`
  return JSON.stringify(value)
}
