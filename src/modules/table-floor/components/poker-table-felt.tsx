"use client"

import {
  CreditCard,
  Loader2,
  Plus,
  ShoppingCart,
  HandCoins,
} from "lucide-react"
import type { CSSProperties, ReactNode } from "react"

import { cn } from "@/lib/utils"
import {
  DEALER_POSITION,
  FELT_PALETTE,
  initialsOf,
  SEAT_LAYOUT,
  SEAT_STATE_LABEL,
  type FeltColor,
  type SeatState,
} from "@/modules/table-floor/table-floor.math"

import type { Occupant } from "./use-table-board"

/**
 * Mesa ovalada estilo casino (CSS, sin imágenes; óvalo vertical en celular y horizontal desde `sm`): barandal contrastante,
 * paño configurable y nueve asientos absolutos en posiciones FIJAS
 * (`SEAT_LAYOUT`, en % del contenedor) iguales en celular y escritorio.
 * Los asientos son botones reales (teclado, foco visible y etiquetas).
 */
export function PokerTableFelt({
  feltColor,
  children,
  center,
}: {
  feltColor: FeltColor
  children: ReactNode
  center: ReactNode
}) {
  const palette = FELT_PALETTE[feltColor]
  return (
    <div
      className="relative mx-auto aspect-[10/12] w-full max-w-3xl select-none sm:aspect-[16/10]"
      data-testid="poker-table"
      data-felt={feltColor}
      role="group"
      aria-label="Mesa de póker"
    >
      {/* Barandal + paño */}
      <div
        aria-hidden
        className="absolute inset-x-[12%] top-[10%] bottom-[11%] rounded-[50%] p-[2.2%] shadow-lg sm:inset-x-[8%] sm:top-[11%] sm:bottom-[13%]"
        style={{
          background: `linear-gradient(160deg, ${palette.rail}, #000000 140%)`,
        }}
      >
        <div
          className="h-full w-full rounded-[50%] ring-2 ring-white/10 ring-inset"
          data-testid="table-felt"
          style={
            {
              background: `radial-gradient(ellipse at 50% 40%, ${palette.felt} 0%, ${palette.feltEdge} 100%)`,
            } as CSSProperties
          }
        />
      </div>
      {/* Centro: nombre y estado (texto sobre paño con contraste ≥ 4.5) */}
      <div
        className="pointer-events-none absolute inset-x-[24%] top-[34%] flex flex-col items-center gap-0.5 text-center"
        style={{ color: palette.text }}
      >
        {center}
      </div>
      {children}
    </div>
  )
}

function positionStyle(p: { x: number; y: number }): CSSProperties {
  return {
    left: `${p.x}%`,
    top: `${p.y}%`,
    transform: "translate(-50%, -50%)",
  }
}

const STATE_STYLE: Record<SeatState, string> = {
  PENDING_BUY: "bg-amber-100 text-amber-950 ring-amber-500",
  PLAYING: "bg-emerald-100 text-emerald-950 ring-emerald-600",
  PURCHASE_IN_PROGRESS: "bg-sky-100 text-sky-950 ring-sky-600",
  SETTLING: "bg-violet-100 text-violet-950 ring-violet-600",
}

const STATE_SHORT: Record<SeatState, string> = {
  PENDING_BUY: "Pend. compra",
  PLAYING: "Jugando",
  PURCHASE_IN_PROGRESS: "En compra",
  SETTLING: "Liquidando",
}

export function PokerSeatAvatar({
  name,
  state,
  className,
}: {
  name: string
  state?: SeatState
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ring-2 sm:size-9 sm:text-xs",
        state ? STATE_STYLE[state] : "bg-muted text-foreground ring-border",
        className
      )}
    >
      {initialsOf(name)}
    </span>
  )
}

const seatBase =
  "absolute flex h-[76px] w-[clamp(68px,22%,120px)] flex-col items-center justify-center gap-0.5 rounded-xl px-1 text-center shadow-md outline-none transition-colors focus-visible:ring-4 focus-visible:ring-sky-400 sm:h-[86px]"

