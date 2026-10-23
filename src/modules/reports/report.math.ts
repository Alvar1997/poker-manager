import { Prisma } from "@/generated/prisma/client"
import { appConfig } from "@/config/app.config"
import { receivableStatus, ZERO } from "@/modules/credits/credit.math"

/**
 * Cálculos PUROS de reportes (Módulo 14). Sin acceso a la base: los
 * servicios cargan los hechos (deudas, aplicaciones, pagos) y estas
 * funciones los agrupan. La MISMA función alimenta la pantalla, la API y el
 * XLSX, así nunca hay dos fórmulas distintas para una cifra.
 *
 * Importes con Prisma.Decimal (nunca Float). Las cifras se devuelven como
 * strings "1234.50".
 *
 * Regla permanente: toda deuda se consulta global por jugador, desglosada
 * por SESIÓN DE ORIGEN y por cada COMPRA o RECOMPRA. Los pagos posteriores
 * se aplican a las obligaciones originales y no trasladan la deuda a la
 * fecha ni a la sesión del pago.
 */

export type Dec = Prisma.Decimal
export const dec = (v: Prisma.Decimal | string | number | null | undefined) =>
  new Prisma.Decimal(v ?? 0)
export const fmt = (v: Prisma.Decimal) => v.toFixed(2)
export { ZERO }

// ── Fechas en la zona del negocio ────────────────────────────────────

const TZ = appConfig.timezone

/** Minutos que la zona del negocio está desplazada respecto de UTC en `at`. */
export function tzOffsetMinutes(at: Date, timeZone: string = TZ): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  )
  return Math.round((asUtc - (at.getTime() - at.getMilliseconds())) / 60000)
}

/** Instante UTC en que empieza el día operativo `YYYY-MM-DD` (zona del negocio). */
export function businessDayStartUtc(day: string, timeZone: string = TZ): Date {
  const [y, m, d] = day.split("-").map(Number)
  const midnightUtc = Date.UTC(y, m - 1, d)
  const offset = tzOffsetMinutes(
    new Date(midnightUtc + 12 * 3600_000),
    timeZone
  )
  return new Date(midnightUtc - offset * 60_000)
}

/** Rango semiabierto [desde, hasta+1día) en UTC a partir de días operativos. */
export function businessRange(from?: string, to?: string) {
  const gte = from ? businessDayStartUtc(from) : undefined
  let lt: Date | undefined
  if (to) {
    const [y, m, d] = to.split("-").map(Number)
    const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
    lt = businessDayStartUtc(next)
  }
  return gte || lt ? { ...(gte && { gte }), ...(lt && { lt }) } : undefined
}

/** Día operativo (YYYY-MM-DD) de un instante, en la zona del negocio. */
export function businessDay(at: Date, timeZone: string = TZ): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at)
}

// ── Créditos: hechos ──────────────────────────────────────────────────

/** Una deuda (PlayerDebt) con su contexto de origen INMUTABLE. */
export type DebtFact = {
  id: string
  createdAt: Date
  originalAmount: Dec
  player: { id: string; name: string }
  session: {
    id: string
    folio: string
    /** Instante de operación: apertura real (o creación si nunca abrió). */
    operatedAt: Date
    /** Fecha operativa de la sesión (businessDate, YYYY-MM-DD). */
    businessDate?: string
    status: string
    closedAt: Date | null
  }
  table: { id: string; name: string }
  cycleNumber: number | null
  purchase: {
    id: string
    folio: string
    type: "INITIAL_PURCHASE" | "REBUY" | null
    rebuyNumber: number | null
    nominalAmount: Dec
    confirmedAt: Date | null
  }
  authorization: {
    partnerId: string
    partnerName: string
    channel: string
  }
  signature: { id: string; status: string; signedAt: Date | null } | null
}

export type AllocationSourceKind =
  | "RECEIVABLE_PAYMENT"
  | "PURCHASE_PAYMENT"
  | "CHIP_SETTLEMENT_OFFSET"
  | "PURCHASE_REVERSAL"

