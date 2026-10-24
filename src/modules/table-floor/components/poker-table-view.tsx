"use client"

import { Loader2 } from "lucide-react"
import { useState } from "react"

import { cn } from "@/lib/utils"
import { formatMXN } from "@/modules/cash/components/format"
import {
  FELT_PALETTE,
  SEAT_COUNT,
} from "@/modules/table-floor/table-floor.math"

import { DealerAssignmentSheet } from "./dealer-assignment-sheet"
import { SeatChangeSheet, TableTransferSheet } from "./move-sheets"
import { PlayerSearchSheet } from "./player-search-sheet"
import { DealerPersonCard, PokerSeat, PokerTableFelt } from "./poker-table-felt"
import { QuickPurchaseSheet } from "./quick-purchase-sheet"
import { OutSheet } from "./out-sheet"
import { QuickSettlementSheet } from "./quick-settlement-sheet"
import {
  SeatActionSheet,
  type FloorPermissions,
  type SeatAction,
} from "./seat-action-sheet"
import { TableAppearanceSettings } from "./table-appearance-settings"
import { TableOperationSummary } from "./table-operation-summary"
import {
  useRefreshFloor,
  useTableBoard,
  type Occupant,
  type TableBoard,
} from "./use-table-board"

type Panel =
  | { kind: "free"; seat: number }
  | {
      kind: "occupant" | SeatAction
      participationId: string
      snapshot: Occupant
    }
  | { kind: "dealer" }
  | null

/**
 * Centro de operaciones de la mesa: mesa ovalada con nueve asientos, el
 * dealer como persona entre los asientos 7 y 6, paño configurable y
 * paneles inferiores para sentar, comprar, recomprar, liquidar, cambiar de
 * asiento y transferir. Toda regla la decide el servidor; la vista se
 * refresca con su respuesta.
 */