/** Un asiento: libre (indicador +) u ocupado (iniciales, nombre y estado). */
export function PokerSeat({
  seatNumber,
  occupant,
  disabled,
  onSelect,
}: {
  seatNumber: number
  occupant: Occupant | null
  disabled?: boolean
  onSelect: () => void
}) {
  const style = positionStyle(SEAT_LAYOUT[seatNumber])
  const badge = (
    <span
      aria-hidden
      className="bg-foreground text-background absolute -top-2 -left-1 flex size-5 items-center justify-center rounded-full text-[11px] font-bold shadow sm:size-6 sm:text-xs"
    >
      {seatNumber}
    </span>
  )
  if (!occupant)
    return (
      <button
        type="button"
        style={style}
        disabled={disabled}
        onClick={onSelect}
        className={cn(
          seatBase,
          "bg-background/90 text-foreground border-2 border-dashed border-white/70 hover:bg-white disabled:opacity-70"
        )}
        aria-label={`Asiento ${seatNumber}, libre`}
        data-testid={`seat-${seatNumber}`}
        data-seat-state="FREE"
      >
        {badge}
        <Plus className="size-5 sm:size-6" aria-hidden />
        <span className="text-[11px] font-medium sm:text-xs">Libre</span>
      </button>
    )
  const display = occupant.player.nickname || occupant.player.name.split(" ")[0]
  const Icon =
    occupant.state === "PURCHASE_IN_PROGRESS"
      ? ShoppingCart
      : occupant.state === "SETTLING"
        ? HandCoins
        : null
  return (
    <button
      type="button"
      style={style}
      onClick={onSelect}
      className={cn(
        seatBase,
        "bg-card text-card-foreground hover:bg-accent border-2",
        occupant.state === "PENDING_BUY"
          ? "border-amber-500"
          : occupant.state === "SETTLING"
            ? "border-violet-600"
            : occupant.state === "PURCHASE_IN_PROGRESS"
              ? "border-sky-600"
              : "border-emerald-600"
      )}
      aria-label={`Asiento ${seatNumber}, ${occupant.player.name}, ${SEAT_STATE_LABEL[occupant.state]}${occupant.debt.hasDebt ? ", con crédito pendiente" : ""}`}
      data-testid={`seat-${seatNumber}`}
      data-seat-state={occupant.state}
    >
      {badge}
      {occupant.debt.hasDebt ? (
        <span
          className="absolute -top-2 -right-1 flex size-5 items-center justify-center rounded-full bg-rose-600 text-white shadow sm:size-6"
          title="Crédito pendiente"
        >
          <CreditCard className="size-3 sm:size-3.5" aria-hidden />
        </span>
      ) : null}
      <PokerSeatAvatar name={occupant.player.name} state={occupant.state} />
      <span className="w-full truncate text-xs leading-tight font-semibold">
        {display}
      </span>
      <span className="flex items-center gap-0.5 text-[11px] leading-tight whitespace-nowrap">
        {Icon ? <Icon className="size-3" aria-hidden /> : null}
        {STATE_SHORT[occupant.state]}
      </span>
    </button>
  )
}

/**
 * El dealer como PERSONA: tarjeta con iniciales, nombre y distintivo
 * DEALER, dentro del óvalo, abajo al centro (entre los asientos 7 y 6).
 * No es un asiento ni un botón «D» de posición.
 */
export function DealerPersonCard({
  dealer,
  pending,
  onSelect,
}: {
  dealer: { name: string; nickname: string | null } | null
  pending?: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      style={positionStyle(DEALER_POSITION)}
      className={cn(
        "absolute flex h-[60px] w-[clamp(100px,30%,160px)] items-center gap-1.5 rounded-2xl px-2 text-left shadow-md outline-none focus-visible:ring-4 focus-visible:ring-sky-400 sm:h-[68px] sm:gap-2",
        dealer
          ? "bg-zinc-900 text-white ring-2 ring-amber-400"
          : "border-2 border-dashed border-white/70 bg-black/35 text-white"
      )}
      aria-label={
        dealer
          ? `Dealer: ${dealer.name}. Ver opciones del dealer`
          : "Sin dealer asignado. Asignar dealer"
      }
      data-testid="dealer-card"
      data-dealer={dealer ? "ASSIGNED" : "NONE"}
    >
      {pending ? (
        <Loader2 className="size-5 animate-spin" aria-hidden />
      ) : dealer ? (
        <PokerSeatAvatar
          name={dealer.name}
          className="bg-amber-300 text-zinc-950 ring-amber-500"
        />
      ) : (
        <PokerSeatAvatar
          name="?"
          className="bg-white/20 text-white ring-white/50"
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs leading-tight font-semibold">
          {dealer ? dealer.nickname || dealer.name.split(" ")[0] : "Sin dealer"}
        </span>
        <span
          className={cn(
            "mt-0.5 inline-block rounded px-1 text-[11px] leading-4 font-bold tracking-wide",
            dealer ? "bg-amber-400 text-zinc-950" : "bg-white/20"
          )}
        >
          {dealer ? "DEALER" : "Asignar"}
        </span>
      </span>
    </button>
  )
}