/** Una aplicación del libro inmutable `payment_allocations`. */
export type AllocationFact = {
  id: string
  receivableId: string
  kind: "APPLICATION" | "REVERSAL"
  source: AllocationSourceKind
  amount: Dec
  allocatedAt: Date
  allocationOrder: number
  reversesAllocationId: string | null
  /** Abono general (Módulo 10). */
  payment: {
    id: string
    folio: string
    method: string
    origin: string
    sessionId: string | null
    sessionFolio: string | null
    amount: Dec
    status: string
    paidAt: Date | null
  } | null
  /** Pago de la propia compra (transferencia verificada después). */
  purchasePayment: { id: string; method: string } | null
  /** Compensación con fichas en una liquidación (Módulo 11). */
  settlement: { id: string; folio: string; sessionId: string } | null
}

/** Clase de movimiento para el reporte (cada una se muestra por separado). */
export type MovementClass =
  | "PAYMENT" // abono general aplicado por FIFO
  | "LINKED_PAYMENT" // pago vinculado a la compra (no FIFO)
  | "OFFSET" // compensación con fichas (no es dinero)
  | "REVERSAL" // reverso de una aplicación (aumenta el saldo)
  | "EXTINCTION" // extinción por reverso de compra (Módulo 16; sin dinero)

export function classifyAllocation(a: AllocationFact): MovementClass {
  if (a.kind === "REVERSAL") return "REVERSAL"
  if (a.source === "PURCHASE_PAYMENT") return "LINKED_PAYMENT"
  if (a.source === "CHIP_SETTLEMENT_OFFSET") return "OFFSET"
  if (a.source === "PURCHASE_REVERSAL") return "EXTINCTION"
  return "PAYMENT"
}

export const MOVEMENT_CLASS_LABEL: Record<MovementClass, string> = {
  PAYMENT: "Abono (FIFO)",
  LINKED_PAYMENT: "Pago vinculado a la compra",
  OFFSET: "Compensación con fichas",
  REVERSAL: "Reverso",
  EXTINCTION: "Extinción por reverso de compra",
}

// ── Créditos: acumuladores ────────────────────────────────────────────

/** Componentes de un saldo; `balance = original − pagos − compensaciones + reversos`. */
export type Buckets = {
  original: Dec
  payments: Dec
  linkedPayments: Dec
  offsets: Dec
  reversals: Dec
  /** Módulo 16: saldo extinguido por reverso de la compra (fichas devueltas). */
  extinctions: Dec
}

const emptyBuckets = (): Buckets => ({
  original: ZERO,
  payments: ZERO,
  linkedPayments: ZERO,
  offsets: ZERO,
  reversals: ZERO,
  extinctions: ZERO,
})

function addMovement(b: Buckets, a: AllocationFact) {
  const cls = classifyAllocation(a)
  if (cls === "PAYMENT") b.payments = b.payments.add(a.amount)
  else if (cls === "LINKED_PAYMENT")
    b.linkedPayments = b.linkedPayments.add(a.amount)
  else if (cls === "OFFSET") b.offsets = b.offsets.add(a.amount)
  else if (cls === "EXTINCTION") b.extinctions = b.extinctions.add(a.amount)
  else b.reversals = b.reversals.add(a.amount)
}

function mergeBuckets(into: Buckets, from: Buckets) {
  into.original = into.original.add(from.original)
  into.payments = into.payments.add(from.payments)
  into.linkedPayments = into.linkedPayments.add(from.linkedPayments)
  into.offsets = into.offsets.add(from.offsets)
  into.reversals = into.reversals.add(from.reversals)
  into.extinctions = into.extinctions.add(from.extinctions)
}

export function appliedOf(b: Buckets): Dec {
  return b.payments
    .add(b.linkedPayments)
    .add(b.offsets)
    .add(b.extinctions)
    .sub(b.reversals)
}

export function balanceOf(b: Buckets): Dec {
  return b.original.sub(appliedOf(b))
}

export type BucketView = {
  original: string
  /** Abonos FIFO + pagos vinculados (dinero real aplicado). */
  paymentsApplied: string
  payments: string
  linkedPayments: string
  offsets: string
  reversals: string
  extinctions: string
  applied: string
  balance: string
}

export function bucketView(b: Buckets): BucketView {
  return {
    original: fmt(b.original),
    paymentsApplied: fmt(b.payments.add(b.linkedPayments)),
    payments: fmt(b.payments),
    linkedPayments: fmt(b.linkedPayments),
    offsets: fmt(b.offsets),
    reversals: fmt(b.reversals),
    extinctions: fmt(b.extinctions),
    applied: fmt(appliedOf(b)),
    balance: fmt(balanceOf(b)),
  }
}