export function PokerTableView({
  sessionId,
  tableId,
  initialBoard,
  perms,
  partners,
}: {
  sessionId: string
  tableId: string
  initialBoard: TableBoard
  perms: FloorPermissions
  partners: { id: string; name: string }[]
}) {
  const query = useTableBoard(sessionId, tableId, initialBoard)
  const refresh = useRefreshFloor(sessionId)
  const board = query.data
  const [panel, setPanel] = useState<Panel>(null)

  const operable =
    board.session.status === "OPEN" &&
    board.table.status === "OPEN" &&
    board.table.cycle !== null
  const p: FloorPermissions = {
    ...perms,
    manage: perms.manage && operable,
    buy: perms.buy && operable,
    settle: perms.settle && operable,
  }
  const all = [
    ...board.seats.flatMap((s) => (s.occupant ? [s.occupant] : [])),
    ...board.unseated,
  ]
  // Datos vigentes del servidor; si el asiento ya se liberó (p. ej. tras
  // liquidar) el panel conserva la instantánea con la que se abrió.
  const occupant =
    panel && "participationId" in panel
      ? (all.find((o) => o.participationId === panel.participationId) ??
        panel.snapshot)
      : null
  const openFor = (kind: "occupant" | SeatAction, o: Occupant) =>
    setPanel({ kind, participationId: o.participationId, snapshot: o })
  const freeSeats = board.seats
    .filter((s) => !s.occupant)
    .map((s) => s.seatNumber)
  const palette = FELT_PALETTE[board.table.feltColor]
  const close = () => setPanel(null)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs" aria-live="polite">
          {query.isFetching ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="size-3 animate-spin" aria-hidden />{" "}
              Actualizando…
            </span>
          ) : (
            `Toca un asiento libre (+) para sentar a un jugador. ${SEAT_COUNT} asientos.`
          )}
        </p>
        {perms.manage ? (
          <TableAppearanceSettings
            tableId={tableId}
            tableName={board.table.name}
            current={board.table.feltColor}
            onChanged={refresh}
          />
        ) : null}
      </div>

      <PokerTableFelt
        feltColor={board.table.feltColor}
        center={
          <>
            <span
              className="text-sm font-bold tracking-wide sm:text-lg"
              data-testid="felt-table-name"
            >
              {board.table.name}
            </span>
            <span
              className="text-xs font-medium sm:text-sm"
              data-testid="felt-table-status"
            >
              {board.table.status === "OPEN"
                ? `Abierta · ciclo ${board.table.cycle?.number ?? "—"}`
                : board.table.status === "CLOSED"
                  ? "Cerrada"
                  : "Sin abrir"}
            </span>
            <span className="text-[11px] opacity-90 sm:text-xs">
              Ciegas {formatMXN(board.table.blinds.small)} /{" "}
              {formatMXN(board.table.blinds.big)}
            </span>
          </>
        }
      >
        {board.seats.map((s) => (
          <PokerSeat
            key={s.seatNumber}
            seatNumber={s.seatNumber}
            occupant={s.occupant}
            disabled={!s.occupant && !p.manage}
            onSelect={() =>
              s.occupant
                ? openFor("occupant", s.occupant)
                : p.manage
                  ? setPanel({ kind: "free", seat: s.seatNumber })
                  : undefined
            }
          />
        ))}
        <DealerPersonCard
          dealer={board.dealer?.dealer ?? null}
          onSelect={() => setPanel({ kind: "dealer" })}
        />
      </PokerTableFelt>
      {!operable ? (
        <p
          className="rounded-xl border p-3 text-center text-sm"
          role="status"
          style={{ borderColor: palette.felt }}
        >
          {board.session.status !== "OPEN"
            ? "La sesión no está abierta: la mesa es solo de consulta."
            : "Abre la mesa para sentar jugadores y operar."}
        </p>
      ) : null}

      <TableOperationSummary
        board={board}
        onSelectUnseated={(o) => openFor("occupant", o)}
      />

      {panel?.kind === "free" ? (
        <PlayerSearchSheet
          open
          onOpenChange={(o) => !o && close()}
          sessionId={sessionId}
          tableId={tableId}
          tableName={board.table.name}
          seatNumber={panel.seat}
          canCreatePlayers={perms.createPlayers}
          onSeated={() => {
            close()
            void refresh()
          }}
        />
      ) : null}

      {occupant && panel?.kind === "occupant" ? (
        <SeatActionSheet
          open
          onOpenChange={(o) => !o && close()}
          sessionId={sessionId}
          occupant={occupant}
          perms={p}
          onAction={(a) => openFor(a, occupant)}
          onChanged={() => void refresh()}
        />
      ) : null}

      {occupant && panel?.kind === "buy" ? (
        <QuickPurchaseSheet
          open
          onOpenChange={(o) => !o && close()}
          occupant={occupant}
          tableName={board.table.name}
          canSign={perms.sign}
          partners={partners}
          onChanged={() => void refresh()}
        />
      ) : null}

      {occupant && panel?.kind === "settle" ? (
        <QuickSettlementSheet
          open
          onOpenChange={(o) => !o && close()}
          occupant={occupant}
          tableName={board.table.name}
          cashAvailable={board.cashAvailable}
          onChanged={() => void refresh()}
        />
      ) : null}

      {occupant && panel?.kind === "out" ? (
        <OutSheet
          open
          onOpenChange={(o) => !o && close()}
          occupant={occupant}
          tableName={board.table.name}
          session={{ id: board.session.id, folio: board.session.folio }}
          onChanged={() => void refresh()}
        />
      ) : null}

      {occupant && panel?.kind === "change-seat" ? (
        <SeatChangeSheet
          open
          onOpenChange={(o) => !o && close()}
          sessionId={sessionId}
          tableId={tableId}
          occupant={occupant}
          freeSeats={freeSeats}
          onChanged={() => void refresh()}
        />
      ) : null}

      {occupant && panel?.kind === "move" ? (
        <TableTransferSheet
          open
          onOpenChange={(o) => !o && close()}
          sessionId={sessionId}
          occupant={occupant}
          destinations={board.destinations}
          onChanged={() => void refresh()}
        />
      ) : null}

      {panel?.kind === "dealer" ? (
        <DealerAssignmentSheet
          open
          onOpenChange={(o) => !o && close()}
          sessionId={sessionId}
          tableId={tableId}
          tableName={board.table.name}
          current={board.dealer}
          canManage={p.manage}
          onChanged={() => void refresh()}
        />
      ) : null}

      <p className={cn("text-muted-foreground text-center text-xs")}>
        Sentar, cambiar de asiento, mover de mesa o asignar dealer no mueve
        dinero ni fichas. Compras y liquidaciones usan sus módulos.
      </p>
    </div>
  )
}
