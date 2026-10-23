/**
 * Mesa interactiva — reglas PURAS compartidas por servidor y cliente
 * (sin Prisma ni "server-only"): geometría de asientos, paleta de paños con
 * contraste verificado y derivación del estado visual de cada asiento.
 *
 * Nada de aquí decide dinero ni fichas: el tipo de la siguiente compra
 * (inicial o recompra) lo calcula el servidor con la numeración del
 * Módulo 08 (`nextPurchaseNumber`), y la vista solo lo muestra.
 */

/** Nueve asientos fijos. La numeración nunca cambia por tamaño de pantalla. */
export const SEAT_COUNT = 9
export const SEAT_NUMBERS: readonly number[] = Array.from(
  { length: SEAT_COUNT },
  (_, i) => i + 1
)

export function isValidSeatNumber(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= SEAT_COUNT
}

/**
 * Centro de cada asiento en % del contenedor (x: izquierda→derecha,
 * y: arriba→abajo). Misma topología en celular y escritorio:
 * 1-2-3 arriba, 4-5 a la derecha, 6-7 abajo, 8-9 a la izquierda.
 */
export const SEAT_LAYOUT: Readonly<Record<number, { x: number; y: number }>> = {
  1: { x: 24, y: 11 },
  2: { x: 50, y: 8 },
  3: { x: 76, y: 11 },
  4: { x: 90, y: 38 },
  5: { x: 90, y: 64 },
  6: { x: 69, y: 91 },
  7: { x: 31, y: 91 },
  8: { x: 10, y: 64 },
  9: { x: 10, y: 38 },
}

/**
 * El dealer es una PERSONA, no un asiento: va DENTRO del óvalo, en la zona
 * inferior central, alineado con el hueco entre los asientos 7 y 6.
 */
export const DEALER_POSITION = {
  x: (SEAT_LAYOUT[7].x + SEAT_LAYOUT[6].x) / 2,
  y: 67,
} as const

// ── Paño ──────────────────────────────────────────────────────────────

export const FELT_COLORS = [
  "CASINO_GREEN",
  "NAVY",
  "WINE",
  "BLACK",
  "GRAPHITE",
  "PURPLE",
] as const
export type FeltColor = (typeof FELT_COLORS)[number]
export const DEFAULT_FELT: FeltColor = "CASINO_GREEN"

/**
 * Paleta CERRADA: no hay color libre porque no se podría garantizar el
 * contraste. `felt`/`feltEdge` = degradado del paño, `rail` = borde
 * (barandal) y `text` = texto sobre el paño (nombre y estado de la mesa).
 */
export const FELT_PALETTE: Readonly<
  Record<
    FeltColor,
    {
      label: string
      felt: string
      feltEdge: string
      rail: string
      text: string
    }
  >
> = {
  CASINO_GREEN: {
    label: "Verde casino",
    felt: "#1f7a4d",
    feltEdge: "#0f4a2e",
    rail: "#3d2414",
    text: "#ffffff",
  },
  NAVY: {
    label: "Azul oscuro",
    felt: "#1f3f78",
    feltEdge: "#0f2147",
    rail: "#2b2b2b",
    text: "#ffffff",
  },
  WINE: {
    label: "Rojo vino",
    felt: "#7a1f35",
    feltEdge: "#4a0f1f",
    rail: "#2e1a10",
    text: "#ffffff",
  },
  BLACK: {
    label: "Negro",
    felt: "#2a2a2a",
    feltEdge: "#0d0d0d",
    rail: "#5a3a22",
    text: "#ffffff",
  },
  GRAPHITE: {
    label: "Gris grafito",
    felt: "#4a4f57",
    feltEdge: "#2a2e33",
    rail: "#1c1c1c",
    text: "#ffffff",
  },
  PURPLE: {
    label: "Morado oscuro",
    felt: "#4b2a78",
    feltEdge: "#2a1547",
    rail: "#2b1d12",
    text: "#ffffff",
  },
}

export function isFeltColor(v: unknown): v is FeltColor {
  return typeof v === "string" && (FELT_COLORS as readonly string[]).includes(v)
}

/** Luminancia relativa WCAG 2.x de un color #rrggbb. */
export function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) throw new Error(`Color inválido: ${hex}`)
  const n = parseInt(m[1], 16)
  const channel = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  )
}

/** Razón de contraste WCAG entre dos colores (1–21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (x, y) => y - x
  )
  return (hi + 0.05) / (lo + 0.05)
}

/** Contraste mínimo exigido al texto sobre el paño (AA texto normal). */
export const MIN_FELT_TEXT_CONTRAST = 4.5

// ── Estado del asiento ────────────────────────────────────────────────

/**
 * - PENDING_BUY: sentado, sin fichas recibidas en su cadena de
 *   participaciones (aún no compra). No genera compra, deuda ni fichas.
 * - PLAYING: ya recibió fichas (compra confirmada).
 * - PURCHASE_IN_PROGRESS: tiene una compra en preparación (continuarla).
 * - SETTLING: liquidación en curso (DRAFT/READY): sin compras ni cambios.
 */
export type SeatState =
  "PENDING_BUY" | "PLAYING" | "PURCHASE_IN_PROGRESS" | "SETTLING"

export function deriveSeatState(input: {
  chainConfirmedPurchases: number
  hasPendingPurchase: boolean
  hasSettlementInProgress: boolean
}): SeatState {
  if (input.hasSettlementInProgress) return "SETTLING"
  if (input.hasPendingPurchase) return "PURCHASE_IN_PROGRESS"
  return input.chainConfirmedPurchases > 0 ? "PLAYING" : "PENDING_BUY"
}

export const SEAT_STATE_LABEL: Record<SeatState, string> = {
  PENDING_BUY: "Pendiente de compra",
  PLAYING: "Jugando",
  PURCHASE_IN_PROGRESS: "Compra en curso",
  SETTLING: "Liquidando",
}

/**
 * Acciones que admite cada estado (la interfaz las muestra; el servidor
 * vuelve a validar todo). Un jugador sin fichas no se liquida: se retira.
 */
export function seatActions(state: SeatState) {
  return {
    buy: state === "PENDING_BUY" || state === "PLAYING",
    continuePurchase: state === "PURCHASE_IN_PROGRESS",
    settle: state === "PLAYING" || state === "SETTLING",
    withdraw: state === "PENDING_BUY",
    move: state === "PENDING_BUY" || state === "PLAYING",
  }
}

/** Iniciales para el avatar (sin archivos de imagen). */
export function initialsOf(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((p) => p.length > 0)
  if (parts.length === 0) return "?"
  const first = parts[0][0] ?? ""
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : ""
  return (first + last).toUpperCase()
}

/** Texto de búsqueda sin acentos ni mayúsculas (búsqueda tolerante). */
export function foldAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
}

/** Montos sugeridos de la compra rápida (sugerencias de interfaz, NO límites). */
export const QUICK_BUY_AMOUNTS: readonly string[] = [
  "500.00",
  "1000.00",
  "2000.00",
  "3000.00",
  "5000.00",
]