// ── Créditos: deuda al cierre vs deuda actual ─────────────────────────

/**
 * Para una deuda nacida en una sesión ya CERRADA: saldo en el instante del
 * cierre (reconstruido del libro inmutable con las aplicaciones registradas
 * hasta `closedAt`) y los movimientos posteriores, por clase. La identidad
 * `alCierre − pagos − vinculados − compensaciones + reversos = actual` se
 * verifica siempre.
 */
export type AtClosure = {
  balanceAtClosure: Dec
  after: Buckets
}

function atClosureOf(
  original: Dec,
  allocations: AllocationFact[],
  closedAt: Date | null
): AtClosure | null {
  if (!closedAt) return null
  const before = emptyBuckets()
  before.original = original
  const after = emptyBuckets()
  for (const a of allocations) {
    if (a.allocatedAt.getTime() <= closedAt.getTime()) addMovement(before, a)
    else addMovement(after, a)
  }
  return { balanceAtClosure: balanceOf(before), after }
}

export type AtClosureView = {
  balanceAtClosure: string
  paymentsAfter: string
  linkedPaymentsAfter: string
  offsetsAfter: string
  reversalsAfter: string
  extinctionsAfter: string
  currentBalance: string
  /** La identidad cierra exactamente (sin diferencias sin explicar). */
  reconciles: boolean
}

function atClosureView(c: AtClosure, current: Dec): AtClosureView {
  const derived = c.balanceAtClosure
    .sub(c.after.payments)
    .sub(c.after.linkedPayments)
    .sub(c.after.offsets)
    .sub(c.after.extinctions)
    .add(c.after.reversals)
  return {
    balanceAtClosure: fmt(c.balanceAtClosure),
    paymentsAfter: fmt(c.after.payments),
    linkedPaymentsAfter: fmt(c.after.linkedPayments),
    offsetsAfter: fmt(c.after.offsets),
    reversalsAfter: fmt(c.after.reversals),
    extinctionsAfter: fmt(c.after.extinctions),
    currentBalance: fmt(current),
    reconciles: derived.equals(current),
  }
}

// ── Créditos: árbol jugador → sesión → compra → aplicaciones ─────────

export type ApplicationView = {
  id: string
  class: MovementClass
  classLabel: string
  amount: string
  /** Fecha REAL de la aplicación (no la de la sesión de origen). */
  appliedAt: string
  order: number
  paymentFolio: string | null
  paymentMethod: string | null
  paymentOrigin: string | null
  /** Sesión donde se COBRÓ el abono (puede ser otra o ninguna). */
  collectedInSessionFolio: string | null
  paymentTotal: string | null
  settlementFolio: string | null
}

export type DebtNode = BucketView & {
  id: string
  status: string
  createdAt: string
  purchase: {
    id: string
    folio: string
    type: string | null
    typeLabel: string
    rebuyNumber: number | null
    nominalAmount: string
  }
  table: { id: string; name: string }
  cycleNumber: number | null
  authorization: { partnerId: string; partnerName: string; channel: string }
  signature: { id: string; status: string; signedAt: string | null } | null
  lastMovementAt: string | null
  atClosure: AtClosureView | null
  applications: ApplicationView[]
}

export type SessionNode = BucketView & {
  session: {
    id: string
    folio: string
    operatedAt: string
    operatedDay: string
    status: string
    closedAt: string | null
  }
  debtsCount: number
  openDebts: number
  lastMovementAt: string | null
  atClosure: AtClosureView | null
  debts: DebtNode[]
}

export type PlayerNode = BucketView & {
  player: { id: string; name: string }
  sessionsWithBalance: number
  debtsCount: number
  oldestOpenDebtAt: string | null
  lastMovementAt: string | null
  sessions: SessionNode[]
}

export function purchaseTypeLabel(
  type: string | null,
  rebuyNumber: number | null
) {
  if (type === "REBUY")
    return rebuyNumber ? `Recompra #${rebuyNumber}` : "Recompra"
  if (type === "INITIAL_PURCHASE") return "Compra inicial"
  return "Compra"
}

