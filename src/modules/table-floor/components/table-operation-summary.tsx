"use client"

import Link from "next/link"

import { cn } from "@/lib/utils"

import type { Occupant, TableBoard } from "./use-table-board"

/**
 * Indicadores operativos discretos (sin cifras financieras extensas: los
 * detalles aparecen al tocar a cada jugador). Las cantidades son conteos de
 * estado, nunca un resultado neto de la mesa.
 */
export function TableOperationSummary({
  board,
  onSelectUnseated,
}: {
  board: TableBoard
  onSelectUnseated: (o: Occupant) => void
}) {
  const seated = board.seats.filter((s) => s.occupant).map((s) => s.occupant!)
  const count = (state: Occupant["state"]) =>
    seated.filter((o) => o.state === state).length
  const chips = [
    { label: "Ocupados", value: `${seated.length}/9` },
    { label: "Pend. compra", value: count("PENDING_BUY") },
    { label: "Jugando", value: count("PLAYING") },
    { label: "Liquidando", value: count("SETTLING") },
  ]
  return (
    <section className="space-y-3" aria-label="Resumen de la mesa">
      <dl className="grid grid-cols-4 gap-2" data-testid="table-summary">
        {chips.map((c) => (
          <div key={c.label} className="bg-muted/50 rounded-xl p-2 text-center">
            <dt className="text-muted-foreground text-[11px] leading-tight">
              {c.label}
            </dt>
            <dd className="text-base font-semibold tabular-nums">{c.value}</dd>
          </div>
        ))}
      </dl>
      {board.unseated.length > 0 ? (
        <div className="rounded-xl border p-3" data-testid="unseated-players">
          <p className="mb-2 text-sm font-medium">Activos sin asiento</p>
          <ul className="flex flex-wrap gap-2">
            {board.unseated.map((o) => (
              <li key={o.participationId}>
                <button
                  type="button"
                  onClick={() => onSelectUnseated(o)}
                  className="hover:bg-accent min-h-11 rounded-full border px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-sky-400"
                >
                  {o.player.nickname || o.player.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {board.settlingPayout.length > 0 ? (
        <div className="rounded-xl border p-3" data-testid="settling-payout">
          <p className="mb-2 text-sm font-medium">
            Ya devolvieron fichas · falta pagarles
          </p>
          <ul className="space-y-1 text-sm">
            {board.settlingPayout.map((s) => (
              <li
                key={s.participationId}
                className="flex items-center justify-between gap-2"
              >
                <span className="truncate">
                  {s.player.nickname || s.player.name}
                </span>
                {s.settlementId ? (
                  <Link
                    href={`/dashboard/liquidaciones/${s.settlementId}/pagos`}
                    className={cn(
                      "text-primary min-h-11 content-center text-sm underline-offset-2 hover:underline"
                    )}
                  >
                    {s.settlementFolio ?? "Liquidación"} · pagar
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