const byTimeThenId = (
  a: { at: Date; id: string },
  b: { at: Date; id: string }
) => a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

const maxDate = (a: Date | null, b: Date | null) =>
  !a ? b : !b ? a : a.getTime() >= b.getTime() ? a : b

/**
 * Construye el árbol de deudas. Las deudas se agrupan por el `sessionId`
 * ORIGINAL de cada obligación (nunca por la sesión o la fecha del pago).
 * Orden: jugadores por deuda más antigua pendiente; sesiones y compras de
 * la más antigua a la más reciente (el mismo orden que usa FIFO).
 */
export function buildCreditTree(
  debts: DebtFact[],
  allocations: AllocationFact[]
): PlayerNode[] {
  const allocByDebt = new Map<string, AllocationFact[]>()
  for (const a of allocations) {
    const list = allocByDebt.get(a.receivableId) ?? []
    list.push(a)
    allocByDebt.set(a.receivableId, list)
  }

  type SAcc = {
    fact: DebtFact["session"]
    buckets: Buckets
    closure: { balanceAtClosure: Dec; after: Buckets } | null
    debts: DebtNode[]
    open: number
    last: Date | null
  }
  type PAcc = {
    player: DebtFact["player"]
    buckets: Buckets
    sessions: Map<string, SAcc>
    oldestOpen: Date | null
    last: Date | null
    count: number
  }
  const players = new Map<string, PAcc>()

  const ordered = [...debts].sort((a, b) =>
    byTimeThenId({ at: a.createdAt, id: a.id }, { at: b.createdAt, id: b.id })
  )
  for (const d of ordered) {
    const allocs = (allocByDebt.get(d.id) ?? []).sort((a, b) =>
      byTimeThenId(
        { at: a.allocatedAt, id: a.id },
        { at: b.allocatedAt, id: b.id }
      )
    )
    const b = emptyBuckets()
    b.original = d.originalAmount
    for (const a of allocs) addMovement(b, a)
    const balance = balanceOf(b)
    const applied = appliedOf(b)
    const closure = atClosureOf(d.originalAmount, allocs, d.session.closedAt)
    const last = allocs.length ? allocs[allocs.length - 1].allocatedAt : null
    const node: DebtNode = {
      id: d.id,
      ...bucketView(b),
      status: receivableStatus(d.originalAmount, applied),
      createdAt: d.createdAt.toISOString(),
      purchase: {
        id: d.purchase.id,
        folio: d.purchase.folio,
        type: d.purchase.type,
        typeLabel: purchaseTypeLabel(d.purchase.type, d.purchase.rebuyNumber),
        rebuyNumber: d.purchase.rebuyNumber,
        nominalAmount: fmt(d.purchase.nominalAmount),
      },
      table: d.table,
      cycleNumber: d.cycleNumber,
      authorization: d.authorization,
      signature: d.signature
        ? {
            id: d.signature.id,
            status: d.signature.status,
            signedAt: d.signature.signedAt?.toISOString() ?? null,
          }
        : null,
      lastMovementAt: last?.toISOString() ?? null,
      atClosure: closure ? atClosureView(closure, balance) : null,
      applications: allocs.map((a) => ({
        id: a.id,
        class: classifyAllocation(a),
        classLabel: MOVEMENT_CLASS_LABEL[classifyAllocation(a)],
        amount: fmt(a.amount),
        appliedAt: a.allocatedAt.toISOString(),
        order: a.allocationOrder,
        paymentFolio: a.payment?.folio ?? null,
        paymentMethod: a.payment?.method ?? a.purchasePayment?.method ?? null,
        paymentOrigin: a.payment?.origin ?? null,
        collectedInSessionFolio: a.payment?.sessionFolio ?? null,
        paymentTotal: a.payment ? fmt(a.payment.amount) : null,
        settlementFolio: a.settlement?.folio ?? null,
      })),
    }

    const p: PAcc = players.get(d.player.id) ?? {
      player: d.player,
      buckets: emptyBuckets(),
      sessions: new Map(),
      oldestOpen: null,
      last: null,
      count: 0,
    }
    players.set(d.player.id, p)
    const s: SAcc = p.sessions.get(d.session.id) ?? {
      fact: d.session,
      buckets: emptyBuckets(),
      closure: d.session.closedAt
        ? { balanceAtClosure: ZERO, after: emptyBuckets() }
        : null,
      debts: [],
      open: 0,
      last: null,
    }
    p.sessions.set(d.session.id, s)

    mergeBuckets(s.buckets, b)
    mergeBuckets(p.buckets, b)
    if (s.closure && closure) {
      s.closure.balanceAtClosure = s.closure.balanceAtClosure.add(
        closure.balanceAtClosure
      )
      mergeBuckets(s.closure.after, closure.after)
    }
    s.debts.push(node)
    s.last = maxDate(s.last, last)
    p.last = maxDate(p.last, last)
    p.count += 1
    if (balance.greaterThan(0)) {
      s.open += 1
      if (!p.oldestOpen || d.createdAt < p.oldestOpen)
        p.oldestOpen = d.createdAt
    }
  }

  const result: PlayerNode[] = []
  for (const p of players.values()) {
    const sessions: SessionNode[] = [...p.sessions.values()]
      .sort((a, b) =>
        byTimeThenId(
          { at: a.fact.operatedAt, id: a.fact.id },
          { at: b.fact.operatedAt, id: b.fact.id }
        )
      )
      .map((s) => ({
        ...bucketView(s.buckets),
        session: {
          id: s.fact.id,
          folio: s.fact.folio,
          operatedAt: s.fact.operatedAt.toISOString(),
          operatedDay: s.fact.businessDate ?? businessDay(s.fact.operatedAt),
          status: s.fact.status,
          closedAt: s.fact.closedAt?.toISOString() ?? null,
        },
        debtsCount: s.debts.length,
        openDebts: s.open,
        lastMovementAt: s.last?.toISOString() ?? null,
        atClosure: s.closure
          ? atClosureView(s.closure, balanceOf(s.buckets))
          : null,
        debts: s.debts,
      }))
    result.push({
      ...bucketView(p.buckets),
      player: p.player,
      sessionsWithBalance: sessions.filter((s) => dec(s.balance).greaterThan(0))
        .length,
      debtsCount: p.count,
      oldestOpenDebtAt: p.oldestOpen?.toISOString() ?? null,
      lastMovementAt: p.last?.toISOString() ?? null,
      sessions,
    })
  }
  return result.sort((a, b) => {
    // Deudas más antiguas primero; sin saldo al final.
    if (a.oldestOpenDebtAt && b.oldestOpenDebtAt)
      return (
        a.oldestOpenDebtAt.localeCompare(b.oldestOpenDebtAt) ||
        a.player.id.localeCompare(b.player.id)
      )
    if (a.oldestOpenDebtAt) return -1
    if (b.oldestOpenDebtAt) return 1
    return a.player.name.localeCompare(b.player.name, "es")
  })
}

/** Totales globales del árbol (suma de jugadores; nunca de filas repetidas). */
export function creditTotals(tree: PlayerNode[]) {
  const t = emptyBuckets()
  let playersWithBalance = 0
  let oldest: string | null = null
  for (const p of tree) {
    t.original = t.original.add(dec(p.original))
    t.payments = t.payments.add(dec(p.payments))
    t.linkedPayments = t.linkedPayments.add(dec(p.linkedPayments))
    t.offsets = t.offsets.add(dec(p.offsets))
    t.reversals = t.reversals.add(dec(p.reversals))
    t.extinctions = t.extinctions.add(dec(p.extinctions))
    if (dec(p.balance).greaterThan(0)) playersWithBalance += 1
    if (p.oldestOpenDebtAt && (!oldest || p.oldestOpenDebtAt < oldest))
      oldest = p.oldestOpenDebtAt
  }
  return {
    ...bucketView(t),
    players: tree.length,
    playersWithBalance,
    oldestOpenDebtAt: oldest,
  }
}

/** Filtro por estado DERIVADO de la deuda (se aplica tras calcular saldos). */
export function filterTreeByDebtStatus(
  tree: PlayerNode[],
  status: string | undefined
): PlayerNode[] {
  if (!status) return tree
  const debtsOk = (d: DebtNode) => d.status === status
  const out: PlayerNode[] = []
  for (const p of tree) {
    const sessions = p.sessions
      .map((s) => ({ ...s, debts: s.debts.filter(debtsOk) }))
      .filter((s) => s.debts.length > 0)
    if (sessions.length === 0) continue
    // Recalcula los totales desde las deudas que quedan.
    const sessionsRe = sessions.map((s) => ({
      ...s,
      ...sumDebtViews(s.debts),
      debtsCount: s.debts.length,
      openDebts: s.debts.filter((d) => dec(d.balance).greaterThan(0)).length,
      atClosure: s.atClosure ? sumAtClosure(s.debts) : null,
    }))
    const all = sessionsRe.flatMap((s) => s.debts)
    const oldestOpen = all
      .filter((d) => dec(d.balance).greaterThan(0))
      .map((d) => d.createdAt)
      .sort()[0]
    out.push({
      ...p,
      ...sumDebtViews(all),
      sessions: sessionsRe,
      debtsCount: all.length,
      sessionsWithBalance: sessionsRe.filter((s) =>
        dec(s.balance).greaterThan(0)
      ).length,
      oldestOpenDebtAt: oldestOpen ?? null,
    })
  }
  return out
}

function sumDebtViews(debts: DebtNode[]): BucketView {
  const b = emptyBuckets()
  for (const d of debts) {
    b.original = b.original.add(dec(d.original))
    b.payments = b.payments.add(dec(d.payments))
    b.linkedPayments = b.linkedPayments.add(dec(d.linkedPayments))
    b.offsets = b.offsets.add(dec(d.offsets))
    b.reversals = b.reversals.add(dec(d.reversals))
    b.extinctions = b.extinctions.add(dec(d.extinctions))
  }
  return bucketView(b)
}

function sumAtClosure(debts: DebtNode[]): AtClosureView {
  let atClose = ZERO
  const after = emptyBuckets()
  let current = ZERO
  for (const d of debts) {
    if (!d.atClosure) continue
    atClose = atClose.add(dec(d.atClosure.balanceAtClosure))
    after.payments = after.payments.add(dec(d.atClosure.paymentsAfter))
    after.linkedPayments = after.linkedPayments.add(
      dec(d.atClosure.linkedPaymentsAfter)
    )
    after.offsets = after.offsets.add(dec(d.atClosure.offsetsAfter))
    after.reversals = after.reversals.add(dec(d.atClosure.reversalsAfter))
    after.extinctions = after.extinctions.add(dec(d.atClosure.extinctionsAfter))
    current = current.add(dec(d.balance))
  }
  return atClosureView({ balanceAtClosure: atClose, after }, current)
}

// ── Abonos: importe del pago ≠ importe aplicado ───────────────────────

export type PaymentWithAllocations = {
  id: string
  amount: Dec
  status: string
  allocations: { kind: "APPLICATION" | "REVERSAL"; amount: Dec }[]
  unapplied: Dec
}

/**
 * Totales de abonos SIN duplicar por las filas de aplicación: el recibido
 * se suma UNA vez por abono confirmado; lo aplicado es la suma neta de sus
 * aplicaciones. Un abono de $4,000 repartido en dos deudas suma $4,000.
 */
export function paymentTotals(payments: PaymentWithAllocations[]) {
  let received = ZERO
  let applied = ZERO
  let unapplied = ZERO
  let reversed = ZERO
  let count = 0
  for (const p of payments) {
    if (p.status === "CONFIRMED") {
      received = received.add(p.amount)
      count += 1
    } else if (p.status === "REVERSED") reversed = reversed.add(p.amount)
    unapplied = unapplied.add(p.unapplied)
    for (const a of p.allocations)
      applied =
        a.kind === "APPLICATION" ? applied.add(a.amount) : applied.sub(a.amount)
  }
  return {
    confirmedCount: count,
    received: fmt(received),
    appliedNet: fmt(applied),
    unapplied: fmt(unapplied),
    reversed: fmt(reversed),
  }
}

// ── Utilidades varias ─────────────────────────────────────────────────

export function sumDec<T>(rows: T[], pick: (r: T) => Dec | string | null) {
  return rows.reduce((acc, r) => acc.add(dec(pick(r))), ZERO)
}

/** Paginación acotada. */
export function pageWindow(page: number, pageSize: number) {
  return { skip: (page - 1) * pageSize, take: pageSize }
}
